import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import stringWidth from "string-width";
import { describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import { PermissionPicker } from "../components/permission-picker.js";
import type { PermissionMode } from "../config/config.js";

async function mount(current: PermissionMode = "ask", floor?: PermissionMode, columns = 100) {
  const chunks: string[] = [];
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns, rows: 40, write: (text: string) => { chunks.push(text); return true; } });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  const onDone = vi.fn();
  const instance = render(h(PermissionPicker, { current, floor, onDone }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 80)); await instance.waitUntilRenderFlush(); };
  await settle();
  const frame = () => chunks.map(text => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")).filter(text => /[a-z]/i.test(text)).at(-1) ?? "";
  const key = async (key: string) => { stdin.emit("data", Buffer.from(key)); await settle(); };
  const mouse = (label: string, button: number, suffix: "M" | "m" = "M") => {
    const lines = frame().split("\n");
    const row = lines.findIndex(line => line.includes(label));
    expect(row, `rendered position of ${label}`).toBeGreaterThanOrEqual(0);
    const line = lines[row]!;
    const column = stringWidth(line.slice(0, line.indexOf(label))) + 1;
    return `\x1b[<${button};${column};${row + 1}${suffix}`;
  };
  return {
    onDone, frame, key, mouse,
    click: async (label: string) => key(mouse(label, 0) + mouse(label, 0, "m")),
    stop: () => instance.unmount(),
  };
}

describe("PermissionPicker", () => {
  it("highlights the effective current mode and shows instructions", async () => {
    const ui = await mount("deny-writes");
    try {
      expect(ui.frame()).toContain("Session permissions");
      expect(ui.frame()).toContain("❯ deny-writes (current)");
      expect(ui.frame()).toContain("Enter Apply");
      expect(ui.frame()).toContain("Esc Cancel");
      expect(ui.frame()).toContain("saved for resume");
      await ui.key("\r");
      expect(ui.onDone).toHaveBeenCalledWith("deny-writes");
    } finally { ui.stop(); }
  });

  it("wraps navigation and warns before auto-accept without applying on navigation", async () => {
    const ui = await mount();
    try {
      await ui.key("\x1b[A");
      expect(ui.frame()).toContain("❯ deny-writes");
      await ui.key("\x1b[A");
      expect(ui.frame()).toContain("❯ auto-accept");
      expect(ui.frame()).toContain("Warning: sensitive tool actions will run without confirmation.");
      expect(ui.onDone).not.toHaveBeenCalled();
      await ui.key("\r\r");
      expect(ui.onDone).toHaveBeenCalledExactlyOnceWith("auto-accept");
    } finally { ui.stop(); }
  });

  it("shows organization restrictions and keeps blocked choices open", async () => {
    const ui = await mount("auto-accept", "ask");
    try {
      expect(ui.frame()).toContain("❯ ask (current)");
      expect(ui.frame()).toContain("Organization minimum: ask");
      expect(ui.frame()).toContain("auto-accept [blocked by organization]");
      await ui.key("\x1b[B");
      await ui.key("\r");
      expect(ui.onDone).not.toHaveBeenCalled();
      expect(ui.frame()).toContain("Blocked by organization policy");
      await ui.key("\x1b[B");
      await ui.key("\r");
      expect(ui.onDone).toHaveBeenCalledWith("deny-writes");
    } finally { ui.stop(); }
  });

  it("previews a mode by click, navigates by wheel, and applies only with the separate action", async () => {
    const ui = await mount();
    try {
      await ui.click("auto-accept");
      expect(ui.frame()).toContain("❯ auto-accept");
      expect(ui.frame()).toContain("Warning: sensitive tool actions");
      expect(ui.onDone).not.toHaveBeenCalled();
      await ui.key(ui.mouse("auto-accept", 65)); // wheel down over the list
      expect(ui.frame()).toContain("❯ deny-writes");
      expect(ui.onDone).not.toHaveBeenCalled();
      await ui.click("Enter Apply");
      expect(ui.onDone).toHaveBeenCalledExactlyOnceWith("deny-writes");
    } finally { ui.stop(); }
  });

  it("previews on pointer motion and applies that same row with Enter", async () => {
    const ui = await mount();
    try {
      await ui.key(ui.mouse("auto-accept", 35));
      expect(ui.frame()).toContain("❯ auto-accept");
      expect(ui.onDone).not.toHaveBeenCalled();
      await ui.key("\r");
      expect(ui.onDone).toHaveBeenCalledExactlyOnceWith("auto-accept");
    } finally { ui.stop(); }
  });

  it("enforces the organization floor on mouse Apply and lets the user cancel", async () => {
    const ui = await mount("ask", "ask");
    try {
      await ui.click("auto-accept [blocked by organization]");
      expect(ui.frame()).toContain("❯ auto-accept [blocked by organization]");
      await ui.click("Enter Apply");
      expect(ui.frame()).toContain("Blocked by organization policy");
      expect(ui.onDone).not.toHaveBeenCalled();
      await ui.click("Esc Cancel");
      expect(ui.onDone).toHaveBeenCalledExactlyOnceWith(undefined);
    } finally { ui.stop(); }
  });

  it.each(["\x1b", "\x03"])("cancels with %j without selecting a mode", async key => {
    const ui = await mount();
    try {
      await ui.key("\x1b[B");
      await ui.key(key);
      expect(ui.onDone).toHaveBeenCalledExactlyOnceWith(undefined);
    } finally { ui.stop(); }
  });

  it("renders usable labels in a narrow terminal", async () => {
    const ui = await mount("ask", undefined, 40);
    try {
      expect(ui.frame()).toContain("ask (current)");
      expect(ui.frame()).toContain("auto-accept");
      expect(ui.frame()).toContain("deny-writes");
      expect(ui.frame()).toContain("Enter Apply");
    } finally { ui.stop(); }
  });
});
