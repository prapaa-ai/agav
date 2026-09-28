import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import type { AgentDefinition, AgentOrigin, AgentType } from "../agents/types.js";
import { ConfigEditView } from "../components/agents-inspect.js";
import { getConfigItems } from "../components/agents-types.js";
import render from "../ink/render.js";

const ROWS = 30;
const COLS = 200;

type FakeStdout = NodeJS.WriteStream & { chunks: string[] };

function makeAgent(origin: AgentOrigin, type?: AgentType): AgentDefinition {
  return {
    manifest: {
      name: "test-agent",
      description: "Test agent",
      version: "1.0.0",
      ...(type ? { type } : {}),
    },
    systemPrompt: "Test prompt",
    tools: [],
    origin,
    path: "/tmp/test-agent",
  };
}

function makeStdout(): FakeStdout {
  const stdout = new EventEmitter() as unknown as FakeStdout;
  stdout.chunks = [];
  stdout.isTTY = true;
  stdout.columns = COLS;
  stdout.rows = ROWS;
  stdout.write = ((data: string) => {
    stdout.chunks.push(data);
    return true;
  }) as FakeStdout["write"];
  return stdout;
}

function makeStdin(): NodeJS.ReadStream {
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = (() => stdin) as NodeJS.ReadStream["setRawMode"];
  stdin.resume = (() => stdin) as NodeJS.ReadStream["resume"];
  stdin.pause = (() => stdin) as NodeJS.ReadStream["pause"];
  stdin.read = (() => null) as NodeJS.ReadStream["read"];
  return stdin;
}

function stripAnsi(text: string): string {
  return text.replaceAll(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

async function settle(instance: { waitUntilRenderFlush: () => Promise<void> }) {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await instance.waitUntilRenderFlush();
  }
}

describe("edit-agent native tools", () => {
  it("exposes Native Tools only for editable native agents", () => {
    expect(getConfigItems(makeAgent("global")).at(-1)).toEqual({
      key: "native-tools",
      label: "Native Tools",
      secret: false,
      type: "native-tools",
    });
    expect(getConfigItems(makeAgent("project")).at(-1)?.key).toBe("native-tools");
    expect(getConfigItems(makeAgent("bundled")).map((item) => item.key)).not.toContain("native-tools");
    expect(getConfigItems(makeAgent("global", "a2a")).map((item) => item.key)).not.toContain("native-tools");
  });

  it("renders the native tools editor with current selection and controls", async () => {
    const agent = makeAgent("global");
    const stdout = makeStdout();
    const instance = render(h(ConfigEditView, {
      agent,
      items: getConfigItems(agent),
      editIndex: 2,
      editKey: "native-tools",
      editBuffer: "",
      isEditing: false,
      savedKeys: {},
      error: null,
      runtimeConfig: {},
      nativeToolNames: new Set(["read_file"]),
      nativeToolsIndex: 0,
      nativeToolsEditing: true,
    }), {
      stdout,
      stdin: makeStdin(),
      patchConsole: false,
      exitOnCtrlC: false,
    });
    await settle(instance);

    const frame = stripAnsi(stdout.chunks.join(""));
    expect(frame).toContain("→ Native Tools  1 selected");
    expect(frame).toContain("Choose the built-in Agav tools this agent can use");
    expect(frame).toMatch(/\d+ tool\(s\) available — 1 selected/);
    expect(frame).toContain("› [x] read_file");
    expect(frame).toContain("  [ ] write_file");
    expect(frame).toContain("SPACE: Toggle | ENTER: Save | ESC: Cancel");

    instance.unmount();
  });
});
