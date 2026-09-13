import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";

vi.mock("../agents/templates.js", () => ({
  loadTemplates: vi.fn().mockResolvedValue([]),
  saveTemplate: vi.fn(),
  removeTemplate: vi.fn(),
}));

import { CreateTab } from "../components/agents-create.js";

const ROWS = 30;
const COLS = 100;

type FakeStdout = NodeJS.WriteStream & { chunks: string[] };

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

const stripAnsi = (text: string) => text.replaceAll(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

async function settle(instance: { waitUntilRenderFlush: () => Promise<void> }) {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await instance.waitUntilRenderFlush();
  }
}

async function mountNativeToolsStep() {
  const stdout = makeStdout();
  const stdin = makeStdin();
  const provider = {
    async *stream() {
      yield { type: "text_delta" as const, text: "System prompt" };
    },
  };
  const instance = render(h(CreateTab, {
    onReloadAgents: async () => {},
    onExit: () => {},
    provider: provider as any,
    config: { model: "test" } as any,
    agents: [],
    registryEntries: {},
    installedAgents: new Map(),
  }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });

  const press = async (key: string) => {
    stdin.emit("data", Buffer.from(key));
    await settle(instance);
  };

  await settle(instance);
  await press("\r"); // New Agent → wizard
  for (const char of "agent") await press(char);
  await press("\r");
  for (const char of "description") await press(char);
  await press("\r"); // steps 1 → 2
  await press("\r"); // step 2 → native tools
  return { instance, stdout, stdin };
}

function lastFrame(stdout: FakeStdout): string {
  const frames = stdout.chunks.filter((chunk) => /[a-z0-9]/i.test(stripAnsi(chunk)));
  return stripAnsi(frames.at(-1) ?? "");
}

describe("CreateTab native tool selection", () => {
  it("keeps the active tool visible while navigating past the initial rows", async () => {
    const { instance, stdout, stdin } = await mountNativeToolsStep();
    const initial = lastFrame(stdout);
    const firstTool = initial.match(/› \[ \] ([^\n ]+)/)?.[1];
    expect(initial).toContain("Select Native Tools");
    expect(firstTool).toBeTruthy();

    for (let i = 0; i < 10; i++) stdin.emit("data", Buffer.from("\x1b[B"));
    await settle(instance);

    const frame = lastFrame(stdout);
    expect(frame).toMatch(/› \[ \] \S+/);
    expect(frame).not.toContain(`› [ ] ${firstTool}`);
    expect(frame.split("\n").filter((line) => /\[[ x]\]/.test(line))).toHaveLength(8);
    expect(frame).toMatch(/\d+-\d+ of \d+/);
    instance.unmount();
  });
});
