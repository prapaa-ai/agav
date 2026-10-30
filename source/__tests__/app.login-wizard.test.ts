import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import App from "../app.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";
import type { AgavConfig } from "../config/config.js";
import { signInWithApiKey } from "../account/account-login.js";
import { savePromptHistory } from "../config/prompt-history.js";

const boundary = vi.hoisted(() => ({ submit: vi.fn(), busy: false, prompt: undefined as any, confirmation: null, confirm: vi.fn() }));
vi.mock("../components/input-prompt.js", async original => {
  const actual = await original<typeof import("../components/input-prompt.js")>();
  return { default: (props: any) => { boundary.prompt = props; return h(actual.default, props); } };
});
vi.mock("../providers/registry.js", () => ({ createProvider: () => null }));
vi.mock("../config/prompt-history.js", () => ({ loadPromptHistory: async () => [], savePromptHistory: vi.fn() }));
vi.mock("../account/account-login.js", async original => ({
  ...await original<typeof import("../account/account-login.js")>(), signInWithApiKey: vi.fn(),
}));
vi.mock("../hooks/use-agent.js", () => ({ useAgent: () => ({
  messages: [], isLoading: boundary.busy, toolCalls: [], subagentStates: [], loadedPlugins: [], mcpServers: [],
  mcpPromptCommands: [], skillCommands: [], agentCommands: [], tokenUsage: { inputTokens: 0, outputTokens: 0 },
  pendingConfirmation: boundary.confirmation, confirmTool: boundary.confirm, conversation: { getMessages: () => [] }, submit: boundary.submit, cancel: vi.fn(),
}) }));

const config: AgavConfig = { provider: "anthropic", model: "mock", effort: "low", maxTokens: 1000, maxIterations: 2, errorRetries: 1, permissionMode: "ask" };
it("App isolates delayed cancelled paste from composer/history/model and forwards the service override", async () => {
  let output = "";
  const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 30,
    write: (s: string) => { output += s; return true; } }) as unknown as NodeJS.WriteStream;
  const stream = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
    setRawMode(value: boolean) { this.isRaw = value; return this; } });
  const instance = render(h(App, { config, keybindings: DEFAULT_KEYBINDINGS }), {
    stdout, stdin: stream as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false,
  });
  const settle = async () => { await new Promise(r => setTimeout(r, 100)); await instance.waitUntilRenderFlush(); };
  const key = async (text: string) => { stream.write(text); await settle(); };
  const secret = "agav_sk_APP_SECRET123456";
  vi.mocked(signInWithApiKey).mockResolvedValue({ accountId: "acct", email: null, status: "active" });
  try {
    await settle();
    await key("/login --account-service https://staging.example/base"); await key("\r");
    await key("2"); await key("\r");
    expect(output).toContain("Paste your Agav API key");
    await key("\x1b");
    await key("[200~" + secret); await key("\x03");
    await key("tail\x1b[20");
    expect(output).not.toContain(secret);
    await key("1~");
    expect(boundary.prompt.value).toBe("");
    expect(boundary.submit).not.toHaveBeenCalled();
    expect(signInWithApiKey).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(savePromptHistory).mock.calls)).not.toContain(secret);

    await key("/login --account-service https://staging.example/base"); await key("\r");
    await key("2"); await key("\r");
    await key("\x1b[200~" + secret + "\x1b[201~"); await key("\r");
    expect(signInWithApiKey).toHaveBeenCalledExactlyOnceWith(secret, {
      accountService: "https://staging.example/base", signal: expect.any(AbortSignal),
    });
    expect(output).not.toContain(secret);
    expect(boundary.submit).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(savePromptHistory).mock.calls)).not.toContain(secret);
  } finally {
    instance.unmount(); stream.end(); stream.destroy();
  }
});
