import { describe, expect, it, vi } from "vitest";

import { detachCommand } from "../commands/detach.js";
import { CommandRegistry, isCommandAllowedMidTurn } from "../commands/registry.js";
import { RESERVED_COMMAND_NAMES } from "../commands/reserved-names.js";
import type { CommandContext } from "../commands/types.js";

const createContext = (detachSession?: () => Promise<string>): CommandContext => ({
  detachSession,
  showStatus: vi.fn(),
  exit: vi.fn(),
} as unknown as CommandContext);

describe("commands/detach", () => {
  it("waits for detachment before showing the resume command and exiting", async () => {
    let complete!: (id: string) => void;
    const detachSession = vi.fn(() => new Promise<string>((resolve) => { complete = resolve; }));
    const context = createContext(detachSession);
    const result = detachCommand.execute("", context);

    expect(detachSession).toHaveBeenCalledOnce();
    expect(context.showStatus).not.toHaveBeenCalled();
    expect(context.exit).not.toHaveBeenCalled();

    complete("session-123");
    await expect(result).resolves.toEqual({ type: "exit" });
    expect(context.showStatus).toHaveBeenCalledWith(
      "Session session-123 is running in the background. Resume with: agav --resume session-123",
    );
    expect(context.exit).toHaveBeenCalledOnce();
    expect(vi.mocked(context.showStatus).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(context.exit).mock.invocationCallOrder[0]!,
    );
  });

  it.each([new Error("handoff failed"), "handoff failed"])("reports detach failures without exiting: %s", async (error) => {
    const context = createContext(vi.fn().mockRejectedValue(error));

    await expect(detachCommand.execute("", context)).resolves.toEqual({
      type: "message",
      text: "Failed to detach session: handoff failed",
    });
    expect(context.showStatus).not.toHaveBeenCalled();
    expect(context.exit).not.toHaveBeenCalled();
  });

  it("reports unsupported contexts without exiting", async () => {
    const context = createContext();

    await expect(detachCommand.execute("", context)).resolves.toEqual({
      type: "message",
      text: "Detaching sessions is not supported in this context.",
    });
    expect(context.exit).not.toHaveBeenCalled();
  });

  it("rejects arguments without detaching", async () => {
    const context = createContext(vi.fn());

    await expect(detachCommand.execute("extra", context)).resolves.toEqual({
      type: "message",
      text: "Usage: /detach",
    });
    expect(context.detachSession).not.toHaveBeenCalled();
    expect(context.exit).not.toHaveBeenCalled();
  });

  it("registers and reserves detach and allows it mid-turn without aliases", async () => {
    const registry = new CommandRegistry();
    const context = createContext(vi.fn().mockResolvedValue("session-123"));

    expect(registry.list().map((command) => command.name)).toContain("detach");
    expect(RESERVED_COMMAND_NAMES.has("detach")).toBe(true);
    expect(isCommandAllowedMidTurn("detach")).toBe(true);
    expect(isCommandAllowedMidTurn("DETACH")).toBe(true);
    expect(registry.list().map((command) => command.name)).not.toContain("background");
    expect(registry.list().map((command) => command.name)).not.toContain("detatch");
    await expect(registry.execute("/detach", context)).resolves.toEqual({ type: "exit" });
  });
});
