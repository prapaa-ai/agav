import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import { CustomizeTUI } from "../components/customize-tui.js";
import {
  defaultStatusBarLayout,
  type StatusBarLayout,
} from "../config/status-bar-layout.js";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

interface Harness {
  frame: () => string;
  key: (text: string) => Promise<void>;
  changes: StatusBarLayout[];
  exited: StatusBarLayout[];
}

async function mount(initialLayout?: StatusBarLayout): Promise<Harness> {
  const chunks: string[] = [];
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, {
    isTTY: true, columns: 100, rows: 40,
    write: (text: string) => { chunks.push(text); return true; },
  });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, {
    isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null,
  });
  const changes: StatusBarLayout[] = [];
  const exited: StatusBarLayout[] = [];
  const instance = render(
    h(CustomizeTUI, {
      initialLayout,
      preview: {
        model: "anthropic/claude",
        effort: "effort: high",
        messages: "0 msgs",
        usage: "0 tokens",
        sandbox: "sandbox: seatbelt",
        session: "session: abc12345",
        hint: "Press ? for help",
      },
      onChange: (layout) => changes.push(layout),
      onExit: (layout) => exited.push(layout),
    }),
    { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
  );
  const settle = async () => {
    // Wait past ink's 50 ms bare-Escape disambiguation timer so a lone ESC is
    // delivered as the Escape key rather than held as a possible sequence prefix.
    await new Promise((resolve) => setTimeout(resolve, 80));
    await instance.waitUntilRenderFlush();
  };
  const frame = () => chunks.map(stripAnsi).filter((t) => /[a-z]/i.test(t)).at(-1) ?? "";
  const key = async (text: string) => { stdin.emit("data", Buffer.from(text)); await settle(); };
  await settle();
  return { frame, key, changes, exited };
}

// Key escape sequences.
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";

describe("CustomizeTUI", () => {
  it("opens on the hub listing Status bar and enters the editor", async () => {
    const h = await mount();
    expect(h.frame()).toContain("Customize Agav");
    expect(h.frame()).toContain("Status bar");
    await h.key(ENTER); // open status bar editor
    expect(h.frame()).toContain("Customize");
    expect(h.frame()).toContain("Preview");
    expect(h.frame()).toContain("Model");
  });

  it("toggles a segment with Space, emitting the change and updating the preview", async () => {
    const h = await mount();
    await h.key(ENTER); // enter editor; cursor on first item (model)
    await h.key(" ");   // hide model
    const last = h.changes.at(-1)!;
    expect(last.find((i) => i.id === "model")!.enabled).toBe(false);
    // The preview line (the first content line after "Preview") drops the model
    // segment. The item *description* legitimately mentions "anthropic/claude",
    // so assert on the rendered preview line specifically.
    const frame = h.frame();
    const previewLine = frame.split("\n").find((l) => l.includes("effort: high"))!;
    expect(previewLine).not.toContain("anthropic/claude");
    expect(previewLine).toContain("effort: high");
  });

  it("reorders a segment with ']' (move down)", async () => {
    const h = await mount();
    await h.key(ENTER);
    await h.key("]"); // move 'model' down one slot
    const last = h.changes.at(-1)!;
    expect(last[0]!.id).toBe("effort");
    expect(last[1]!.id).toBe("model");
  });

  it("restores defaults with 'r'", async () => {
    // Start from a customized layout (model hidden, usage first).
    const custom: StatusBarLayout = [
      { id: "usage", enabled: false },
      { id: "model", enabled: false },
    ];
    const h = await mount(custom);
    await h.key(ENTER);
    await h.key("r");
    expect(h.changes.at(-1)).toEqual(defaultStatusBarLayout());
  });

  it("Enter saves and exits with the final layout", async () => {
    const h = await mount();
    await h.key(ENTER); // editor
    await h.key(" ");   // hide model
    await h.key(ENTER); // save & exit
    expect(h.exited).toHaveLength(1);
    expect(h.exited[0]!.find((i) => i.id === "model")!.enabled).toBe(false);
  });

  it("Esc from the editor returns to the hub without exiting", async () => {
    const h = await mount();
    await h.key(ENTER); // editor
    await h.key(ESC);   // back to hub
    expect(h.frame()).toContain("Customize Agav");
    expect(h.exited).toHaveLength(0);
  });

  it("Esc from the hub exits", async () => {
    const h = await mount();
    await h.key(ESC);
    expect(h.exited).toHaveLength(1);
  });

  it("navigates with arrow keys before toggling", async () => {
    const h = await mount();
    await h.key(ENTER); // editor
    await h.key(DOWN);  // move to 'effort'
    await h.key(" ");   // hide effort
    const last = h.changes.at(-1)!;
    expect(last.find((i) => i.id === "effort")!.enabled).toBe(false);
    expect(last.find((i) => i.id === "model")!.enabled).toBe(true);
  });

  it("shows the Tips (hint) row and previews the 💡 line", async () => {
    const h = await mount();
    await h.key(ENTER); // editor
    const frame = h.frame();
    expect(frame).toContain("Tips");
    // The hint line is shown in the preview while enabled.
    expect(frame).toContain("💡");
    expect(frame).toContain("Press ? for help");
  });

  it("toggling Tips off hides the hint line from the preview", async () => {
    const h = await mount();
    await h.key(ENTER); // editor; cursor on 'model' (index 0)
    // Walk down to the last row (Tips) and toggle it off.
    for (let i = 0; i < 7; i++) await h.key(DOWN);
    await h.key(" ");
    const last = h.changes.at(-1)!;
    expect(last.find((i) => i.id === "hint")!.enabled).toBe(false);
    // Preview no longer shows the hint line.
    expect(h.frame()).not.toContain("Press ? for help");
  });
});
