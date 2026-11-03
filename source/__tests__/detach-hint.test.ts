import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { afterEach, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import DetachHint from "../components/detach-hint.js";

const textProps = vi.hoisted(() => [] as Array<{ color?: string; bold?: boolean }>);
vi.mock("../ink/index.js", async original => {
  const actual = await original<typeof import("../ink/index.js")>();
  return { ...actual, Text: (props: Parameters<typeof actual.Text>[0]) => { textProps.push(props); return h(actual.Text, props); } };
});

const mounts: ReturnType<typeof render>[] = [];
afterEach(() => { for (const ui of mounts.splice(0)) ui.unmount(); vi.useRealTimers(); textProps.length = 0; });

async function mount(overrides: Partial<Parameters<typeof DetachHint>[0]> = {}) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(100_000);
  const props = { canDetach: true, isLoading: true, turnStartTime: Date.now(), sessionId: "session", shortcut: "Ctrl+D", ...overrides };
  const chunks: string[] = [];
  const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 24, write: (text: string) => { chunks.push(text); return true; } }) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null }) as unknown as NodeJS.ReadStream;
  const ui = render(h(DetachHint, props), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  mounts.push(ui);
  const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await new Promise<void>(resolve => setImmediate(resolve)); await vi.advanceTimersByTimeAsync(0); };
  await advance(0);
  const output = () => chunks.join("").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const rerender = async (patch: Partial<typeof props>) => { Object.assign(props, patch); chunks.length = 0; ui.rerender(h(DetachHint, props)); await advance(0); };
  return { props, ui, advance, output, rerender, stdin, clearOutput: () => { chunks.length = 0; } };
}

it("waits 30 seconds, then highlights the configured shortcut", async () => {
  const { advance, output } = await mount({ shortcut: "Ctrl+K Ctrl+E" });
  await advance(29_999);
  expect(output().includes(": detach")).toBe(false);
  await advance(1);
  expect(output().includes("Ctrl+K Ctrl+E: detach")).toBe(true);
  expect(textProps.at(-1)).toMatchObject({ color: "cyan", bold: true });
});

it.each([{ canDetach: false }, { isLoading: false }])("does not show the hint for inactive work (%j)", async overrides => {
  const { advance, output } = await mount(overrides);
  await advance(30_000);
  expect(output().includes(": detach")).toBe(false);
});

it("cancels the pending hint when work finishes and starts a fresh delay next turn", async () => {
  const { advance, output, rerender } = await mount();
  await advance(20_000);
  await rerender({ isLoading: false, canDetach: false });
  await advance(10_000);
  expect(output()).not.toContain(": detach");
  await rerender({ isLoading: true, canDetach: true, turnStartTime: Date.now() });
  await advance(29_999);
  expect(output()).not.toContain(": detach");
  await advance(1);
  expect(output()).toContain(": detach");
  await rerender({ isLoading: false });
  expect(output()).not.toContain(": detach");
});

it("counts elapsed turn preparation time rather than restarting at worker admission", async () => {
  const { advance, output } = await mount({ turnStartTime: 80_000 });
  await advance(9_999);
  expect(output()).not.toContain(": detach");
  await advance(1);
  expect(output()).toContain(": detach");
});

it("hides two seconds after the first key without postponing for further typing", async () => {
  const { advance, output, stdin, clearOutput, rerender } = await mount();
  await advance(30_000);
  expect(output()).toContain(": detach");
  stdin.emit("data", "a");
  await advance(1_000);
  stdin.emit("data", "b");
  await advance(999);
  await rerender({ shortcut: "Still visible" });
  expect(output()).toContain("Still visible: detach");
  clearOutput();
  await advance(1);
  // A rerender with unchanged turn identity must not show the hint again.
  await rerender({ shortcut: "Ctrl+E" });
  expect(output()).not.toContain(": detach");
  await advance(30_000);
  expect(output()).not.toContain(": detach");
});

it("ignores input before the hint is visible", async () => {
  const { advance, output, stdin } = await mount();
  stdin.emit("data", "a");
  await advance(30_000);
  expect(output()).toContain(": detach");
});

it("cleans up dismissal on turn completion and permits the next turn's hint", async () => {
  const { advance, output, stdin, rerender } = await mount();
  await advance(30_000);
  stdin.emit("data", "\x1b[A");
  await advance(1_000);
  await rerender({ isLoading: false, canDetach: false });
  await rerender({ isLoading: true, canDetach: true, turnStartTime: Date.now() });
  await advance(30_000);
  expect(output()).toContain(": detach");
});

it("cleans up dismissal when unmounted", async () => {
  const { advance, ui, stdin } = await mount();
  await advance(30_000);
  stdin.emit("data", "a");
  await advance(0);
  ui.unmount();
  const count = textProps.length;
  await advance(2_000);
  expect(textProps).toHaveLength(count);
});

it.each(["\r", "\x1b[A", "\x04"])("dismisses after non-printable input %j", async input => {
  const { advance, output, stdin, rerender } = await mount();
  await advance(30_000);
  stdin.emit("data", input);
  await advance(2_000);
  await rerender({ shortcut: "Ctrl+E" });
  expect(output()).not.toContain(": detach");
});

it("does not dismiss on a key release without a key press", async () => {
  const { advance, output, stdin, rerender } = await mount();
  await advance(30_000);
  stdin.emit("data", "\x1b[97;1:3u");
  await advance(2_000);
  await rerender({ shortcut: "Ctrl+E" });
  expect(output()).toContain("Ctrl+E: detach");
});
