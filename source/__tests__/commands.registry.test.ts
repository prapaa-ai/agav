import { describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "../commands/registry.js";
import type { CommandContext, SlashCommand } from "../commands/types.js";

const createContext = (): CommandContext => ({
  conversation: {} as any,
  config: {} as any,
  setModel: vi.fn(),
  setProvider: vi.fn(),
  setEffort: vi.fn(),
  clearMessages: vi.fn(),
  refreshPlan: vi.fn(),
  showStatus: vi.fn(),
  saveSession: vi.fn(),
  refreshDisplay: vi.fn(),
  loadSession: vi.fn(),
  activateSession: vi.fn(),
  renameSession: vi.fn(),
  exit: vi.fn(),
  getDebugState: vi.fn(),
  submit: vi.fn(),
  handleSubmit: vi.fn(),
  toolRegistry: {} as any,
  addTokenUsage: vi.fn(),
  setRunningSkill: vi.fn(),
  setPickerActive: vi.fn(),
  showAgentsTUI: vi.fn(),
});

describe("commands/registry", () => {
  it("registers built-in commands and reports slash input", () => {
    const registry = new CommandRegistry();
    const names = registry.list().map((command) => command.name);

    expect(names).toContain("help");
    expect(names).toContain("skills");
    expect(names).toContain("steer");
    expect(registry.isCommand("/help")).toBe(true);
    expect(registry.isCommand("hello")).toBe(false);
  });

  it("returns null for non-command input", async () => {
    const registry = new CommandRegistry();

    await expect(registry.execute("hello world", createContext())).resolves.toBeNull();
  });

  it("returns an unknown-command message when command is missing", async () => {
    const registry = new CommandRegistry();

    const result = await registry.execute("/does-not-exist", createContext());

    expect(result).toEqual({
      type: "message",
      text: "Unknown command: /does-not-exist. Type /help for available commands.",
    });
  });

  it("dispatches to a registered command with parsed args", async () => {
    const registry = new CommandRegistry();
    const context = createContext();
    const execute = vi.fn(async (args: string) => ({ type: "message", text: `args=${args}` }));
    const customCommand: SlashCommand = {
      name: "custom-cmd",
      description: "custom",
      execute: execute as any,
    };

    registry.register(customCommand);

    const result = await registry.execute("/custom-cmd alpha beta", context);

    expect(execute).toHaveBeenCalledWith("alpha beta", context);
    expect(result).toEqual({ type: "message", text: "args=alpha beta" });
  });
});
