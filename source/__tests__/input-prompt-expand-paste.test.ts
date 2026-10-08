import { EventEmitter } from "node:events";
import { createElement as h, useState } from "react";
import { describe, it, expect, vi } from "vitest";
import render from "../ink/render.js";
import InputPrompt from "../components/input-prompt.js";
import App from "../app.js";
import type { AgavConfig } from "../config/config.js";

vi.mock("../providers/registry.js", () => ({ createProvider: () => null }));
vi.mock("../hooks/use-agent.js", () => ({
  useAgent: () => ({
    messages: [], toolCalls: [], subagentStates: [], loadedPlugins: [],
    mcpServers: [], mcpPromptCommands: [], skillCommands: [], agentCommands: [],
    conversation: { getMessages: () => [] },
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    submit: async () => true,
  }),
}));
vi.mock("../components/message-list.js", () => ({ default: () => null }));
vi.mock("../components/status-bar.js", () => ({ default: () => null }));
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";
import { attachmentTileForId } from "../utils/attachments.js";

vi.mock("../config/prompt-history.js", () => ({
  loadPromptHistory: async () => [],
  savePromptHistory: async () => {},
}));

const ROWS = 20;
const COLS = 60;

const makeStdout = () => {
  const emitter = new EventEmitter() as unknown as NodeJS.WriteStream & { chunks: string[] };
  emitter.chunks = [];
  emitter.isTTY = true;
  emitter.columns = COLS;
  emitter.rows = ROWS;
  emitter.write = ((data: string) => {
    emitter.chunks.push(data);
    return true;
  }) as NodeJS.WriteStream["write"];
  return emitter;
};

const makeStdin = (): NodeJS.ReadStream => {
  const emitter = new EventEmitter() as unknown as NodeJS.ReadStream;
  emitter.isTTY = true;
  emitter.setRawMode = (() => emitter) as NodeJS.ReadStream["setRawMode"];
  emitter.resume = (() => emitter) as NodeJS.ReadStream["resume"];
  emitter.pause = (() => emitter) as NodeJS.ReadStream["pause"];
  emitter.read = (() => null) as NodeJS.ReadStream["read"];
  return emitter;
};

const settle = async (instance: { waitUntilRenderFlush: () => Promise<void> }) => {
  for (let i = 0; i < 4; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 20));
    // eslint-disable-next-line no-await-in-loop
    await instance.waitUntilRenderFlush();
  }
};

let currentValue = "";
let expandFn: ((id: number, fullText: string) => boolean) | null = null;
let insertFn: ((label: string) => void) | null = null;

const Host = ({ initial, keybindings = DEFAULT_KEYBINDINGS, resumeUserMessages }: {
  initial: string;
  keybindings?: typeof DEFAULT_KEYBINDINGS;
  resumeUserMessages?: string[];
}) => {
  const [value, setValue] = useState(initial);
  currentValue = value;
  return h(InputPrompt, {
    value,
    onChange: setValue,
    onSubmit: () => {},
    keybindings,
    resumeUserMessages,
    onRegisterInsert: (fn) => { insertFn = fn; },
    onRegisterExpand: (fn) => { expandFn = fn; },
  });
};

const mount = async (initial = "", options: { keybindings?: typeof DEFAULT_KEYBINDINGS; resumeUserMessages?: string[] } = {}) => {
  const stdout = makeStdout();
  const stdin = makeStdin();
  const instance = render(h(Host, { initial, ...options }), {
    stdout, stdin, patchConsole: false, exitOnCtrlC: false,
  });
  await settle(instance);
  return { instance, stdout, stdin };
};

describe("attachmentTileForId", () => {
  it("matches only the tile for the given id", () => {
    const text = "<<Pasted #1 · 5 chars, 1 lines>> and <<Pasted #2 · 9 chars, 1 lines>>";
    const re1 = attachmentTileForId(1);
    const re2 = attachmentTileForId(2);
    expect(text.match(re1)?.[0]).toBe("<<Pasted #1 · 5 chars, 1 lines>>");
    expect(text.match(re2)?.[0]).toBe("<<Pasted #2 · 9 chars, 1 lines>>");
  });

  it("does not match a different id, even a prefix of it", () => {
    const text = "<<Pasted #12 · 5 chars, 1 lines>>";
    expect(attachmentTileForId(1).test(text)).toBe(false);
    expect(attachmentTileForId(12).test(text)).toBe(true);
  });
});

const frame = (stdout: NodeJS.WriteStream & { chunks: string[] }) =>
  (stdout.chunks.map((chunk) => chunk.replaceAll(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""))
    .filter((chunk) => /[a-z0-9]/i.test(chunk)).at(-1) ?? "");

const press = async (instance: { waitUntilRenderFlush: () => Promise<void> }, stdin: NodeJS.ReadStream, key: string) => {
  stdin.emit("data", Buffer.from(key));
  await settle(instance);
};

describe("expanded paste inspection", () => {
  it("restores the draft after recalling a soft-wrapped history entry", async () => {
    const { instance, stdin } = await mount("draft", { resumeUserMessages: ["a".repeat(100)] });
    try {
      await press(instance, stdin, "\x1b[A");
      expect(currentValue).toBe("a".repeat(100));
      await press(instance, stdin, "\x1b[B");
      expect(currentValue).toBe("draft");
    } finally { instance.unmount(); }
  });

  it("honors a plain arrow rebound to newline", async () => {
    const { instance, stdin } = await mount("abc\ndef", {
      keybindings: { ...DEFAULT_KEYBINDINGS, newline: ["up"], historyUp: ["ctrl+n"] },
    });
    try {
      await press(instance, stdin, "\x1b[A");
      expect(currentValue).toBe("\nabc\ndef");
    } finally { instance.unmount(); }
  });

  it("does not advertise repeat expansion for an untracked tile", async () => {
    const tile = "<<Pasted #1 · 100 chars, 10 lines>>";
    const { instance, stdout } = await mount(tile);
    try {
      expect(currentValue).toBe(tile);
      expect(frame(stdout)).not.toContain("paste again to expand");
    } finally { instance.unmount(); }
  });

  it("bounds expanded content and follows the caret when navigating", async () => {
    const { instance, stdout, stdin } = await mount();
    try {
      insertFn!("<<Pasted #1 · 100 chars, 30 lines>>");
      await settle(instance);
      const lines = Array.from({ length: 30 }, (_, i) => `row${String(i).padStart(2, "0")}`);
      expect(expandFn!(1, lines.join("\n"))).toBe(true);
      await settle(instance);
      expect(frame(stdout)).toContain("row29");
      expect(frame(stdout)).not.toContain("row00");
      expect(frame(stdout)).toContain("of 30");
      expect(frame(stdout).split("\n").length).toBeLessThanOrEqual(10);
      await press(instance, stdin, "\x1b[A");
      await press(instance, stdin, "X");
      expect(currentValue).toBe([...lines.slice(0, 29), lines[29]!].map((line, i) => i === 28 ? `${line}X` : line).join("\n") + " ");
    } finally { instance.unmount(); }
  });

  it("maps clicks to the visible rows after scrolling", async () => {
    const { instance, stdin } = await mount();
    try {
      const lines = Array.from({ length: 30 }, (_, i) => `row${String(i).padStart(2, "0")}`);
      insertFn!(lines.join("\n"));
      await settle(instance);
      // The six visible input rows start at row24; column 2 follows the prefix.
      stdin.emit("data", Buffer.from("\x1b[<0;3;1M\x1b[<0;3;1m"));
      await settle(instance);
      await press(instance, stdin, "X");
      expect(currentValue).toBe(lines.map((line, i) => i === 24 ? `X${line}` : line).join("\n") + " ");
    } finally { instance.unmount(); }
  });

  it("owns exact-width boundaries without overflowing the cursor row", async () => {
    const { instance, stdin, stdout } = await mount();
    try {
      insertFn!("a".repeat(COLS - 2) + "\nb");
      await settle(instance);
      await press(instance, stdin, "\x1b[A");
      await press(instance, stdin, "X");
      expect(currentValue).toBe("a".repeat(COLS - 2) + "X\nb ");
      expect(frame(stdout).split("\n").every((line) => line.length <= COLS)).toBe(true);
    } finally { instance.unmount(); }
  });

  it("navigates soft-wrapped rows rather than recalling history", async () => {
    const { instance, stdin } = await mount();
    try {
      insertFn!("a".repeat(COLS - 2) + "bc");
      await settle(instance);
      await press(instance, stdin, "\x1b[A");
      await press(instance, stdin, "X");
      expect(currentValue).toBe("aaaX" + "a".repeat(COLS - 5) + "bc ");
    } finally { instance.unmount(); }
  });

  it("preserves the preferred column through shorter lines and burst keys", async () => {
    const { instance, stdin } = await mount();
    try {
      insertFn!("abcdef\nx\nabcdef");
      await settle(instance);
      stdin.emit("data", Buffer.from("\x1b[A\x1b[A"));
      await settle(instance);
      await press(instance, stdin, "X");
      expect(currentValue).toBe("abcdefX\nx\nabcdef ");
    } finally { instance.unmount(); }
  });

  it("keeps a caret before a newline visible and handles wide graphemes", async () => {
    const { instance, stdin } = await mount();
    try {
      insertFn!("界🎉z\n1234");
      await settle(instance);
      await press(instance, stdin, "\x1b[A");
      await press(instance, stdin, "X");
      expect(currentValue).toBe("界🎉zX\n1234 ");
      await press(instance, stdin, "\x1b[B");
      await press(instance, stdin, "Y");
      expect(currentValue).toBe("界🎉zX\n1234 Y");
    } finally { instance.unmount(); }
  });
});

describe("App repeat-paste eligibility hint", () => {
  const config: AgavConfig = {
    provider: "anthropic", model: "test", effort: "high", maxTokens: 1024,
    maxIterations: 10, errorRetries: 1, permissionMode: "ask",
  };
  const mountApp = async () => {
    const stdout = makeStdout();
    const stdin = makeStdin();
    const instance = render(h(App, { config, keybindings: DEFAULT_KEYBINDINGS }), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false,
    });
    await settle(instance);
    return { instance, stdout, stdin };
  };
  const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

  it("shows the hint only until an edit, and an edited repeat creates a fresh tile", async () => {
    const { instance, stdout, stdin } = await mountApp();
    const text = "a".repeat(50);
    try {
      expect(frame(stdout)).not.toContain("paste again to expand");
      await press(instance, stdin, paste(text));
      expect(frame(stdout)).toContain("Pasted #");
      expect(frame(stdout)).toContain("paste again to expand");
      await press(instance, stdin, "X");
      expect(frame(stdout)).toContain("Pasted #");
      expect(frame(stdout)).not.toContain("paste again to expand");
      await press(instance, stdin, paste(text));
      expect(frame(stdout).match(/<<Pasted #/g)).toHaveLength(2);
      expect(frame(stdout)).toContain("paste again to expand");
    } finally { instance.unmount(); }
  });

  it("hides the hint after expansion even when an older tile remains", async () => {
    const { instance, stdout, stdin } = await mountApp();
    const text = "b".repeat(50);
    try {
      await press(instance, stdin, paste("a".repeat(50)));
      await press(instance, stdin, paste(text));
      expect(frame(stdout).match(/<<Pasted #/g)).toHaveLength(2);
      expect(frame(stdout)).toContain("paste again to expand");
      await press(instance, stdin, paste(text));
      expect(frame(stdout).match(/<<Pasted #/g)).toHaveLength(1);
      // The expanded text is soft-wrapped across two rendered rows.
      expect(frame(stdout).match(/b/g)).toHaveLength(text.length);
      expect(frame(stdout)).not.toContain("paste again to expand");
      await press(instance, stdin, paste(text));
      expect(frame(stdout).match(/<<Pasted #/g)).toHaveLength(2);
      expect(frame(stdout)).toContain("paste again to expand");
    } finally { instance.unmount(); }
  });

  it("clears eligibility on short paste and on clearing the prompt", async () => {
    const { instance, stdout, stdin } = await mountApp();
    try {
      await press(instance, stdin, paste("a".repeat(50)));
      await press(instance, stdin, paste("short"));
      expect(frame(stdout)).toContain("Pasted #");
      expect(frame(stdout)).not.toContain("paste again to expand");
      await press(instance, stdin, paste("b".repeat(50)));
      expect(frame(stdout)).toContain("paste again to expand");
      await press(instance, stdin, "\x15");
      expect(frame(stdout)).not.toContain("Pasted #");
      expect(frame(stdout)).not.toContain("paste again to expand");
    } finally { instance.unmount(); }
  });
});

describe("double-paste-to-expand wiring in InputPrompt", () => {
  it("replaces an existing tile with the full text via the registered expand function", async () => {
    const label = "<<Pasted #1 · 11 chars, 1 lines>>";
    const { instance } = await mount(`before ${label} after`);

    expect(expandFn).not.toBeNull();
    const fullText = "hello world";
    const replaced = expandFn!(1, fullText);
    await settle(instance);

    expect(replaced).toBe(true);
    expect(currentValue).toBe(`before ${fullText} after`);
    instance.unmount();
  });

  it("returns false and leaves the buffer untouched when the tile is no longer present", async () => {
    const { instance } = await mount("no attachments here");

    const replaced = expandFn!(1, "full text");
    await settle(instance);

    expect(replaced).toBe(false);
    expect(currentValue).toBe("no attachments here");
    instance.unmount();
  });

  it("expands the correct tile when several are present", async () => {
    const tile1 = "<<Pasted #1 · 3 chars, 1 lines>>";
    const tile2 = "<<Pasted #2 · 3 chars, 1 lines>>";
    const { instance } = await mount(`${tile1} and ${tile2}`);

    const replaced = expandFn!(2, "XYZ");
    await settle(instance);

    expect(replaced).toBe(true);
    expect(currentValue).toBe(`${tile1} and XYZ`);
    instance.unmount();
  });

  it("still allows inserting a fresh label afterward via onRegisterInsert", async () => {
    const { instance } = await mount("");
    insertFn!("<<Pasted #1 · 5 chars, 1 lines>>");
    await settle(instance);
    expect(currentValue).toContain("<<Pasted #1 · 5 chars, 1 lines>>");
    instance.unmount();
  });
});
