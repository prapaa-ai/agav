import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { formatGitPrompt, getGitContext } from "../utils/git.js";

describe("utils/git", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when git branch lookup fails", async () => {
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === "function") cb(new Error("git failed"), "", "");
      return undefined as any;
    });
    await expect(getGitContext()).resolves.toBeNull();
  });

  it("formats git prompt with status and commits", () => {
    const prompt = formatGitPrompt({
      isRepo: true,
      branch: "main",
      status: "M source/app.tsx",
      recentCommits: "a1b2c3 fix bug\nd4e5f6 add tests",
      remoteUrl: "git@github.com:org/repo.git",
    });

    expect(prompt).toContain("main");
    expect(prompt).toContain("M source/app.tsx");
    expect(prompt).toContain("a1b2c3 fix bug");
  });
});
