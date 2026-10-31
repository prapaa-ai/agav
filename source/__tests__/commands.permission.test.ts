import { describe, expect, it, vi } from "vitest";
import { permissionCommand } from "../commands/permission.js";
import type { CommandContext } from "../commands/types.js";
import type { PermissionMode } from "../config/config.js";

const createContext = (overrides: Partial<CommandContext> = {}): CommandContext => {
  return {
    config: { permissionMode: "ask" },
    getEffectivePermissionMode: () => "ask",
    setPermissionMode: vi.fn((mode: PermissionMode) => mode),
    ...overrides,
  } as unknown as CommandContext;
};

async function run(context: CommandContext, args = ""): Promise<string> {
  const result = await permissionCommand.execute(args, context);
  if (result.type !== "message") throw new Error("Expected message result");
  return result.text;
}

describe("commands/permission", () => {
  it("exposes expected metadata", () => {
    expect(permissionCommand.name).toBe("permission");
    expect(permissionCommand.description).toBeTruthy();
    expect(permissionCommand.usage).toContain("/permission");
  });

  it("shows the current (effective) mode and the available modes when called with no args", async () => {
    const context = createContext({ getEffectivePermissionMode: () => "deny-writes" });
    const text = await run(context);
    expect(text).toContain("Current permission mode: deny-writes");
    expect(text).toContain("ask");
    expect(text).toContain("auto-accept");
    expect(text).toContain("deny-writes");
    // The effective mode is marked.
    expect(text).toContain("* deny-writes");
  });

  it("prefers the live session mode over config when showing status", async () => {
    // config says "ask" but the session escalated to auto-accept.
    const context = createContext({
      config: { permissionMode: "ask" } as any,
      getEffectivePermissionMode: () => "auto-accept",
    });
    const text = await run(context);
    expect(text).toContain("Current permission mode: auto-accept");
  });

  it("rejects an invalid mode without calling setPermissionMode", async () => {
    const setPermissionMode = vi.fn((m: PermissionMode) => m);
    const context = createContext({ setPermissionMode });
    const text = await run(context, "yolo");
    expect(text).toContain("Invalid permission mode: yolo");
    expect(setPermissionMode).not.toHaveBeenCalled();
  });

  it("applies a valid mode change via setPermissionMode", async () => {
    const setPermissionMode = vi.fn((m: PermissionMode) => m);
    const context = createContext({ setPermissionMode });
    const text = await run(context, "deny-writes");
    expect(setPermissionMode).toHaveBeenCalledWith("deny-writes");
    expect(text).toContain("Permission mode changed to: deny-writes");
  });

  it("normalizes case before applying", async () => {
    const setPermissionMode = vi.fn((m: PermissionMode) => m);
    const context = createContext({ setPermissionMode });
    await run(context, "AUTO-ACCEPT");
    expect(setPermissionMode).toHaveBeenCalledWith("auto-accept");
  });

  it("reports the clamped mode when org policy enforces a stricter minimum", async () => {
    // Request auto-accept, but policy clamps it to ask.
    const setPermissionMode = vi.fn((_m: PermissionMode) => "ask" as PermissionMode);
    const context = createContext({ setPermissionMode });
    const text = await run(context, "auto-accept");
    expect(text).toContain("organization's policy enforces a minimum of ask");
    expect(text).toContain("Permission mode is now: ask");
  });

  it("explains the mode cannot be changed in headless mode (no setter available)", async () => {
    const context = createContext({ setPermissionMode: undefined });
    const text = await run(context, "auto-accept");
    expect(text).toContain("only available in an interactive session");
  });
});
