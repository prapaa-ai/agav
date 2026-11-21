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

describe("GitHub explicit repository", () => {
  beforeEach(() => {
    vi.mocked(execFile).mockReset();
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: null, stdout: string, stderr: string) => void)(null, "ok", "");
      return {} as ReturnType<typeof execFile>;
    });
  });

  it.each([
    ["view_pr", ["pr", "view", "7"]],
    ["list_prs", ["pr", "list"]],
    ["create_pr", ["pr", "create", "--title", "Title", "--body", "Body"]],
    ["view_issue", ["issue", "view", "7"]],
    ["list_issues", ["issue", "list"]],
    ["create_issue", ["issue", "create", "--title", "Title", "--body", "Body"]],
  ])("adds the repository only to the %s command", async (operation, argv) => {
    expect((await githubTool.execute({ operation, repo: "owner/repo", number: 7, title: "Title", body: "Body" })).isError).toBe(false);
    expect(ghCalls()).toEqual([["auth", "status"], [...argv, "--repo", "owner/repo"]]);
  });

  it("checks authentication on an explicit host", async () => {
    await githubTool.execute({ operation: "list_issues", repo: "github.example.com/owner/repo" });
    expect(ghCalls()).toEqual([
      ["auth", "status", "--hostname", "github.example.com"],
      ["issue", "list", "--repo", "github.example.com/owner/repo"],
    ]);
  });

  it.each(["owner", "https://github.com/owner/repo", "owner/../repo", "owner/..", null])("rejects malformed target %j before invoking gh", async (repo) => {
    expect((await githubTool.execute({ operation: "list_issues", repo })).isError).toBe(true);
    expect(execFile).not.toHaveBeenCalled();
  });
});

it.each(["view_pr", "view_issue"])("rejects invalid issue and PR numbers for %s", async (operation) => {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    (args.at(-1) as (error: null, stdout: string, stderr: string) => void)(null, "", "");
    return {} as ReturnType<typeof execFile>;
  });
  for (const number of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
    vi.mocked(execFile).mockClear();
    expect((await githubTool.execute({ operation, number })).isError).toBe(true);
    expect(ghCalls()).toEqual([["auth", "status"]]);
  }
});

describe("tools/github list comments", () => {
  let comments: Array<{ author?: { login?: string } | null; body?: string | null; createdAt?: string | null }>;

  beforeEach(() => {
    comments = [
      { author: { login: "alice" }, body: "First point\n- second line", createdAt: "2026-11-21T10:00:06Z" },
      { author: { login: "bob" }, body: "Looks good.", createdAt: "2026-11-21T11:00:00Z" },
    ];
    vi.mocked(execFile).mockReset();
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      const ghArgs = args[1] as string[];
      cb(null, ghArgs[0] === "auth" ? "" : JSON.stringify({ comments }), "");
      return undefined as any;
    });
  });

  it.each([
    ["list_issue_comments", "issue"],
    ["list_pr_comments", "pr"],
  ])("%s returns author, timestamp and multiline body for each comment", async (operation, kind) => {
    const result = await githubTool.execute({ operation, number: 7 });

    expect(result.isError).toBe(false);
    expect(result.output).toBe(
      "Comments on " + (kind === "pr" ? "PR" : "issue") + " #7 (2):\n\n" +
      "alice · 2026-11-21T10:00:06Z\nFirst point\n- second line\n\n---\n\n" +
      "bob · 2026-11-21T11:00:00Z\nLooks good.",
    );
    expect(ghCalls()).toEqual([["auth", "status"], [kind, "view", "7", "--json", "comments"]]);
  });

  it("returns a clear result when there are no comments", async () => {
    comments = [];
    const result = await githubTool.execute({ operation: "list_issue_comments", number: 7 });

    expect(result).toEqual({ output: "No comments on issue #7.", isError: false });
  });

  it.each([0, -3, 1.5, "12", undefined])("rejects number %s before running a comment list", async (number) => {
    const result = await githubTool.execute({ operation: "list_pr_comments", number });

    expect(result.isError).toBe(true);
    expect(result.output).toBe("A positive integer issue or PR number is required.");
    expect(ghCalls()).toEqual([["auth", "status"]]);
  });

  it("reports a failed comment list as an error", async () => {
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      const ghArgs = args[1] as string[];
      if (ghArgs[0] === "auth") cb(null, "", "");
      else cb(Object.assign(new Error("gh failed"), { code: 1 }), "", "GraphQL: Could not resolve to an issue\n");
      return undefined as any;
    });

    const result = await githubTool.execute({ operation: "list_issue_comments", number: 99999 });

    expect(result).toEqual({ output: "GraphQL: Could not resolve to an issue\n", isError: true });
  });

  it("reports unparseable gh output as an error", async () => {
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      const ghArgs = args[1] as string[];
      cb(null, ghArgs[0] === "auth" ? "" : "not json", "");
      return undefined as any;
    });

    const result = await githubTool.execute({ operation: "list_issue_comments", number: 7 });

    expect(result).toEqual({ output: "Could not parse the comment list returned by gh.", isError: true });
  });

  it("caps the listing at 50 comments and names the omitted remainder", async () => {
    comments = Array.from({ length: 52 }, (_, i) => ({
      author: { login: `user${i}` }, body: "short", createdAt: "2026-11-21T10:00:06Z",
    }));
    const result = await githubTool.execute({ operation: "list_issue_comments", number: 7 });

    expect(result.output).toContain("Comments on issue #7 (52):");
    expect(result.output).toContain("... and 2 more comments.");
    expect(result.output).toContain("user49");
    expect(result.output).not.toContain("user50");
  });

  it("truncates an over-long listing and says so", async () => {
    comments = [{ author: { login: "alice" }, body: "x".repeat(9000), createdAt: "2026-11-21T10:00:06Z" }];
    const result = await githubTool.execute({ operation: "list_issue_comments", number: 7 });

    expect(result.output.endsWith("\n...(truncated)")).toBe(true);
    expect(result.output.length).toBeLessThan(9000);
  });
});
