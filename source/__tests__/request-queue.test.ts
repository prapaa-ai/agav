import { EventEmitter } from "node:events";
import { createElement as h, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import RequestQueue from "../components/request-queue.js";

async function mount(active = true) {
  const chunks: string[] = [];
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 80, rows: 20, write: (text: string) => { chunks.push(text); return true; } });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  const cancel = vi.fn(); const close = vi.fn();
  function App() {
    const [requests, setRequests] = useState(Array.from({ length: 6 }, (_, i) => ({ id: 10 + i, text: `task${i}`, attachmentCount: 0 })));
    return h(RequestQueue, { requests, active, onClose: close, onActivate: vi.fn(), columns: 80,
      onCancel: (id: number) => { cancel(id); setRequests(prev => prev.filter(request => request.id !== id)); } });
  }
  const instance = render(h(App), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 60)); await instance.waitUntilRenderFlush(); };
  const key = async (value: string) => { stdin.emit("data", Buffer.from(value)); await settle(); };
  await settle();
  return { instance, key, cancel, close, output: () => chunks.join("").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "") };
}

describe("queue controls", () => {
  it("cancels middle, last and first entries by stable ID, paginates, and closes when empty", async () => {
    const ui = await mount();
    try {
      await ui.key("\x1b[B"); await ui.key("\x7f");
      expect(ui.cancel).toHaveBeenLastCalledWith(11);
      for (let i = 0; i < 6; i++) await ui.key("\x1b[B");
      expect(ui.output()).toContain("task5");
      await ui.key("\x1b[3~"); expect(ui.cancel).toHaveBeenLastCalledWith(15);
      for (let i = 0; i < 6; i++) await ui.key("\x1b[A");
      await ui.key("\x7f"); expect(ui.cancel).toHaveBeenLastCalledWith(10);
      for (let i = 0; i < 3; i++) await ui.key("\x7f");
      expect(ui.close).toHaveBeenCalled();
    } finally { ui.instance.unmount(); }
  });
  it("clicks the intended cancellation target without activating keyboard mode", async () => {
    const ui = await mount(false);
    try {
      // '  2. task1 ' occupies 11 cells; the sibling × is at column 12.
      await ui.key("\x1b[<0;12;3M\x1b[<0;12;3m");
      expect(ui.cancel).toHaveBeenCalledExactlyOnceWith(11);
      await ui.key("\x7f"); expect(ui.cancel).toHaveBeenCalledTimes(1);
    } finally { ui.instance.unmount(); }
  });
  it("Escape and Ctrl+Q return to the editor without cancelling requests", async () => {
    const ui = await mount();
    try {
      await ui.key("\x1b"); await ui.key("\x11");
      expect(ui.close).toHaveBeenCalledTimes(2);
      expect(ui.cancel).not.toHaveBeenCalled();
    } finally { ui.instance.unmount(); }
  });
});
