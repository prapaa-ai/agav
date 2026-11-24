import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { expect, it, vi } from "vitest";
import App from "../app.js";
import Ink from "../ink/ink.js";
import { useAgent } from "../hooks/use-agent.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";
import type { AgavConfig } from "../config/config.js";
import type { DisplayMessage } from "../components/message-list.js";
import { stripAnsi, visualLen } from "../utils/wrap-text.js";

vi.mock("../hooks/use-agent.js", () => ({ useAgent: vi.fn() }));
vi.mock("../providers/registry.js", () => ({ createProvider: () => null }));
vi.mock("../config/prompt-history.js", () => ({ loadPromptHistory: async () => [], savePromptHistory: vi.fn() }));

const config: AgavConfig = {
  provider: "anthropic", model: "mock", effort: "low", maxTokens: 1000,
  maxIterations: 2, errorRetries: 0, permissionMode: "ask",
};
const messages: DisplayMessage[] = Array.from({ length: 40 }, (_, i) => ({ id: String(i), role: "user", content: `Turn ${i}` }));

it.each([20, 80])("keeps notices below the composer and preserves scroll and typing at %i columns", async columns => {
  const stdout = Object.assign(new EventEmitter(), { columns, rows: 24, fd: 1, isTTY: true, write: () => true }) as unknown as typeof process.stdout;
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode: vi.fn(), resume: vi.fn(), pause: vi.fn(), read: () => null }) as unknown as NodeJS.ReadStream;
  const ink = new Ink({ stdout, stdin, stderr: stdout, patchConsole: false, exitOnCtrlC: false, alternateScreen: false, maxFps: 30 });
  const stdoutSpy = vi.spyOn(process, "stdout", "get").mockReturnValue(stdout);
  const state = { messages, toolCalls: [], subagentStates: [], loadedPlugins: [], mcpServers: [], mcpPromptCommands: [], skillCommands: [], agentCommands: [], tokenUsage: { inputTokens: 0, outputTokens: 0 }, error: null, mcpAuthWarning: null, mcpStartupWarnings: [] } as unknown as ReturnType<typeof useAgent>;
  const app = () => h(App, { config, keybindings: DEFAULT_KEYBINDINGS });
  const draw = (patch: Partial<typeof state> = {}) => {
    Object.assign(state, patch);
    vi.mocked(useAgent).mockReturnValue(state);
    ink.render(app());
  };
  const rows = () => stripAnsi((ink as unknown as { lastOutput: string }).lastOutput).split("\n");
  const turns = () => rows().filter(row => row.includes("Turn "));
  const key = (value: string) => stdin.emit("data", Buffer.from(value));
  try {
    draw();
    await vi.waitFor(() => expect(turns().join("\n")).toContain("Turn 39"));
    const bottom = turns();
    draw({ mcpAuthWarning: "Warning: Sign in to MCP" });
    await vi.waitFor(() => expect(rows().some(row => row.startsWith("Warning"))).toBe(true));
    expect(turns()).toEqual(bottom);
    key("\x1b[<64;2;4M");
    await vi.waitFor(() => expect(turns()).not.toEqual(bottom));
    key("draft");
    await vi.waitFor(() => expect(rows().some(row => row.includes("draft"))).toBe(true));
    const scrolled = turns();
    const height = rows().length;
    const error = `Provider timed out\n${"界".repeat(80)}\nReconnect.`;
    for (const text of [error, "Second error", error]) {
      draw({ error: text });
      await vi.waitFor(() => {
        const frame = rows();
        const row = frame.findIndex(line => line.startsWith("Error"));
        expect(row).toBeGreaterThan(frame.findIndex(line => line.includes("draft")));
        expect(frame[row]).toContain("/notices");
        expect(visualLen(frame[row]!)).toBeLessThanOrEqual(columns);
        if (columns === 80) expect(frame[row]).toContain(text.split("\n")[0]);
        expect(frame.length).toBe(height);
        expect(turns()).toEqual(scrolled);
      });
    }
    key("!");
    await vi.waitFor(() => expect(rows().some(row => row.includes("draft!"))).toBe(true));
    expect(turns()).toEqual(scrolled);
  } finally {
    ink.unmount();
    stdoutSpy.mockRestore();
  }
});
