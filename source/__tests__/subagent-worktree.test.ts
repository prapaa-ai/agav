import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent/loop.js", () => ({ runAgentLoop: vi.fn() }));

import { runAgentLoop } from "../agent/loop.js";
import { createSubagentTool, type SubagentToolDeps } from "../tools/subagent.js";
import { ToolRegistry } from "../tools/registry.js";
import * as worktrees from "../utils/worktree.js";
import type { WorkerWorktree } from "../utils/worktree.js";

const originalCwd = process.cwd();
let repo: string;
let hooks: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(cwd: string, file: string, text = "worker sentinel\n"): void {
  const path = join(cwd, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function commit(cwd: string, message = "worker commit"): string {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

async function worker(name = "test"): Promise<WorkerWorktree> {
  const result = await worktrees.createWorktree(name);
  expect(result).not.toBeNull();
  return result!;
}

function hook(name: string, script: string): void {
  writeFileSync(join(hooks, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

function expectParentClean(head?: string): void {
  if (head) expect(git(repo, "rev-parse", "HEAD")).toBe(head);
  expect(git(repo, "diff", "--name-only")).toBe("");
  expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
  expect(git(repo, "ls-files", "-u")).toBe("");
  for (const state of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "sequencer"]) {
    expect(existsSync(resolve(repo, git(repo, "rev-parse", "--git-path", state)))).toBe(false);
  }
}

beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  repo = mkdtempSync(join(tmpdir(), "agav-worker-"));
  git(repo, "init", "-b", "parent");
  git(repo, "config", "user.name", "Worktree Test");
  git(repo, "config", "user.email", "worktree@example.test");
  hooks = join(repo, ".git", "test-hooks");
  mkdirSync(hooks);
  git(repo, "config", "core.hooksPath", hooks);
  write(repo, ".gitignore", ".agav-worktrees/\nignored.txt\n");
  write(repo, "existing.txt", "base\n");
  commit(repo, "base");
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(repo, { recursive: true, force: true });
});

describe("worker Git integration", () => {
  it("captures the creation commit and repository root when started in a subdirectory", async () => {
    mkdirSync(join(repo, "nested"));
    process.chdir(join(repo, "nested"));
    const tree = await worker();
    expect(tree.parentPath).toBe(git(repo, "rev-parse", "--show-toplevel"));
    expect(tree.baseCommit).toBe(git(repo, "rev-parse", "HEAD"));
    expect(dirname(tree.path)).toBe(join(tree.parentPath, ".agav-worktrees"));
    expect(tree.branchName).toMatch(/^agav-sa-test-[0-9a-f-]{36}$/);
  });

  it.each(["clean", "ignored-only"])("treats a %s worker as a no-op", async (kind) => {
    const tree = await worker();
    if (kind === "ignored-only") write(tree.path, "ignored.txt");
    expect(await worktrees.applyWorktreeChanges(tree)).toEqual({ applied: true });
    expectParentClean(tree.baseCommit);
    expect(existsSync(join(repo, "ignored.txt"))).toBe(false);
  });

  it("delivers non-ignored untracked files, including nested paths with spaces", async () => {
    const tree = await worker();
    write(tree.path, "nested/new file.txt");
    write(tree.path, "ignored.txt");
    expect(await worktrees.applyWorktreeChanges(tree)).toEqual({ applied: true });
    expect(readFileSync(join(repo, "nested/new file.txt"), "utf8")).toBe("worker sentinel\n");
    expect(existsSync(join(repo, "ignored.txt"))).toBe(false);
    expectParentClean();
  });

  it.each(["tracked", "staged", "mixed"])("delivers %s changes", async (kind) => {
    const tree = await worker();
    write(tree.path, "existing.txt", "edited\n");
    if (kind !== "tracked") git(tree.path, "add", "existing.txt");
    if (kind === "mixed") {
      write(tree.path, "existing.txt", "edited after staging\n");
      write(tree.path, "new.txt");
    }
    expect(await worktrees.applyWorktreeChanges(tree)).toEqual({ applied: true });
    expect(readFileSync(join(repo, "existing.txt"), "utf8")).toBe(kind === "mixed" ? "edited after staging\n" : "edited\n");
    if (kind === "mixed") expect(existsSync(join(repo, "new.txt"))).toBe(true);
    expectParentClean();
  });

  it.each([1, 3])("delivers all %i worker commits exactly once", async (count) => {
    const tree = await worker();
    const commits: string[] = [];
    for (let i = 0; i < count; i++) {
      write(tree.path, `commit-${i}.txt`);
      commits.push(commit(tree.path, `worker ${i}`));
    }
    expect(await worktrees.applyWorktreeChanges(tree)).toEqual({ applied: true });
    const head = git(repo, "rev-parse", "HEAD");
    for (const sha of commits) {
      expect(git(repo, "merge-base", "--is-ancestor", sha, "HEAD")).toBe("");
      expect(git(repo, "rev-list", "HEAD").split("\n").filter((line) => line === sha)).toHaveLength(1);
    }
    for (let i = 0; i < count; i++) expect(existsSync(join(repo, `commit-${i}.txt`))).toBe(true);
    expect(await worktrees.applyWorktreeChanges(tree)).toEqual({ applied: true });
    expectParentClean(head);
  });

  it("combines committed and unfinished worker output with parent advancement", async () => {
    const tree = await worker();
    write(tree.path, "committed.txt");
    const first = commit(tree.path);
    write(tree.path, "existing.txt", "unfinished\n");
    write(tree.path, "untracked.txt");
    write(repo, "parent.txt", "parent sentinel\n");
    const parent = commit(repo, "parent advancement");
    write(repo, "unrelated.txt", "leave untracked\n");
    expect(await worktrees.applyWorktreeChanges(tree)).toEqual({ applied: true });
    for (const sha of [first, parent]) expect(git(repo, "merge-base", "--is-ancestor", sha, "HEAD")).toBe("");
    expect(readFileSync(join(repo, "parent.txt"), "utf8")).toBe("parent sentinel\n");
    expect(readFileSync(join(repo, "unrelated.txt"), "utf8")).toBe("leave untracked\n");
    expect(readFileSync(join(repo, "existing.txt"), "utf8")).toBe("unfinished\n");
    expect(existsSync(join(repo, "committed.txt"))).toBe(true);
    expect(existsSync(join(repo, "untracked.txt"))).toBe(true);
    expectParentClean();
  });

  it("rejects a conflicting merge before leaving partial files or conflict state", async () => {
    const tree = await worker();
    write(tree.path, "existing.txt", "worker\n");
    write(tree.path, "sentinel.txt");
    write(repo, "existing.txt", "parent\n");
    const head = commit(repo, "parent change");
    const result = await worktrees.applyWorktreeChanges(tree);
    expect(result.applied).toBe(false);
    expect(result.error).toContain("not integrated");
    expectParentClean(head);
    expect(existsSync(join(repo, "sentinel.txt"))).toBe(false);
    expect(readFileSync(join(repo, "existing.txt"), "utf8")).toBe("parent\n");
    expect(git(repo, "show", `${tree.branchName}:sentinel.txt`)).toBe("worker sentinel");
  });

  it.each(["unstaged", "staged", "staged-and-reverted"])("preserves %s parent edits and index", async (kind) => {
    const tree = await worker();
    write(tree.path, "new.txt");
    write(repo, "existing.txt", "parent edit\n");
    if (kind !== "unstaged") git(repo, "add", "existing.txt");
    if (kind === "staged-and-reverted") write(repo, "existing.txt", "base\n");
    const before = [git(repo, "diff"), git(repo, "diff", "--cached")];
    const result = await worktrees.applyWorktreeChanges(tree);
    expect(result.applied).toBe(false);
    expect(result.error).toContain("uncommitted changes");
    expect([git(repo, "diff"), git(repo, "diff", "--cached")]).toEqual(before);
    expect(git(repo, "rev-parse", "HEAD")).toBe(tree.baseCommit);
    expect(existsSync(join(repo, "new.txt"))).toBe(false);
  });

  it.each(["new.txt", "ignored.txt"])("refuses to overwrite the parent's untracked %s", async (file) => {
    const tree = await worker();
    write(tree.path, file);
    git(tree.path, "add", "-f", file);
    commit(tree.path);
    write(repo, file, "parent untracked\n");
    expect((await worktrees.applyWorktreeChanges(tree)).applied).toBe(false);
    expect(readFileSync(join(repo, file), "utf8")).toBe("parent untracked\n");
    expectParentClean(tree.baseCommit);
  });

  it.each(["file-to-directory", "directory-to-file"])("protects ignored parent paths from %s collisions", async (kind) => {
    write(repo, ".gitignore", ".agav-worktrees/\nignored\n");
    commit(repo, "ignore local output");
    const tree = await worker();
    const incoming = kind === "file-to-directory" ? "ignored/nested.txt" : "ignored";
    const local = kind === "file-to-directory" ? "ignored" : "ignored/nested.txt";
    write(tree.path, incoming);
    git(tree.path, "add", "-f", incoming);
    commit(tree.path);
    write(repo, local, "local output\n");
    const result = await worktrees.applyWorktreeChanges(tree);
    expect(result.applied).toBe(false);
    expect(readFileSync(join(repo, local), "utf8")).toBe("local output\n");
    expectParentClean(tree.baseCommit);
  });

  it("preserves incoming filenames containing whitespace and pathspec characters", async () => {
    const tree = await worker();
    const filename = " [literal]\nfile.txt ";
    write(tree.path, filename);
    expect(await worktrees.applyWorktreeChanges(tree)).toEqual({ applied: true });
    expect(readFileSync(join(repo, filename), "utf8")).toBe("worker sentinel\n");
    expectParentClean();
  });

  it("does not turn an unfinished worker merge into a completed commit", async () => {
    const tree = await worker();
    write(repo, "parent.txt");
    commit(repo, "parent addition");
    git(tree.path, "merge", "--no-ff", "--no-commit", "parent");
    const staged = git(tree.path, "diff", "--cached");
    const mergeHead = git(tree.path, "rev-parse", "MERGE_HEAD");
    const result = await worktrees.applyWorktreeChanges(tree);
    expect(result.applied).toBe(false);
    expect(result.error).toContain("Worker has an unfinished Git operation");
    expect(git(tree.path, "diff", "--cached")).toBe(staged);
    expect(git(tree.path, "rev-parse", "MERGE_HEAD")).toBe(mergeHead);
    expectParentClean();
  });

  it("retains edits left unstaged by a worker commit hook", async () => {
    const tree = await worker();
    write(tree.path, "new.txt");
    hook("pre-commit", 'printf "hook edit\\n" > existing.txt');
    const result = await worktrees.applyWorktreeChanges(tree);
    expect(result.applied).toBe(false);
    expect(result.error).toContain("still has uncommitted changes");
    expect(readFileSync(join(tree.path, "existing.txt"), "utf8")).toBe("hook edit\n");
    expectParentClean(tree.baseCommit);
  });

  it.each(["default", "true"])("protects local output at a directory-rename destination (%s)", async (setting) => {
    write(repo, ".gitignore", ".agav-worktrees/\n*.local\n");
    write(repo, "old/tracked.txt", "rename anchor\n");
    commit(repo, "rename base");
    const tree = await worker();
    git(repo, "mv", "old", "new");
    const parent = commit(repo, "parent directory rename");
    write(repo, "new/output.local", "parent-only sentinel\n");
    write(tree.path, "old/output.local", "worker output\n");
    git(tree.path, "add", "-f", "old/output.local");
    commit(tree.path);
    if (setting !== "default") git(repo, "config", "merge.directoryRenames", setting);
    const result = await worktrees.applyWorktreeChanges(tree);
    expect(readFileSync(join(repo, "new/output.local"), "utf8")).toBe("parent-only sentinel\n");
    expect(result.applied).toBe(false);
    expectParentClean(parent);
    expect(git(repo, "show", `${tree.branchName}:old/output.local`)).toBe("worker output");
  });

  it.each(["parent", "feature/nested.branch"])("keeps preview and execution consistent with %s merge options", async (branch) => {
    if (branch !== "parent") git(repo, "branch", "-m", branch);
    write(repo, ".gitignore", ".agav-worktrees/\n*.local\n");
    write(repo, "old/tracked.txt", "rename anchor\n");
    commit(repo, "rename base");
    const tree = await worker();
    git(repo, "mv", "old", "new");
    commit(repo, "parent directory rename");
    write(repo, "old/output.local", "parent-only sentinel\n");
    write(tree.path, "old/output.local", "worker output\n");
    git(tree.path, "add", "-f", "old/output.local");
    commit(tree.path);
    git(repo, "config", "merge.directoryRenames", "true");
    const optionsKey = `branch.${branch}.mergeOptions`;
    git(repo, "config", optionsKey, "-Xno-renames");

    const result = await worktrees.applyWorktreeChanges(tree);
    expect(readFileSync(join(repo, "old/output.local"), "utf8")).toBe("parent-only sentinel\n");
    expect(result).toEqual({ applied: true });
    expect(readFileSync(join(repo, "new/output.local"), "utf8")).toBe("worker output\n");
    expect(git(repo, "config", "--get", optionsKey)).toBe("-Xno-renames");
    expectParentClean();
  });

  it("integrates into a detached parent without branch-specific options", async () => {
    const tree = await worker();
    write(tree.path, "new.txt");
    git(repo, "config", "branch.parent.mergeOptions", "--squash");
    git(repo, "checkout", "--detach");
    expect(await worktrees.applyWorktreeChanges(tree)).toEqual({ applied: true });
    expect(readFileSync(join(repo, "new.txt"), "utf8")).toBe("worker sentinel\n");
    expect(git(repo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    expectParentClean();
  });

  it.for([
    ["output.local", "OUTPUT.LOCAL"],
    ["outpút.local", "OUTPÚT.LOCAL"],
    ["fólder/output.local", "FÓLDER/OUTPUT.LOCAL"],
    ["folder/output.local", "FOLDER/OUTPUT.LOCAL"],
    ["folder", "FOLDER/output.local"],
    ["folder/output.local", "FOLDER"],
  ])("protects case-equivalent local paths: %s vs %s", async ([local, incoming], context) => {
    write(repo, "case-probe", "probe");
    const insensitive = existsSync(join(repo, "CASE-PROBE"));
    rmSync(join(repo, "case-probe"));
    if (!insensitive) context.skip();
    write(repo, ".gitignore", ".agav-worktrees/\n*.local\nfolder\nFOLDER\n");
    commit(repo, "ignore local output");
    const tree = await worker();
    write(tree.path, incoming, "worker output\n");
    git(tree.path, "add", "-f", incoming);
    commit(tree.path);
    write(repo, local, "parent-only sentinel\n");
    const result = await worktrees.applyWorktreeChanges(tree);
    expect(readFileSync(join(repo, local), "utf8")).toBe("parent-only sentinel\n");
    expect(result.applied).toBe(false);
    expectParentClean(tree.baseCommit);
  });

  it("allows distinct case-only paths on a case-sensitive filesystem", async (context) => {
    write(repo, "case-probe", "probe");
    const insensitive = existsSync(join(repo, "CASE-PROBE"));
    rmSync(join(repo, "case-probe"));
    if (insensitive) context.skip();
    write(repo, ".gitignore", ".agav-worktrees/\noutput.local\n");
    commit(repo, "ignore local output");
    const tree = await worker();
    write(tree.path, "OUTPUT.LOCAL", "worker output\n");
    commit(tree.path);
    write(repo, "output.local", "parent-only sentinel\n");
    expect(await worktrees.applyWorktreeChanges(tree)).toEqual({ applied: true });
    expect(readFileSync(join(repo, "output.local"), "utf8")).toBe("parent-only sentinel\n");
    expect(readFileSync(join(repo, "OUTPUT.LOCAL"), "utf8")).toBe("worker output\n");
    expectParentClean();
  });

  it("distinguishes a non-Git directory from a repository without a readable HEAD", async () => {
    const empty = mkdtempSync(join(tmpdir(), "agav-not-git-"));
    try {
      process.chdir(empty);
      expect(await worktrees.createWorktree("test")).toBeNull();
      git(empty, "init", "-b", "parent");
      await expect(worktrees.createWorktree("test")).rejects.toThrow("without a readable HEAD");
    } finally {
      process.chdir(repo);
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("allocates different worktrees when a later session reuses the same worker ID", async () => {
    const retained = await worker("sa-1");
    write(retained.path, "retained.txt");
    const next = await worker("sa-1");
    expect(next.path).not.toBe(retained.path);
    expect(next.branchName).not.toBe(retained.branchName);
    expect(readFileSync(join(retained.path, "retained.txt"), "utf8")).toBe("worker sentinel\n");
  });

  it("leaves an existing parent merge alone", async () => {
    const tree = await worker();
    write(tree.path, "new.txt");
    commit(tree.path);
    git(repo, "merge", "--no-ff", "--no-commit", tree.branchName);
    const mergeHead = git(repo, "rev-parse", "MERGE_HEAD");
    const staged = git(repo, "diff", "--cached");
    const result = await worktrees.applyWorktreeChanges(tree);
    expect(result.applied).toBe(false);
    expect(result.error).toContain("unfinished Git operation");
    expect(git(repo, "rev-parse", "MERGE_HEAD")).toBe(mergeHead);
    expect(git(repo, "diff", "--cached")).toBe(staged);
  });

  it.each(["parent", "worker"])("rejects %s history rewritten before the creation base", async (side) => {
    write(repo, "base-2.txt");
    commit(repo, "second base");
    const tree = await worker();
    git(side === "parent" ? repo : tree.path, "reset", "--hard", "HEAD~1");
    write(tree.path, "new.txt");
    const head = git(repo, "rev-parse", "HEAD");
    const result = await worktrees.applyWorktreeChanges(tree);
    expect(result.applied).toBe(false);
    expect(result.error).toContain("creation commit");
    expectParentClean(head);
    expect(existsSync(join(tree.path, "new.txt"))).toBe(true);
  });

  it("reports staging failure without deleting worker output", async () => {
    const tree = await worker();
    write(tree.path, "new.txt");
    writeFileSync(git(tree.path, "rev-parse", "--git-path", "index.lock"), "locked");
    const result = await worktrees.applyWorktreeChanges(tree);
    expect(result.applied).toBe(false);
    expect(result.error).toContain("stage worker");
    expectParentClean(tree.baseCommit);
    expect(existsSync(join(tree.path, "new.txt"))).toBe(true);
  });

  it("reports a failed worker commit without deleting the staged output", async () => {
    const tree = await worker();
    write(tree.path, "new.txt");
    hook("pre-commit", "exit 1");
    const result = await worktrees.applyWorktreeChanges(tree);
    expect(result.applied).toBe(false);
    expect(result.error).toContain("commit worker");
    expect(git(tree.path, "show", ":new.txt")).toBe("worker sentinel");
    expectParentClean(tree.baseCommit);
  });

  it("aborts when the final integration commit fails", async () => {
    const tree = await worker();
    write(tree.path, "new.txt");
    commit(tree.path);
    hook("prepare-commit-msg", 'if [ "$2" = merge ]; then exit 1; fi');
    expect((await worktrees.applyWorktreeChanges(tree)).applied).toBe(false);
    expectParentClean(tree.baseCommit);
    expect(existsSync(join(repo, "new.txt"))).toBe(false);
    expect(git(repo, "show", `${tree.branchName}:new.txt`)).toBe("worker sentinel");
  });

  it("reports an abort failure and keeps the recovery branch", async () => {
    const tree = await worker();
    write(tree.path, "new.txt");
    commit(tree.path);
    hook("prepare-commit-msg", 'if [ "$2" = merge ]; then touch "$(git rev-parse --git-path index.lock)"; exit 1; fi');
    const result = await worktrees.applyWorktreeChanges(tree);
    expect(result.applied).toBe(false);
    expect(result.error).toContain("Parent changes need inspection");
    expect(result.error).toContain("could not abort");
    expect(git(repo, "show", `${tree.branchName}:new.txt`)).toBe("worker sentinel");
    expect(existsSync(tree.path)).toBe(true);
  });

  it("retains recovery work if cancellation rollback fails", async () => {
    const tree = await worker();
    write(tree.path, "new.txt");
    commit(tree.path);
    const marker = join(hooks, "merged");
    hook("post-merge", `touch "$(git rev-parse --git-path index.lock)"; touch '${marker}'; sleep 0.3`);
    const controller = new AbortController();
    const pending = worktrees.applyWorktreeChanges(tree, controller.signal);
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
    controller.abort();
    const result = await pending;
    expect(result.applied).toBe(false);
    expect(result.cancelled).not.toBe(true);
    expect(result.error).toContain("Parent changes need inspection");
    expect(result.error).toContain("could not be rolled back");
    expect(existsSync(join(repo, "new.txt"))).toBe(true);
    expect(git(repo, "show", `${tree.branchName}:new.txt`)).toBe("worker sentinel");
    expect(existsSync(tree.path)).toBe(true);
  });

  it("skips delivery when already cancelled, including committed output", async () => {
    const tree = await worker();
    write(tree.path, "committed.txt");
    commit(tree.path);
    write(tree.path, "untracked.txt");
    const controller = new AbortController();
    controller.abort();
    expect(await worktrees.applyWorktreeChanges(tree, controller.signal)).toEqual({ applied: false, cancelled: true });
    expectParentClean(tree.baseCommit);
    expect(existsSync(join(repo, "committed.txt"))).toBe(false);
  });

  it("rolls back the complete merge when cancelled during integration", async () => {
    const tree = await worker();
    write(tree.path, "committed.txt");
    commit(tree.path);
    write(repo, "unrelated.txt", "keep\n");
    const marker = join(hooks, "merging");
    hook("prepare-commit-msg", `if [ "$2" = merge ]; then touch '${marker}'; sleep 0.3; fi`);
    const controller = new AbortController();
    const pending = worktrees.applyWorktreeChanges(tree, controller.signal);
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
    controller.abort();
    expect(await pending).toEqual({ applied: false, cancelled: true });
    expectParentClean(tree.baseCommit);
    expect(existsSync(join(repo, "committed.txt"))).toBe(false);
    expect(readFileSync(join(repo, "unrelated.txt"), "utf8")).toBe("keep\n");
  });
});

function deps(signal?: AbortSignal): SubagentToolDeps {
  return {
    provider: { name: "mock", stream: vi.fn() } as unknown as SubagentToolDeps["provider"],
    parentToolRegistry: new ToolRegistry(),
    getConfig: () => ({
      model: "test-model", systemPrompt: "Test", permissionMode: "auto-accept", effort: "medium",
      iterationsBudget: { remaining: 2, total: 2 },
    }),
    confirmationQueue: { enqueue: vi.fn(), rejectBySubagentId: vi.fn() } as unknown as SubagentToolDeps["confirmationQueue"],
    onProgressUpdate: vi.fn(), onTokenUsage: vi.fn(), getSignal: () => signal,
  };
}

function loopWith(work: () => void): void {
  vi.mocked(runAgentLoop).mockImplementation(() => (async function* () {
    work();
    yield { type: "assistant_message_complete" as const, text: "Worker finished." };
  })());
}

describe("subagent completion with real worktrees", () => {
  it("delivers new files before cleaning only its own worktree and branch", async () => {
    const other = await worker("other");
    let workerPath = "";
    let workerBranch = "";
    loopWith(() => {
      workerPath = process.cwd();
      workerBranch = git(workerPath, "symbolic-ref", "--short", "HEAD");
      write(workerPath, "nested/new file.txt");
    });
    const result = await createSubagentTool(deps()).execute({ title: "Create", task: "create a file" });
    expect(result).toEqual({ output: "Worker finished.", isError: false });
    expect(existsSync(join(repo, "nested/new file.txt"))).toBe(true);
    expect(existsSync(workerPath)).toBe(false);
    expect(git(repo, "branch", "--list", workerBranch)).toBe("");
    expect(existsSync(other.path)).toBe(true);
    expect(git(repo, "branch", "--list", other.branchName)).toContain(other.branchName);
    expectParentClean();
  });

  it.each(["conflict", "worker-commit", "integration-commit", "exception"])("retains recoverable work and reports failed delivery on %s", async (failure) => {
    const base = git(repo, "rev-parse", "HEAD");
    let parentHead = base;
    let retainedPath = "";
    let retainedBranch = "";
    loopWith(() => {
      retainedPath = process.cwd();
      retainedBranch = git(retainedPath, "symbolic-ref", "--short", "HEAD");
      write(retainedPath, "sentinel.txt");
      if (failure === "conflict") {
        write(retainedPath, "existing.txt", "worker\n");
        write(repo, "existing.txt", "parent\n");
        parentHead = commit(repo, "conflicting parent");
      }
      if (failure === "worker-commit") hook("pre-commit", "exit 1");
      if (failure === "integration-commit") hook("prepare-commit-msg", 'if [ "$2" = merge ]; then exit 1; fi');
    });
    if (failure === "exception") vi.spyOn(worktrees, "applyWorktreeChanges").mockRejectedValueOnce(new Error("integration exploded"));
    const config = deps();
    const result = await createSubagentTool(config).execute({ title: "Create", task: "create a file" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Worker finished.");
    expect(result.output).toContain("automatic integration failed");
    expect(result.output).toContain(retainedPath);
    expect(result.output).toContain(`Branch: ${retainedBranch}`);
    expect(readFileSync(join(retainedPath, "sentinel.txt"), "utf8")).toBe("worker sentinel\n");
    expect(git(repo, "branch", "--list", retainedBranch)).toContain(retainedBranch);
    if (failure === "conflict" || failure === "integration-commit") {
      expect(git(repo, "show", `${retainedBranch}:sentinel.txt`)).toBe("worker sentinel");
    }
    const updates = vi.mocked(config.onProgressUpdate).mock.calls.flatMap(([items]) => items);
    expect(updates.at(-1)?.status).toBe("error");
    expect(updates.at(-1)?.error).toContain(retainedPath);
    expect(existsSync(join(repo, "sentinel.txt"))).toBe(false);
    expectParentClean(parentHead);
  });

  it("keeps a recreated tool isolated while an earlier worker is retained", async () => {
    const base = git(repo, "rev-parse", "HEAD");
    let retainedPath = "";
    let retainedBranch = "";
    loopWith(() => {
      retainedPath = process.cwd();
      retainedBranch = git(retainedPath, "symbolic-ref", "--short", "HEAD");
      write(retainedPath, "retained.txt");
      hook("pre-commit", "exit 1");
    });
    const failed = await createSubagentTool(deps()).execute({ title: "First", task: "create a file" });
    expect(failed.isError).toBe(true);
    rmSync(join(hooks, "pre-commit"));

    const controller = new AbortController();
    let nextPath = "";
    let nextBranch = "";
    loopWith(() => {
      nextPath = process.cwd();
      nextBranch = git(nextPath, "symbolic-ref", "--short", "HEAD");
      write(nextPath, "cancelled.txt");
      controller.abort();
    });
    const cancelled = await createSubagentTool(deps(controller.signal)).execute({ title: "Next", task: "create a file" });
    expect(cancelled).toEqual({ output: "Subagent cancelled.", isError: true });
    expect(nextPath).not.toBe(retainedPath);
    expect(existsSync(nextPath)).toBe(false);
    expect(git(repo, "branch", "--list", nextBranch)).toBe("");
    expect(readFileSync(join(retainedPath, "retained.txt"), "utf8")).toBe("worker sentinel\n");
    expect(git(repo, "branch", "--list", retainedBranch)).toContain(retainedBranch);
    expect(existsSync(join(repo, "cancelled.txt"))).toBe(false);
    expectParentClean(base);
  });

  it("stops before running the worker if Git cannot create an isolated worktree", async () => {
    write(repo, ".git/worktrees", "block Git worktree metadata\n");
    const run = vi.mocked(runAgentLoop);
    run.mockClear();
    loopWith(() => write(process.cwd(), "should-not-exist.txt"));
    const result = await createSubagentTool(deps()).execute({ title: "Create", task: "create a file" });
    expect(result.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(join(repo, "should-not-exist.txt"))).toBe(false);
  });

  it("discards cancelled committed and untracked work without merging", async () => {
    const base = git(repo, "rev-parse", "HEAD");
    const controller = new AbortController();
    let workerPath = "";
    let workerBranch = "";
    loopWith(() => {
      workerPath = process.cwd();
      workerBranch = git(workerPath, "symbolic-ref", "--short", "HEAD");
      write(process.cwd(), "committed.txt");
      commit(process.cwd());
      write(process.cwd(), "untracked.txt");
      controller.abort();
    });
    const result = await createSubagentTool(deps(controller.signal)).execute({ title: "Create", task: "create a file" });
    expect(result).toEqual({ output: "Subagent cancelled.", isError: true });
    expectParentClean(base);
    expect(existsSync(join(repo, "committed.txt"))).toBe(false);
    expect(existsSync(join(repo, "untracked.txt"))).toBe(false);
    expect(existsSync(workerPath)).toBe(false);
    expect(git(repo, "branch", "--list", workerBranch)).toBe("");
  });
});
