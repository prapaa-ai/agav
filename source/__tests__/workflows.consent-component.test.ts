import { EventEmitter } from "node:events";
import { createElement as h, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import Ink from "../ink/ink.js";
import { Box } from "../ink/index.js";
import type { DOMNode } from "../ink/dom.js";
import WorkflowConsent from "../components/workflow-consent.js";
import WorkflowToolConfirm from "../components/workflow-tool-confirm.js";
import type { ConsentRequest } from "../workflows/consent-prompt.js";

const request: ConsentRequest = { workflowName: "deploy", cwd: "/work", permissionMode: "ask", capabilities: { tools: ["write_file"], jobCommands: ["npm test"] }, envNames: ["AAA", "BBB", "CCC"] };

const textOf = (node: DOMNode): string => node.nodeName === "#text" ? node.nodeValue : node.childNodes.map(textOf).join("");
const findNode = (node: DOMNode, label: string): Exclude<DOMNode, { nodeName: "#text" }> | undefined => {
  if (node.nodeName === "#text") return;
  if (node.nodeName === "ink-text" && textOf(node).includes(label)) return node;
  for (const child of node.childNodes) {
    const found = findNode(child, label);
    if (found) return found;
  }
};
const report = (code: number, { x, y }: { x: number; y: number }, final = "M") => `\x1b[<${code};${x + 1};${y + 1}${final}`;
const press = (at: { x: number; y: number }) => report(0, at);
const release = (at: { x: number; y: number }) => report(0, at, "m");

async function mountPrompt(prompt: ReactNode, { columns = 120, rows = 30 } = {}) {
  let output = "";
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns, rows, write: (text: string) => { output += text; return true; } });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  const onOuterWheel = vi.fn();
  const instance = new Ink({ stdout, stderr: stdout, stdin, patchConsole: false, exitOnCtrlC: false, alternateScreen: false, maxFps: 30 });
  const settle = async () => { await new Promise(r => setTimeout(r, 40)); await instance.waitUntilRenderFlush(); };
  const render = async (next: ReactNode) => { instance.render(h(Box, { flexDirection: "column", onWheel: onOuterWheel }, next)); await settle(); };
  const key = async (text: string) => { stdin.emit("data", Buffer.from(text)); await settle(); };
  const frame = instance as unknown as { rootNode: DOMNode; frameScrollOffset: number };
  const cell = (label: string) => {
    const node = findNode(frame.rootNode, label);
    if (!node) throw new Error(`No text node matching ${label}`);
    return { x: node.internal_x!, y: node.internal_y! - frame.frameScrollOffset };
  };
  const click = (label: string, suffix = "") => {
    const at = cell(label);
    return key(press(at) + release(at) + suffix);
  };
  await render(prompt);
  return { instance, render, key, cell, click, onOuterWheel, screen: () => textOf(frame.rootNode), output: () => output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "") };
}

async function mount(current = request, size?: { columns: number; rows: number }) {
  const onDecide = vi.fn();
  return { ...await mountPrompt(h(WorkflowConsent, { request: current, onDecide }), size), onDecide };
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

describe("WorkflowConsent mouse controls", () => {
  it("toggles a clicked row without deciding and approves the latest selection exactly once", async () => {
    const ui = await mount();
    try {
      await ui.click("[ ] BBB");
      expect(ui.screen()).toContain("❯ [x] BBB");
      expect(ui.onDecide).not.toHaveBeenCalled();
      await ui.click("[x] BBB");
      expect(ui.screen()).toContain("❯ [ ] BBB");
      await ui.click("[ ] CCC", "y"); // No repaint between the release and approval.
      await ui.click("n/ESC: Deny");
      expect(ui.onDecide).toHaveBeenCalledExactlyOnceWith(["CCC"]);
    } finally { ui.instance.unmount(); }
  });

  it("focuses the hovered checklist row without checking it", async () => {
    const ui = await mount();
    try {
      await ui.key(report(35, ui.cell("[ ] CCC")));
      expect(ui.screen()).toContain("❯ [ ] CCC");
      expect(ui.screen()).toContain("0/3 selected");
      expect(ui.onDecide).not.toHaveBeenCalled();
      await ui.key(" ");
      await ui.key("\r");
      expect(ui.onDecide).toHaveBeenCalledExactlyOnceWith(["CCC"]);
    } finally { ui.instance.unmount(); }
  });

  it("moves and windows the checklist with the wheel without selecting or bubbling", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `VAR_${String(i).padStart(2, "0")}`);
    const ui = await mount({ ...request, envNames: names }, { columns: 120, rows: 18 });
    try {
      for (let i = 0; i < 8; i++) await ui.key(report(65, ui.cell(`❯ [ ] ${names[i]}`)));
      expect(ui.screen()).toContain("↑ 5 more");
      expect(ui.screen()).toContain("❯ [ ] VAR_08");
      expect(ui.screen()).toContain("0/12 selected");
      expect(ui.onOuterWheel).not.toHaveBeenCalled();
      expect(ui.onDecide).not.toHaveBeenCalled();
      await ui.key(report(64, ui.cell("❯ [ ] VAR_08")));
      await ui.key(" ");
      await ui.key("\r");
      expect(ui.onDecide).toHaveBeenCalledExactlyOnceWith(["VAR_07"]);
    } finally { ui.instance.unmount(); }
  });

  it("still offers explicit approval without an environment checklist", async () => {
    const ui = await mount({ ...request, envNames: [] });
    try {
      expect(ui.screen()).not.toContain("Space: Toggle");
      expect(ui.screen()).not.toContain("Always");
      await ui.click("y: Approve", "n");
      expect(ui.onDecide).toHaveBeenCalledExactlyOnceWith([]);
    } finally { ui.instance.unmount(); }
  });

  it("discards a press and selected names when a different request replaces the prompt", async () => {
    const ui = await mount();
    const next = vi.fn();
    try {
      await ui.key("a");
      await ui.key(press(ui.cell("y: Approve")));
      await ui.render(h(WorkflowConsent, { request: { ...request, workflowName: "next" }, onDecide: next }));
      await ui.key(release(ui.cell("y: Approve")));
      expect(next).not.toHaveBeenCalled();
      expect(ui.onDecide).not.toHaveBeenCalled();
      expect(ui.screen()).toContain("0/3 selected");
      await ui.click("n/ESC: Deny", "y");
      expect(next).toHaveBeenCalledExactlyOnceWith(undefined);
    } finally { ui.instance.unmount(); }
  });
});

describe("WorkflowToolConfirm", () => {
  async function mountTool(input: Record<string, unknown> = { path: "target.txt", content: "details" }) {
    const onConfirm = vi.fn();
    return { ...await mountPrompt(h(WorkflowToolConfirm, { toolName: "write_file", input, onConfirm })), onConfirm };
  }

  it.each([["y: Approve", true], ["n/ESC: Deny", false]] as const)("clicks %s as a one-shot decision", async (label, approved) => {
    const ui = await mountTool();
    try {
      expect(ui.screen()).toContain("Allow workflow tool write_file?");
      expect(ui.screen()).toContain("Single invocation only");
      expect(ui.screen()).not.toContain("Always");
      await ui.click(label, approved ? "n" : "y");
      expect(ui.onConfirm).toHaveBeenCalledExactlyOnceWith(approved);
    } finally { ui.instance.unmount(); }
  });

  it.each([["Y", true], ["N", false], ["\x03", false], ["\x1b", false]] as const)("honors shortcut %j and ignores later input", async (shortcut, approved) => {
    const ui = await mountTool();
    try {
      for (const ignored of ["\r", "a", "\x19"]) await ui.key(ignored); // Enter, Always, Ctrl+Y.
      expect(ui.onConfirm).not.toHaveBeenCalled();
      await ui.key(shortcut);
      if (shortcut === "\x1b") await new Promise(resolve => setTimeout(resolve, 80));
      await ui.key(approved ? "n" : "y");
      expect(ui.onConfirm).toHaveBeenCalledExactlyOnceWith(approved);
    } finally { ui.instance.unmount(); }
  });

  it("does not approve from drag, wheel, or click outside a control", async () => {
    const ui = await mountTool({ path: "target.txt", lines: Array.from({ length: 40 }, (_, i) => `line ${i}`) });
    try {
      const approve = ui.cell("y: Approve");
      const otherCell = { ...approve, x: approve.x + 1 };
      await ui.key(press(approve) + report(32, otherCell) + report(32, approve) + release(approve));
      await ui.key(press(approve) + report(65, approve) + release(approve));
      await ui.click("Single invocation only");
      expect(ui.onConfirm).not.toHaveBeenCalled();
      expect(ui.screen()).toContain("↑↓: inspect full inputs");
      await ui.click("y: Approve");
      expect(ui.onConfirm).toHaveBeenCalledExactlyOnceWith(true);
    } finally { ui.instance.unmount(); }
  });
});
