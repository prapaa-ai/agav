import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgavConfig } from "../config/config.js";
import { main } from "../main.js";
import { loadConfig } from "../config/config.js";
import { render } from "../ink/index.js";

vi.mock("../config/config.js", async (original) => ({ ...await original<typeof import("../config/config.js")>(), loadConfig: vi.fn() }));
vi.mock("../config/keybindings.js", () => ({ loadKeybindings: async () => ({}) }));
vi.mock("../config/history.js", () => ({ listSessions: async () => [] }));
vi.mock("../ink/index.js", () => ({ render: vi.fn(() => ({ waitUntilExit: async () => { } })) }));
vi.mock("../utils/auto-update.js", () => ({ checkAndUpdate: async () => { } }));
vi.mock("../utils/git.js", () => ({ getGitContext: async () => null }));
vi.mock("../utils/terminal-keyboard.js", () => ({ detectKittyKeyboard: async () => false }));
vi.mock("../config/launch-state.js", () => ({ consumeChangelogDisplay: async () => true }));

const config: AgavConfig = { provider: "ollama", model: "test-model", systemPrompt: "test", effort: "low", maxTokens: 1000, maxIterations: 5, errorRetries: 0, permissionMode: "auto-accept" };
const originalArgv = process.argv;
const exited = new Error("process exited");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadConfig).mockResolvedValue({ ...config });
  process.argv = [process.execPath, "agav"];
  vi.spyOn(process, "exit").mockImplementation(() => { throw exited; });
  vi.spyOn(process, "stdout", "get").mockReturnValue({ write: vi.fn(() => true) } as unknown as typeof process.stdout);
  vi.spyOn(process, "stderr", "get").mockReturnValue({ write: vi.fn(() => true) } as unknown as typeof process.stderr);
  vi.spyOn(process, "stdin", "get").mockReturnValue({ isTTY: true } as typeof process.stdin);
  vi.spyOn(process, "on").mockImplementation(() => process);
});
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

describe("interactive changelog launch", () => {
  it("forwards the computed launch flag to App without dropping shutdownRef", async () => {
    await expect(main()).rejects.toBe(exited);

    const app = vi.mocked(render).mock.calls[0]![0];
    expect(app).toHaveProperty("props.showChangelogOnLaunch", true);
    expect(app).toHaveProperty("props.shutdownRef");
    expect((app as { props: { shutdownRef: { current: unknown } } }).props.shutdownRef.current).toBeNull();
  });
});
