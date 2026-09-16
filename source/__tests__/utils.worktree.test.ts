import { describe, expect, it } from "vitest";
import { runShell } from "../utils/worktree.js";

describe("utils/worktree", () => {
  it("executes commands successfully with runShell on current platform (Windows/POSIX)", async () => {
    const res = await runShell("node -e \"console.log('worktree_shell_ok')\"");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("worktree_shell_ok");
  });

  it("handles non-zero exit codes in runShell gracefully", async () => {
    const res = await runShell("node -e \"process.exit(42)\"");
    expect(res.exitCode).toBe(1);
  });

  it("handles empty stdout correctly", async () => {
    const res = await runShell("node -e \"\"");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
  });

  it("respects custom working directory if provided", async () => {
    const res = await runShell("node -e \"console.log(process.cwd())\"", process.cwd());
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBeTruthy();
  });
});
