import { describe, expect, it, vi } from "vitest";
import { effortCommand } from "../commands/effort.js";
import type { CommandContext } from "../commands/types.js";
import { EFFORT_LEVELS } from "../config/config.js";

function createContext(initialEffort = "high"): CommandContext {
  return {
    config: {
      effort: initialEffort as any,
    } as any,
    setEffort: vi.fn(),
  } as unknown as CommandContext;
}

describe("commands/effort", () => {
  it("shows the current effort level when invoked without arguments", async () => {
    const context = createContext("high");
    const result = await effortCommand.execute("", context);

    expect(result.type).toBe("message");
    if (result.type !== "message") throw new Error("expected message result");
    expect(result.text).toBe("Current effort: high");
    expect(context.setEffort).not.toHaveBeenCalled();
  });

  it("updates effort to minimal and confirms the change", async () => {
    const context = createContext("high");
    const result = await effortCommand.execute("minimal", context);

    expect(result.type).toBe("message");
    if (result.type !== "message") throw new Error("expected message result");
    expect(result.text).toBe("Effort changed to: minimal");
    expect(context.setEffort).toHaveBeenCalledWith("minimal");
  });

  it.each(EFFORT_LEVELS)("accepts valid effort level '%s'", async (level) => {
    const context = createContext("medium");
    const result = await effortCommand.execute(level, context);

    expect(result.type).toBe("message");
    if (result.type !== "message") throw new Error("expected message result");
    expect(result.text).toBe(`Effort changed to: ${level}`);
    expect(context.setEffort).toHaveBeenCalledWith(level);
  });

  it("rejects invalid effort levels with usage guidance", async () => {
    const context = createContext("medium");
    const result = await effortCommand.execute("super-ultra", context);

    expect(result.type).toBe("message");
    if (result.type !== "message") throw new Error("expected message result");
    expect(result.text).toContain("Invalid effort level: super-ultra");
    expect(result.text).toContain(EFFORT_LEVELS.join(", "));
    expect(context.setEffort).not.toHaveBeenCalled();
  });
});
