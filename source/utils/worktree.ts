import { execFile } from "node:child_process";
import { join } from "node:path";

function run(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile("git", args, { timeout: 15000, cwd }, (err, stdout, stderr) => {
      resolve({ stdout: (stdout ?? "").trim(), stderr: (stderr ?? "").trim(), exitCode: err ? 1 : 0 });
    });
  });
}

function runShell(command: string, cwd?: string): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", command], { timeout: 15000, cwd }, (err, stdout) => {
      resolve({ stdout: (stdout ?? "").trim(), exitCode: err ? 1 : 0 });
    });
  });
}

async function isGitRepo(): Promise<boolean> {
  const { exitCode } = await run(["rev-parse", "--is-inside-work-tree"]);
  return exitCode === 0;
}

export async function createWorktree(name: string): Promise<string | null> {
  if (!(await isGitRepo())) return null;

  const worktreePath = join(process.cwd(), ".agav-worktrees", name);
  const branchName = `agav-sa-${name}`;

  const { exitCode } = await run([
    "worktree", "add", worktreePath, "-b", branchName, "HEAD",
  ]);

  return exitCode === 0 ? worktreePath : null;
}

export async function removeWorktree(path: string, branchName: string): Promise<void> {
  await run(["worktree", "remove", path, "--force"]);
  await run(["branch", "-D", branchName]);
}

export async function diffWorktree(worktreePath: string): Promise<string> {
  const { stdout } = await run(["diff", "HEAD"], worktreePath);
  return stdout;
}

export async function applyWorktreeChanges(worktreePath: string): Promise<{ applied: boolean; error?: string }> {
  const { stdout: diffOutput } = await run(["diff", "HEAD"], worktreePath);

  if (!diffOutput) {
    return { applied: true };
  }

  const { stdout: branchName } = await run(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath);

  await run(["add", "-A"], worktreePath);
  const { exitCode: commitExit } = await run(
    ["commit", "-m", `agav: subagent work from ${branchName}`],
    worktreePath,
  );

  if (commitExit !== 0) {
    return { applied: false, error: "Failed to commit subagent changes" };
  }

  const mainCwd = process.cwd();

  const { exitCode: cherryExit } = await run(
    ["cherry-pick", branchName],
    mainCwd,
  );

  if (cherryExit === 0) {
    return { applied: true };
  }

  await run(["cherry-pick", "--abort"], mainCwd);

  const { exitCode: patchExit } = await runShell(
    `git diff ${branchName}~1..${branchName} | git apply --3way`,
    mainCwd,
  );

  if (patchExit === 0) {
    await run(["add", "-A"], mainCwd);
    await run(["commit", "-m", `agav: subagent work from ${branchName} (patch)`], mainCwd);
    return { applied: true };
  }

  return { applied: false, error: "Merge conflict — subagent changes could not be applied automatically" };
}
