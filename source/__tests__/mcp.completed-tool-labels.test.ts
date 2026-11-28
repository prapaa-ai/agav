import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import render from "../ink/render.js";
import MessageList, { type DisplayMessage } from "../components/message-list.js";
import ToolDetailPanel from "../components/tool-detail-panel.js";

function stripAnsi(s: string): string {
  return s.replaceAll(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

async function renderFrame(element: ReturnType<typeof h>, columns = 120): Promise<string> {
  const chunks: string[] = [];
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  stdout.isTTY = true;
  stdout.columns = columns;
  stdout.rows = 40;
  stdout.write = ((data: string) => {
    chunks.push(data);
    return true;
  }) as typeof stdout.write;

  const stdin = new EventEmitter() as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = (() => stdin) as typeof stdin.setRawMode;
  stdin.resume = (() => stdin) as typeof stdin.resume;
  stdin.pause = (() => stdin) as typeof stdin.pause;
  stdin.read = (() => null) as typeof stdin.read;

  const instance = render(element, {
    stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    await instance.waitUntilRenderFlush();
    return chunks.map(stripAnsi).filter((text) => /[a-z]/i.test(text)).at(-1) ?? "";
  } finally {
    instance.unmount();
  }
}

describe("completed MCP tool server labels", () => {
  it("shows (MCP: server) on completed MCP tool results in MessageList and preserves previews", async () => {
    const messages: DisplayMessage[] = [
      {
        id: "m1",
        role: "tool",
        toolName: "docs__search_pages",
        toolInput: { query: "oauth" },
        content: "first result line\nsecond result line",
      },
      {
        id: "m2",
        role: "tool",
        toolName: "github__search_pages",
        toolInput: { query: "oauth" },
        content: "github failure",
        isError: true,
      },
    ];

    const frame = await renderFrame(
      h(MessageList, { messages, columns: 100, toolDetailKey: "ctrl+o" }),
    );

    expect(frame).toContain("Search pages (MCP: docs)");
    expect(frame).toContain("Search pages (MCP: github)");
    expect(frame).toContain("(2 lines)");
    expect(frame).toContain("first result line...");
    expect(frame).toContain("github failure");
  });

  it("shows (MCP: server) on MCP tool results with diffLines in MessageList", async () => {
    const messages: DisplayMessage[] = [
      {
        id: "m-diff",
        role: "tool",
        toolName: "git__apply_patch",
        toolInput: { path: "README.md" },
        content: "patched",
        diffLines: [{ type: "add", lineNo: 1, text: "hello" }],
      },
    ];

    const frame = await renderFrame(
      h(MessageList, { messages, columns: 100, toolDetailKey: "ctrl+o" }),
    );

    expect(frame).toContain("Apply patch (MCP: git)");
    expect(frame).toContain("patched");
  });

  it("preserves built-in tool labels and custom display names without (MCP: ...) in MessageList", async () => {
    const messages: DisplayMessage[] = [
      {
        id: "b1",
        role: "tool",
        toolName: "read_file",
        toolInput: { path: "package.json" },
        content: '{"name": "agav-cli"}',
      },
      {
        id: "b2",
        role: "tool",
        toolName: "subagent",
        toolDisplayName: "Researcher · Inspect MCP",
        toolInput: { task: "check labels" },
        content: "done",
      },
    ];

    const frame = await renderFrame(
      h(MessageList, { messages, columns: 100, toolDetailKey: "ctrl+o" }),
    );

    expect(frame).toContain("Read File");
    expect(frame).toContain("Researcher · Inspect MCP");
    expect(frame).not.toContain("(MCP:");
  });

  it("shows (MCP: server) in ToolDetailPanel while preserving built-in tools and previews", async () => {
    const tools: DisplayMessage[] = [
      {
        id: "t1",
        role: "tool",
        toolName: "linear__list_issues",
        toolInput: { team: "ENG" },
        content: "ENG-101 Fix auth\nENG-102 Add tests",
      },
      {
        id: "t2",
        role: "tool",
        toolName: "jira__list_issues",
        toolInput: { team: "OPS" },
        content: "OPS-42 Timeout",
        isError: true,
      },
      {
        id: "t3",
        role: "tool",
        toolName: "read_file",
        toolInput: { path: "README.md" },
        content: "# Agav",
      },
      {
        id: "t4",
        role: "tool",
        toolName: "subagent",
        toolDisplayName: "Custom Subagent",
        content: "subagent output",
      },
    ];

    const frame = await renderFrame(
      h(ToolDetailPanel, { tools, closeKey: "ctrl+o" }),
    );

    expect(frame).toContain("List issues (MCP: linear) team");
    expect(frame).toContain("ENG-101 Fix auth");
    expect(frame).toContain("List issues (MCP: jira) team");
    expect(frame).toContain("OPS-42 Timeout");
    expect(frame).toContain("Read File");
    expect(frame).toContain("Custom Subagent");
    expect(frame).toContain("subagent output");
    expect(frame).not.toContain("Read File (MCP:");
    expect(frame).not.toContain("Custom Subagent (MCP:");
  });
});
