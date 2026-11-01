import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import WorkflowConsent from "../components/workflow-consent.js";
import type { ConsentRequest } from "../workflows/consent-prompt.js";

const request: ConsentRequest = { workflowName: "deploy", cwd: "/work", permissionMode: "ask", capabilities: { tools: ["write_file"], jobCommands: ["npm test"] }, envNames: ["AAA", "BBB", "CCC"] };

async function mount() {
  let output = "";
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 120, rows: 30, write: (text: string) => { output += text; return true; } });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  const onDecide = vi.fn();
  const instance = render(h(WorkflowConsent, { request, onDecide }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  const settle = async () => { await new Promise(r => setTimeout(r, 40)); await instance.waitUntilRenderFlush(); };
  const key = async (text: string) => { stdin.emit("data", Buffer.from(text)); await settle(); };
  await settle();
  return { instance, key, onDecide, output: () => output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "") };
}

describe("WorkflowConsent", () => {
  it("shows the capabilities and the shared confirmation footer", async () => {
    const ui = await mount();
    try {
      const out = ui.output();
      expect(out).toContain('Run workflow "deploy"');
      expect(out).toContain("/work");
      expect(out).toContain("Permission mode: ask");
      expect(out).toContain("write_file");
      expect(out).toContain("$ npm test");
      expect(out).toContain("y: Approve · n/ESC: Deny");
      expect(out).toContain("[ ] AAA");
    } finally { ui.instance.unmount(); }
  });

  it("toggles with space and arrows, then approves with Enter returning only the selected names", async () => {
    const ui = await mount();
    try {
      await ui.key(" ");       // AAA on
      await ui.key("\x1b[B");  // ↓
      await ui.key("\x1b[B");  // ↓ to CCC
      await ui.key(" ");       // CCC on
      await ui.key("\x1b[A");  // ↑ to BBB
      await ui.key(" ");       // BBB on
      await ui.key(" ");       // BBB off
      await ui.key("\r");
      expect(ui.onDecide).toHaveBeenCalledExactlyOnceWith(["AAA", "CCC"]);
    } finally { ui.instance.unmount(); }
  });

  it("a selects all, x deselects all, y approves", async () => {
    const ui = await mount();
    try {
      await ui.key("a");
      expect(ui.output()).toContain("3/3 selected");
      await ui.key("x");
      await ui.key(" ");
      await ui.key("y");
      expect(ui.onDecide).toHaveBeenCalledExactlyOnceWith(["AAA"]);
    } finally { ui.instance.unmount(); }
  });

  it("n and ESC deny", async () => {
    for (const deny of ["n", "\x1b"]) {
      const ui = await mount();
      try {
        await ui.key("a");
        await ui.key(deny);
        await new Promise(r => setTimeout(r, 80)); // a lone ESC is disambiguated after a short delay
        expect(ui.onDecide).toHaveBeenCalledExactlyOnceWith(undefined);
      } finally { ui.instance.unmount(); }
    }
  });
});
