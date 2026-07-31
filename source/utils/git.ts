import { execFile } from "node:child_process";

/** Run a short git command and return trimmed stdout, or an empty string on failure. */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, cwd: process.cwd() }, (err, stdout) => {
      resolve(err ? "" : stdout.trim());
    });
  });
}

export interface GitContext {
  isRepo: boolean;
  branch: string;
  status: string;
  recentCommits: string;
  remoteUrl: string;
}

/** Gather lightweight git metadata used to ground the system prompt in current repo state. */
export async function getGitContext(): Promise<GitContext | null> {
  const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) return null;

  const [status, log, remote] = await Promise.all([
    run("git", ["status", "--short"]),
    run("git", ["log", "--oneline", "-5"]),
    run("git", ["remote", "get-url", "origin"]),
  ]);

  return {
    isRepo: true,
    branch,
    status: status || "(clean)",
    recentCommits: log,
    remoteUrl: remote,
  };
}

/** Convert git metadata into a compact prompt block suitable for the system message. */
export function formatGitPrompt(ctx: GitContext): string {
  const lines = [
    `Git branch: ${ctx.branch}`,
    `Git status:\n${ctx.status}`,
  ];
  if (ctx.recentCommits) {
    lines.push(`Recent commits:\n${ctx.recentCommits}`);
  }
  return lines.join("\n");
}
