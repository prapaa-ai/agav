import { describe, expect, it, vi } from "vitest";

import {
  CommandRegistry,
  MID_TURN_SAFE_COMMANDS,
  isCommandAllowedMidTurn,
} from "../commands/registry.js";
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
  suspendTerminal: vi.fn(() => vi.fn()),
  showAgentsTUI: vi.fn(),
  showSkillsTUI: vi.fn(),
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

describe("commands/registry mid-turn safety", () => {
  it("allows exit to run mid-turn so users can quit without waiting for idle", () => {
    // Regression guard: `exit` was previously dropped while a turn was in
    // flight, so /exit did nothing until the CLI was idle.
    expect(isCommandAllowedMidTurn("exit")).toBe(true);
  });

  it("allows the known mid-turn-safe commands", () => {
    expect(isCommandAllowedMidTurn("steer")).toBe(true);
    expect(isCommandAllowedMidTurn("help")).toBe(true);
    expect(isCommandAllowedMidTurn("loop")).toBe(true);
    expect(isCommandAllowedMidTurn("memory")).toBe(true);
    expect(isCommandAllowedMidTurn("remember")).toBe(true);
    expect(isCommandAllowedMidTurn("forget")).toBe(true);
    expect(isCommandAllowedMidTurn("context")).toBe(true);
  });

  it("is case-insensitive on the command name", () => {
    expect(isCommandAllowedMidTurn("EXIT")).toBe(true);
    expect(isCommandAllowedMidTurn("Steer")).toBe(true);
  });

  it("defers other commands until the agent is idle", () => {
    expect(isCommandAllowedMidTurn("model")).toBe(false);
    expect(isCommandAllowedMidTurn("clear")).toBe(false);
    expect(isCommandAllowedMidTurn("unknown-command")).toBe(false);
    expect(isCommandAllowedMidTurn("")).toBe(false);
  });

  it("only exposes commands that are actually registered", () => {
    const registry = new CommandRegistry();
    const registered = new Set(registry.list().map((command) => command.name));

    for (const name of MID_TURN_SAFE_COMMANDS) {
      expect(registered.has(name)).toBe(true);
    }
  });
});
