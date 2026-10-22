import { describe, expect, it, vi } from "vitest";

// The wizard imports templates (file I/O); mock it so importing the component
// module stays side-effect-free in the unit test.
vi.mock("../agents/templates.js", () => ({
  loadTemplates: vi.fn().mockResolvedValue([]),
  saveTemplate: vi.fn(),
  removeTemplate: vi.fn(),
}));

import { resolveMcpServerEntries } from "../components/agents-create.js";

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

  it("falls back to the workspace command when the source entry lacks one", () => {
    const entries = resolveMcpServerEntries(
      ["github"],
      { github: { tools: ["get_issue"] } },
      { github: { command: "docker", args: ["run", "ghcr.io/mcp"] } },
    );
    expect(entries).toEqual([{ key: "github", command: "docker", args: ["run", "ghcr.io/mcp"], tools: ["get_issue"] }]);
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
