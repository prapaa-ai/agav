import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

function run(args: string[], cwd: string, trimOutput = true): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile("git", args, { timeout: 15000, cwd, env: { ...process.env, LC_ALL: "C" } }, (err, stdout, stderr) => {
      resolve({
        stdout: trimOutput ? (stdout ?? "").trim() : (stdout ?? ""),
        stderr: (stderr ?? "").trim(),
        exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0,
      });
    });
  });
}

export interface WorkerWorktree {
  path: string;
  branchName: string;
  parentPath: string;
  baseCommit: string;
}

export interface WorktreeIntegrationResult {
  applied: boolean;
  error?: string;
  /** Cancellation is safe to discard only after any parent changes are rolled back. */
  cancelled?: boolean;
}

export async function createWorktree(name: string): Promise<WorkerWorktree | null> {
  const cwd = process.cwd();
  const root = await run(["rev-parse", "--show-toplevel"], cwd);
  if (root.exitCode !== 0) {
    if (root.stderr.includes("not a git repository")) return null;
    throw new Error(`Cannot inspect repository for an isolated worker: ${root.stderr}`);
  }
  const base = await run(["rev-parse", "HEAD"], root.stdout);
  if (base.exitCode !== 0) throw new Error(`Cannot create an isolated worker without a readable HEAD: ${base.stderr}`);

  // Tool IDs restart at sa-1 in a new session. Retained recovery trees must not
  // collide with later workers, even when the tool instance is recreated.
  const uniqueName = `${name}-${randomUUID()}`;
  const worktree: WorkerWorktree = {
    path: join(root.stdout, ".agav-worktrees", uniqueName),
    branchName: `agav-sa-${uniqueName}`,
    parentPath: root.stdout,
    baseCommit: base.stdout,
  };
  const result = await run([
    "worktree", "add", worktree.path, "-b", worktree.branchName, worktree.baseCommit,
  ], worktree.parentPath);
  if (result.exitCode !== 0) throw new Error(`Cannot create an isolated worker worktree: ${result.stderr}`);
  return worktree;
}

export async function removeWorktree(worktree: WorkerWorktree): Promise<void> {
  const removed = await run(["worktree", "remove", worktree.path, "--force"], worktree.parentPath);
  // Never remove the recovery branch if the directory could not be removed.
  if (removed.exitCode !== 0) throw new Error(removed.stderr || "Failed to remove worker worktree");
  const deleted = await run(["branch", "-D", worktree.branchName], worktree.parentPath);
  if (deleted.exitCode !== 0) throw new Error(deleted.stderr || "Failed to remove worker branch");
}

export async function diffWorktree(worktreePath: string): Promise<string> {
  const { stdout } = await run(["diff", "HEAD"], worktreePath);
  return stdout;
}

const GIT_OPERATIONS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer", "rebase-merge", "rebase-apply"];

async function hasGitState(parentPath: string, name: string): Promise<boolean> {
  const result = await run(["rev-parse", "--git-path", name], parentPath);
  if (result.exitCode !== 0) throw new Error(result.stderr || "Cannot inspect parent Git state");
  return existsSync(resolve(parentPath, result.stdout));
}

/**
 * Deliver the complete branch using one normal, non-fast-forward merge. This
 * preserves worker commits and records their ancestry, so retrying is a no-op.
 * Both histories must still descend from the recorded creation commit. Dirty
 * parent indexes/worktrees and in-progress Git operations are left untouched.
 * The old patch fallback is deliberately absent: a conflict is recoverable work,
 * not permission to try a second mutation against the user's checkout.
 */
export async function applyWorktreeChanges(
  worktree: WorkerWorktree,
  signal?: AbortSignal,
): Promise<WorktreeIntegrationResult> {
  const { path, branchName, parentPath, baseCommit } = worktree;
  const cancelled = (): WorktreeIntegrationResult => ({ applied: false, cancelled: true });
  const failure = (message: string, detail = "", parentNeedsInspection = false): WorktreeIntegrationResult => ({
    applied: false,
    error: `${parentNeedsInspection ? "Parent changes need inspection." : "Worker changes were not integrated."} ${message}${detail ? `: ${detail}` : ""}`,
  });
  if (signal?.aborted) return cancelled();

  const branch = await run(["symbolic-ref", "--short", "HEAD"], path);
  if (branch.exitCode !== 0 || branch.stdout !== branchName) {
    return failure("Worker switched branches; automatic integration was stopped");
  }
  for (const cwd of [path, parentPath]) {
    const ancestor = await run(["merge-base", "--is-ancestor", baseCommit, "HEAD"], cwd);
    if (ancestor.exitCode !== 0) return failure("History no longer descends from the worker's creation commit");
  }

  for (const state of GIT_OPERATIONS) {
    if (await hasGitState(path, state)) return failure("Worker has an unfinished Git operation");
  }

  // Stage tracked edits and non-ignored new files before deciding there is no work.
  const staged = await run(["add", "-A"], path);
  if (staged.exitCode !== 0) return failure("Failed to stage worker changes", staged.stderr);
  const diff = await run(["diff", "--cached", "--quiet"], path);
  if (diff.exitCode > 1) return failure("Failed to inspect worker changes", diff.stderr);
  if (diff.exitCode === 1) {
    const committed = await run(["commit", "-m", `agav: subagent work from ${branchName}`], path);
    if (committed.exitCode !== 0) return failure("Failed to commit worker changes", committed.stderr || committed.stdout);
  }
  if (signal?.aborted) return cancelled();
  const remaining = await run(["status", "--porcelain", "--untracked-files=normal"], path);
  if (remaining.exitCode !== 0 || remaining.stdout) {
    return failure("Worker still has uncommitted changes or cannot be inspected after committing");
  }

  const tip = await run(["rev-parse", "HEAD"], path);
  if (tip.exitCode !== 0) return failure("Failed to read worker commit", tip.stderr);
  const integrated = await run(["merge-base", "--is-ancestor", tip.stdout, "HEAD"], parentPath);
  if (integrated.exitCode === 0) return { applied: true };
  if (integrated.exitCode !== 1) return failure("Failed to inspect parent history", integrated.stderr);

  for (const state of GIT_OPERATIONS) {
    if (await hasGitState(parentPath, state)) return failure("Parent has an unfinished Git operation");
  }
  for (const args of [["diff", "--quiet"], ["diff", "--cached", "--quiet"]]) {
    const clean = await run(args, parentPath);
    if (clean.exitCode !== 0) return failure("Parent has uncommitted changes or cannot be inspected; commit or stash them before integrating");
  }
  const parentHead = await run(["rev-parse", "HEAD"], parentPath);
  if (parentHead.exitCode !== 0) return failure("Failed to read parent commit", parentHead.stderr);
  const parentBranch = await run(["symbolic-ref", "--quiet", "HEAD"], parentPath);
  if (parentBranch.exitCode !== 0 && parentBranch.exitCode !== 1) {
    return failure("Failed to inspect parent branch", parentBranch.stderr);
  }
  // merge reads branch.<name>.mergeOptions but merge-tree does not. Override it
  // for these commands only, so configured -X options cannot change destinations
  // after collision checks. A detached HEAD has no branch options to neutralize.
  const mergeConfig = parentBranch.exitCode === 0
    ? ["-c", `branch.${parentBranch.stdout.replace(/^refs\/heads\//, "")}.mergeOptions=`]
    : [];
  // Preview with the same ort strategy used below, without changing the parent
  // index or worktree. A direct tip-to-tip diff misses rename-derived destinations.
  // Conflicts are rejected here: even merge --abort can delete ignored local files.
  const preview = await run([
    ...mergeConfig, "merge-tree", "--write-tree", "--no-messages", parentHead.stdout, tip.stdout,
  ], parentPath);
  if (preview.exitCode === 1) return failure("Worker branch conflicts with the parent");
  if (preview.exitCode !== 0) return failure("Cannot preview worker merge; Git with merge-tree --write-tree support is required", preview.stderr);
  const added = await run([
    "diff", "--no-renames", "--name-only", "--diff-filter=A", "-z", parentHead.stdout, preview.stdout, "--",
  ], parentPath, false);
  if (added.exitCode !== 0) return failure("Failed to inspect incoming paths", added.stderr);
  const addedPaths = added.stdout.split("\0").filter(Boolean);
  if (addedPaths.length > 0) {
    const prefixes = (file: string): string[] => {
      const parts = file.split("/");
      return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    };
    const identities = new Map<string, string | undefined>();
    const identity = (file: string): string | undefined => {
      if (!identities.has(file)) {
        let value: string | undefined;
        try {
          const stat = lstatSync(join(parentPath, file), { bigint: true });
          value = `${stat.dev}:${stat.ino}`;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
        }
        identities.set(file, value);
      }
      return identities.get(file);
    };
    const samePath = (a: string, b: string): boolean =>
      a === b || (identity(a) !== undefined && identity(a) === identity(b));
    // Resolve top-level scopes through the filesystem, not Git's ASCII-only
    // case folding. Listing their descendants also covers aliases deeper in a
    // directory, without scanning unrelated ignored trees such as node_modules.
    const scopes = new Set(addedPaths.map((file) => file.split("/")[0]));
    const rootIdentities = new Set([...scopes].map(identity).filter((value) => value !== undefined));
    for (const entry of readdirSync(parentPath)) {
      const value = identity(entry);
      if (value !== undefined && rootIdentities.has(value)) scopes.add(entry);
    }
    const local = await run([
      "--literal-pathspecs", "ls-files", "--others", "-z", "--", ...scopes,
    ], parentPath, false);
    if (local.exitCode !== 0) return failure("Failed to inspect parent untracked files", local.stderr);
    const collision = local.stdout.split("\0").filter(Boolean).find((file) =>
      addedPaths.some((addedPath) =>
        prefixes(addedPath).some((ancestor) => samePath(file, ancestor)) ||
        prefixes(file).some((ancestor) => samePath(addedPath, ancestor)),
      ),
    );
    if (collision) return failure("Integration would overwrite a parent untracked or ignored file", collision);
  }
  if (signal?.aborted) return cancelled();

  const merged = await run([
    ...mergeConfig, "merge", "--strategy=ort", "--no-ff", "--no-edit", "--no-stat", "--no-autostash", "--no-overwrite-ignore", tip.stdout,
  ], parentPath);
  if (merged.exitCode !== 0) {
    if (await hasGitState(parentPath, "MERGE_HEAD")) {
      const aborted = await run(["merge", "--abort"], parentPath);
      if (aborted.exitCode !== 0) return failure("Git could not abort the failed merge", aborted.stderr, true);
    }
    const head = await run(["rev-parse", "HEAD"], parentPath);
    const unstaged = await run(["diff", "--quiet"], parentPath);
    const staged = await run(["diff", "--cached", "--quiet"], parentPath);
    if (head.exitCode !== 0 || head.stdout !== parentHead.stdout || unstaged.exitCode !== 0 || staged.exitCode !== 0) {
      return failure("Git did not restore the parent after the failed merge", merged.stderr || merged.stdout, true);
    }
    if (signal?.aborted) return cancelled();
    return failure("Git merge failed", merged.stderr || merged.stdout);
  }
  // A cancellation received while Git was merging must not leave worker output
  // in the parent. --merge restores our initially clean tracked files/index while
  // preserving unrelated untracked files. Do not discard work if rollback fails.
  if (signal?.aborted) {
    // Refuse to roll back a different commit if another writer advanced HEAD.
    // Full coordination between concurrent writers remains a separate concern.
    const current = await run(["rev-list", "--parents", "-n", "1", "HEAD"], parentPath);
    if (current.exitCode !== 0 || current.stdout.split(" ").slice(1).join(" ") !== `${parentHead.stdout} ${tip.stdout}`) {
      return failure("Parent history changed during integration; cancellation could not be rolled back safely", current.stderr, true);
    }
    const rollback = await run(["reset", "--merge", parentHead.stdout], parentPath);
    if (rollback.exitCode !== 0) return failure("Cancelled integration could not be rolled back", rollback.stderr, true);
    return cancelled();
  }
  return { applied: true };
}
