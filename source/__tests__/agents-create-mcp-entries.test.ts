import { describe, expect, it, vi } from "vitest";

// The wizard imports templates (file I/O); mock it so importing the component
// module stays side-effect-free in the unit test.
vi.mock("../agents/templates.js", () => ({
  loadTemplates: vi.fn().mockResolvedValue([]),
  saveTemplate: vi.fn(),
  removeTemplate: vi.fn(),
}));

import { resolveMcpServerEntries, mergeMcpListEntries } from "../components/agents-create.js";

describe("resolveMcpServerEntries", () => {
  it("builds a newly selected server from the workspace config", () => {
    const entries = resolveMcpServerEntries(
      ["github"],
      {},
      { github: { command: "npx", args: ["-y", "@mcp/github"], tools: ["get_issue"] } },
    );
    expect(entries).toEqual([{ key: "github", command: "npx", args: ["-y", "@mcp/github"], tools: ["get_issue"] }]);
  });

  it("preserves a retained server's saved tool selection even when the workspace has none", () => {
    // The reported bug: agent had tools:["get_issue"], workspace defines the
    // server without tools; editing an unrelated field must not drop the selection.
    const entries = resolveMcpServerEntries(
      ["github"],
      { github: { command: "npx", args: ["-y", "@mcp/github"], tools: ["get_issue"] } },
      { github: { command: "npx" } },
    );
    expect(entries).toEqual([{ key: "github", command: "npx", args: ["-y", "@mcp/github"], tools: ["get_issue"] }]);
  });

  it("prefers the saved selection over a differing workspace selection", () => {
    const entries = resolveMcpServerEntries(
      ["github"],
      { github: { command: "npx", tools: ["get_issue"] } },
      { github: { command: "npx", tools: ["search_issues", "list_pull_requests"] } },
    );
    expect(entries[0]!.tools).toEqual(["get_issue"]);
  });

  it("works for a template recreation (same source path, editingAgent is null)", () => {
    const entries = resolveMcpServerEntries(
      ["linear"],
      { linear: { command: "npx", tools: ["create_issue"] } },
      undefined,
    );
    expect(entries).toEqual([{ key: "linear", command: "npx", tools: ["create_issue"] }]);
  });

  it("uses a retained server whole and never mixes it with the workspace config", () => {
    // A saved server with its own command/no args must NOT inherit workspace
    // args — that could form an invalid startup command.
    const entries = resolveMcpServerEntries(
      ["github"],
      { github: { command: "/opt/agent-server" } },
      { github: { command: "npx", args: ["-y", "@mcp/github"] } },
    );
    expect(entries).toEqual([{ key: "github", command: "/opt/agent-server", args: undefined }]);
  });

  it("keeps a retained server's 'all tools' omission instead of inheriting a workspace restriction", () => {
    // Saved server omits tools (means all); workspace restricts. The agent's
    // intent (all tools) must win — no inherited restriction.
    const entries = resolveMcpServerEntries(
      ["github"],
      { github: { command: "npx" } },
      { github: { command: "npx", tools: ["get_issue"] } },
    );
    expect(entries[0]!.tools).toBeUndefined();
  });

  it("skips a retained server whose saved config has no command, without borrowing the workspace command", () => {
    // key in source → use source whole; a source entry lacking a command is
    // skipped rather than silently taking the workspace command.
    const entries = resolveMcpServerEntries(
      ["github"],
      { github: { tools: ["get_issue"] } },
      { github: { command: "docker", args: ["run", "ghcr.io/mcp"] } },
    );
    expect(entries).toEqual([]);
  });

  it("skips a selected server with no resolvable command in either source", () => {
    const entries = resolveMcpServerEntries(["ghost"], {}, { other: { command: "npx" } });
    expect(entries).toEqual([]);
  });

  it("omits empty env and empty/absent tool selections", () => {
    const entries = resolveMcpServerEntries(
      ["a", "b"],
      {},
      { a: { command: "npx", env: {}, tools: [] }, b: { command: "npx" } },
    );
    expect(entries).toEqual([
      { key: "a", command: "npx", args: undefined },
      { key: "b", command: "npx", args: undefined },
    ]);
  });

  it("resolves each selected server independently", () => {
    const entries = resolveMcpServerEntries(
      ["a", "b"],
      { a: { command: "npx", tools: ["x"] } },
      { b: { command: "npx", tools: ["y", "z"] } },
    );
    expect(entries).toEqual([
      { key: "a", command: "npx", args: undefined, tools: ["x"] },
      { key: "b", command: "npx", args: undefined, tools: ["y", "z"] },
    ]);
  });
});

describe("mergeMcpListEntries", () => {
  it("lists workspace servers first, in config order", () => {
    const list = mergeMcpListEntries({ a: { command: "npx" }, b: { command: "npx" } }, {});
    expect(list.map(([k]) => k)).toEqual(["a", "b"]);
  });

  it("appends retained servers the workspace no longer defines, with their saved config", () => {
    // The reported gap: a template server absent from the workspace must still
    // appear so it can be seen, deselected and reviewed — not saved invisibly.
    const list = mergeMcpListEntries(
      { a: { command: "npx" } },
      { gone: { command: "/opt/server", tools: ["x"] } },
    );
    expect(list).toEqual([
      ["a", { command: "npx" }],
      ["gone", { command: "/opt/server", tools: ["x"] }],
    ]);
  });

  it("shows a server present in both with its saved config (matching what save persists), without duplicating it", () => {
    const list = mergeMcpListEntries(
      { shared: { command: "npx", args: ["workspace"] } },
      { shared: { command: "npx", args: ["saved"] } },
    );
    // One row (workspace slot) showing the saved config — the list/review must
    // match resolveMcpServerEntries, which saves the source config whole.
    expect(list).toEqual([["shared", { command: "npx", args: ["saved"] }]]);
  });

  it("handles an undefined workspace", () => {
    const list = mergeMcpListEntries(undefined, { only: { command: "npx" } });
    expect(list).toEqual([["only", { command: "npx" }]]);
  });
});
