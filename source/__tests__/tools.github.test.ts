import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { githubTool } from "../tools/github.js";

const ghCalls = () => vi.mocked(execFile).mock.calls.map((call) => call[1] as string[]);

describe("tools/github comments", () => {
  beforeEach(() => {
    vi.mocked(execFile).mockReset();
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      const ghArgs = args[1] as string[];
      cb(null, ghArgs[0] === "auth" ? "" : "https://github.com/o/r/issues/7#issuecomment-1\n", "");
      return undefined as any;
    });
  });

  it.each([
    ["comment_issue", "issue"],
    ["comment_pr", "pr"],
  ])("%s passes a multiline body that starts with a hyphen through unchanged", async (operation, kind) => {
    const body = "- first point\n--second\n\nthanks";

    const result = await githubTool.execute({ operation, number: 7, body });

    expect(result).toEqual({ output: "https://github.com/o/r/issues/7#issuecomment-1\n", isError: false });
    expect(ghCalls()).toEqual([["auth", "status"], [kind, "comment", "7", "--body", body]]);
  });

  it.each([0, -3, 1.5, "12", undefined])("rejects number %s before running a comment", async (number) => {
    const result = await githubTool.execute({ operation: "comment_issue", number, body: "hi" });

    expect(result.isError).toBe(true);
    expect(result.output).toBe("A positive integer issue or PR number is required.");
    expect(ghCalls()).toEqual([["auth", "status"]]);
  });

  it("rejects an empty comment body", async () => {
    const result = await githubTool.execute({ operation: "comment_pr", number: 7, body: "  \n" });

    expect(result).toEqual({ output: "Comment body is required.", isError: true });
    expect(ghCalls()).toEqual([["auth", "status"]]);
  });

  it("reports a failed comment as an error", async () => {
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      const ghArgs = args[1] as string[];
      if (ghArgs[0] === "auth") cb(null, "", "");
      else cb(Object.assign(new Error("gh failed"), { code: 1 }), "", "GraphQL: Could not resolve to an issue\n");
      return undefined as any;
    });

    const result = await githubTool.execute({ operation: "comment_issue", number: 99999, body: "hi" });

    expect(result).toEqual({ output: "GraphQL: Could not resolve to an issue\n", isError: true });
  });
});
