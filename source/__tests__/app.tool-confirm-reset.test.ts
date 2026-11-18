import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Ink from "../ink/ink.js";
import App from "../app.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";
import type { AgavConfig } from "../config/config.js";

const boundary = vi.hoisted(() => ({
  agent: undefined as ReturnType<typeof import("../hooks/use-agent.js").useAgent> | undefined,
  prompt: undefined as any,
}));
// The real hook and confirmation queue decide which prompt App shows.
vi.mock("../hooks/use-agent.js", async importOriginal => {
  const original = await importOriginal<typeof import("../hooks/use-agent.js")>();
  return { ...original, useAgent: (...args: Parameters<typeof original.useAgent>) => {
    boundary.agent = original.useAgent(...args);
    return boundary.agent;
  } };
});
// ToolConfirm still needs the module's helpers.
vi.mock("../components/input-prompt.js", async importOriginal => ({
  ...await importOriginal<typeof import("../components/input-prompt.js")>(),
  default: (props: any) => { boundary.prompt = props; return null; },
}));
vi.mock("../hooks/use-paste-handler.js", () => ({ useClipboardImageDetector: () => {} }));
vi.mock("../config/history.js", () => ({ saveSession: vi.fn(async () => "session") }));
vi.mock("../config/session-state.js", () => ({ saveSessionState: vi.fn(async () => {}) }));
vi.mock("../plugins/loader.js", () => ({ loadPlugins: async () => [] }));
vi.mock("../skills/loader.js", () => ({ loadSkills: async () => [], getCachedSkills: () => [] }));
vi.mock("../agents/loader.js", () => ({ loadAgents: async () => [], getCachedAgents: () => [], setCachedAgents: vi.fn() }));
vi.mock("../utils/system-prompt.js", () => ({ refreshStableContext: async () => "", refreshVolatileContext: async () => ({ context: "" }), formatTurnContext: () => "" }));
vi.mock("../agent/planner.js", () => ({ shouldAutoPlan: () => false, savePlan: vi.fn(async () => {}), loadPlan: async () => null, clearPlan: vi.fn(async () => {}), isPlanActive: () => false, setPlanScope: vi.fn(), adoptPlanScope: vi.fn(), prunePlans: async () => {}, formatPlanForPrompt: () => "", ensurePlanFile: async () => {} }));

const textOf = (node: any): string =>
  node?.nodeName === "#text" ? String(node.nodeValue ?? "") : (node?.childNodes ?? []).map(textOf).join("");

let instance: Ink | undefined;
afterEach(() => { instance?.unmount(); instance = undefined; boundary.prompt = undefined; });

async function mount() {
  const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 40, write: () => true }) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null }) as unknown as NodeJS.ReadStream;
  const config: AgavConfig = { provider: "anthropic", model: "mock", effort: "low", maxTokens: 1000, maxIterations: 2, errorRetries: 1, permissionMode: "ask" };
  instance = new Ink({ stdout, stdin, stderr: stdout, patchConsole: false, exitOnCtrlC: false, alternateScreen: false, maxFps: 30 });
  instance.render(h(App, { config, keybindings: DEFAULT_KEYBINDINGS }));
  await vi.waitFor(() => expect(boundary.prompt).toBeDefined());
  const screen = () => textOf((instance as any).rootNode);
  const type = async (text: string) => {
    stdin.emit("data", text);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await instance!.waitUntilRenderFlush();
  };
  return { screen, type };
}

describe("App confirmation prompts", () => {
  it.each([
    ["a different input", { path: "next.txt", content: "y" }],
    ["the same tool and input", { path: "first.txt", content: "x" }],
  ])("starts the next queued prompt with %s in normal mode with an empty editor", async (_name, nextInput) => {
    const { screen, type } = await mount();
    const withdraw = new AbortController();
    const first = boundary.agent!.requestConfirmation("write_file", { path: "first.txt", content: "x" }, withdraw.signal);
    const next = boundary.agent!.requestConfirmation("write_file", nextInput);
    await vi.waitFor(() => expect(screen()).toContain("[D]eny with feedback"));

    await type("d");
    await type("use the helper");
    expect(screen()).toContain("Feedback for agent");
    expect(screen()).toContain("use the helper");

    // the first prompt is withdrawn and the queue shows the next one in its place
    withdraw.abort();
    await expect(first).resolves.toBe("no");
    await type("");
    expect(screen()).not.toContain("use the helper");
    expect(screen()).not.toContain("Feedback for agent");
    expect(screen()).toContain("[D]eny with feedback");

    await type("d");
    await type("\r");
    await expect(next).resolves.toBe("no");
  });
});
