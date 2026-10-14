import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createElement } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Message } from "../providers/types.js";
import type { LLMProvider } from "../providers/types.js";

// Mock history directory to an isolated temp directory for persistence testing.
let tmpHistoryDir: string;
vi.mock("../config/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...original,
    getAgavDir: () => tmpHistoryDir,
  };
});

// Mock ancillary dependencies of useAgent
vi.mock("../config/session-state.js", () => ({ saveSessionState: vi.fn(async () => {}) }));
vi.mock("../plugins/loader.js", () => ({ loadPlugins: async () => [] }));
vi.mock("../skills/loader.js", () => ({ loadSkills: async () => [], getCachedSkills: () => [] }));
vi.mock("../skills/improvement.js", () => ({ maybeRunBackgroundImprovement: async () => {} }));
vi.mock("../agents/loader.js", () => ({ loadAgents: async () => [], getCachedAgents: () => [], setCachedAgents: vi.fn() }));
vi.mock("../utils/system-prompt.js", () => ({ refreshStableContext: async () => "", refreshVolatileContext: async () => ({ context: "" }), formatTurnContext: () => "" }));
vi.mock("../agent/planner.js", () => ({
  shouldAutoPlan: () => false,
  savePlan: vi.fn(async () => {}),
  loadPlan: async () => null,
  clearPlan: vi.fn(async () => {}),
  isPlanActive: () => false,
  setPlanScope: vi.fn(),
  adoptPlanScope: vi.fn(),
  prunePlans: async () => {},
  formatPlanForPrompt: () => "",
  ensurePlanFile: async () => {},
}));

import { saveSession, loadSession } from "../config/history.js";
import { resolveInitialSessionName } from "../config/startup.js";
import { useAgent } from "../hooks/use-agent.js";
import render from "../ink/render.js";

describe("session naming and persistence", () => {
  beforeEach(async () => {
    tmpHistoryDir = await mkdtemp(join(tmpdir(), "agav-history-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpHistoryDir, { recursive: true, force: true });
  });

  it("persists explicit session name in both name and title fields, taking precedence over automatic title", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Automatic prompt title that should be overridden" }],
      },
    ];

    const id = await saveSession(
      messages,
      "test-model",
      "test-provider",
      undefined,
      undefined,
      undefined,
      "My Explicit Run",
    );

    const record = await loadSession(id);
    expect(record).not.toBeNull();
    expect(record!.name).toBe("My Explicit Run");
    expect(record!.title).toBe("My Explicit Run");
  });

  it("falls back to automatic title generation when name is omitted and leaves name undefined", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Derive title from this prompt" }],
      },
    ];

    const id = await saveSession(
      messages,
      "test-model",
      "test-provider",
    );

    const record = await loadSession(id);
    expect(record).not.toBeNull();
    expect(record!.title).toBe("Derive title from this prompt");
    expect(record!.name).toBeUndefined();
  });

  it("propagates initialSessionName through useAgent to saveSession", async () => {
    const saveSessionSpy = vi.fn(saveSession);
    const provider: LLMProvider = { name: "mock", stream: vi.fn() as any };
    const config = {
      provider: "anthropic" as const,
      model: "mock",
      effort: "low" as const,
      maxTokens: 1000,
      maxIterations: 4,
      errorRetries: 1,
      permissionMode: "auto-accept" as const,
    };

    const stdout = new EventEmitter() as NodeJS.WriteStream;
    Object.assign(stdout, { isTTY: true, columns: 80, rows: 24, write: () => true });
    const stdin = new EventEmitter() as NodeJS.ReadStream;
    Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });

    let agentWithCustomName!: ReturnType<typeof useAgent>;
    function AppWithCustomName() {
      agentWithCustomName = useAgent(
        provider,
        config,
        undefined,
        undefined,
        undefined,
        undefined,
        "Custom Run Name",
      );
      return null;
    }

    const instance = render(createElement(AppWithCustomName), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
    await instance.waitUntilRenderFlush();

    expect(agentWithCustomName.sessionName).toBe("Custom Run Name");

    // Add a message and trigger saveNow
    agentWithCustomName.conversation.addUserMessage("Hello world");
    agentWithCustomName.saveNow();

    // Give asynchronous saveSession a tick to write
    await new Promise((r) => setTimeout(r, 50));
    instance.unmount();

    // Verify session was saved with the custom name
    expect(agentWithCustomName.sessionId).toBeDefined();
    const saved = await loadSession(agentWithCustomName.sessionId!);
    expect(saved).not.toBeNull();
    expect(saved!.name).toBe("Custom Run Name");
    expect(saved!.title).toBe("Custom Run Name");
  });

  it("preserves automatic title generation when useAgent has no initial session name", async () => {
    const provider: LLMProvider = { name: "mock", stream: vi.fn() as any };
    const config = {
      provider: "anthropic" as const,
      model: "mock",
      effort: "low" as const,
      maxTokens: 1000,
      maxIterations: 4,
      errorRetries: 1,
      permissionMode: "auto-accept" as const,
    };

    const stdout = new EventEmitter() as NodeJS.WriteStream;
    Object.assign(stdout, { isTTY: true, columns: 80, rows: 24, write: () => true });
    const stdin = new EventEmitter() as NodeJS.ReadStream;
    Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });

    let agentWithoutName!: ReturnType<typeof useAgent>;
    function AppWithoutName() {
      agentWithoutName = useAgent(provider, config);
      return null;
    }

    const instance = render(createElement(AppWithoutName), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
    await instance.waitUntilRenderFlush();

    expect(agentWithoutName.sessionName).toBeUndefined();

    agentWithoutName.conversation.addUserMessage("Auto title message");
    agentWithoutName.saveNow();

    await new Promise((r) => setTimeout(r, 50));
    instance.unmount();

    expect(agentWithoutName.sessionId).toBeDefined();
    const saved = await loadSession(agentWithoutName.sessionId!);
    expect(saved).not.toBeNull();
    expect(saved!.name).toBeUndefined();
    expect(saved!.title).toBe("Auto title message");
  });
});

describe("session naming startup resolution with resume", () => {
  it("uses explicit CLI name for new sessions", () => {
    expect(resolveInitialSessionName("My Run")).toBe("My Run");
  });

  it("trims leading and trailing whitespace from the CLI name", () => {
    expect(resolveInitialSessionName("  My Run  ")).toBe("My Run");
  });

  it("leaves session name undefined for new sessions when --name is omitted", () => {
    expect(resolveInitialSessionName(undefined)).toBeUndefined();
  });

  it("ignores empty or whitespace-only --name values for new sessions", () => {
    expect(resolveInitialSessionName("")).toBeUndefined();
    expect(resolveInitialSessionName("   ")).toBeUndefined();
  });

  it("does not rename an existing session when resuming — preserves the session's own name", () => {
    const resolved = resolveInitialSessionName(
      "Attempted Overwrite",
      { id: "session-1234", name: "Original Session Name" },
    );
    expect(resolved).toBe("Original Session Name");
  });

  it("does not assign a name to an unnamed session when resuming", () => {
    const resolved = resolveInitialSessionName(
      "Attempted Overwrite",
      { id: "session-5678", name: undefined },
    );
    expect(resolved).toBeUndefined();
  });
});

