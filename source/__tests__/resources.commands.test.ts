import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../config/memory.js", () => ({ loadMemories: vi.fn(async () => []), saveMemory: vi.fn(), deleteMemory: vi.fn(async () => true), deleteAllMemories: vi.fn(), getProjectMemoryPath: vi.fn() }));
vi.mock("../config/scheduler.js", () => ({ loadScheduledTasks: vi.fn(async () => []), addScheduledTask: vi.fn(async () => ({ id: "task" })), removeScheduledTask: vi.fn(async () => true), setTaskEnabled: vi.fn(async () => true) }));
vi.mock("../config/history.js", () => ({ listSessions: vi.fn(async () => []), loadSession: vi.fn(), renameSession: vi.fn(), deleteSession: vi.fn() }));
vi.mock("../skills/loader.js", () => ({ loadAllSkills: vi.fn(async () => []), getSkill: vi.fn() }));
vi.mock("../agents/loader.js", () => ({ loadAgents: vi.fn(async () => []), setCachedAgents: vi.fn() }));
import { CommandRegistry } from "../commands/registry.js";
import { openResourceManager } from "../commands/resource-manager.js";
import type { CommandContext } from "../commands/types.js";
import { saveMemory, deleteMemory } from "../config/memory.js";
import { addScheduledTask, removeScheduledTask, setTaskEnabled } from "../config/scheduler.js";

const context = (interactive: boolean, isLoading = false) => ({
  isLoading,
  setPickerActive: vi.fn(),
  showResourceTUI: interactive ? vi.fn((_kind, done) => done()) : undefined,
} as unknown as CommandContext);

beforeEach(() => vi.clearAllMocks());

describe("resource command compatibility", () => {
  it.each(["agents", "skills", "memory", "schedule", "history", "search-history", "search"])("opens /%s only through the interactive app hook", async (name) => {
    const ctx = context(true);
    expect(await new CommandRegistry().execute(`/${name}`, ctx)).toEqual({ type: "none" });
    expect(ctx.showResourceTUI).toHaveBeenCalledWith(name === "search" ? "search-history" : name, expect.any(Function), false);
    expect(ctx.setPickerActive).toHaveBeenNthCalledWith(1, true);
    expect(ctx.setPickerActive).toHaveBeenLastCalledWith(false);
    const nonInteractive = context(false);
    expect(await new CommandRegistry().execute(`/${name}`, nonInteractive)).toMatchObject({ type: "message" });
    expect(nonInteractive.setPickerActive).not.toHaveBeenCalled();
  });

  it.each(["skills", "memory", "schedule", "history", "agents"])("keeps /%s list textual even in interactive mode", async (name) => {
    const ctx = context(true);
    expect(await new CommandRegistry().execute(`/${name} list`, ctx)).toMatchObject({ type: "message" });
    expect(ctx.showResourceTUI).not.toHaveBeenCalled();
  });

  it("preserves memory add/delete and their aliases", async () => {
    const registry = new CommandRegistry();
    const ctx = context(true);
    expect(await registry.execute("/memory add prefer tabs", ctx)).toMatchObject({ type: "message", text: "Saved memory: prefer-tabs" });
    expect(saveMemory).toHaveBeenCalledWith({ name: "prefer-tabs", description: "prefer tabs", type: "feedback", content: "prefer tabs" });
    await registry.execute("/remember always test", ctx);
    await registry.execute("/memory delete prefer-tabs", ctx);
    await registry.execute("/forget always-test", ctx);
    expect(deleteMemory).toHaveBeenCalledWith("prefer-tabs");
    expect(deleteMemory).toHaveBeenCalledWith("always-test");
    expect(ctx.showResourceTUI).not.toHaveBeenCalled();
  });

  it("preserves schedule add/remove/enable/disable", async () => {
    const registry = new CommandRegistry();
    const ctx = context(true);
    await registry.execute('/schedule add "0 9 * * *" run tests', ctx);
    expect(addScheduledTask).toHaveBeenCalledWith("run tests", "0 9 * * *", "run tests");
    await registry.execute("/schedule remove task", ctx);
    expect(removeScheduledTask).toHaveBeenCalledWith("task");
    await registry.execute("/schedule enable task", ctx);
    await registry.execute("/schedule disable task", ctx);
    expect(setTaskEnabled).toHaveBeenCalledWith("task", true);
    expect(setTaskEnabled).toHaveBeenCalledWith("task", false);
    expect(ctx.showResourceTUI).not.toHaveBeenCalled();
  });

  it("preserves /search query and /search-history query text results", async () => {
    const ctx = context(true);
    for (const name of ["search", "search-history"]) {
      expect(await new CommandRegistry().execute(`/${name} OAuth`, ctx)).toEqual({ type: "message", text: 'No sessions matching "oauth".' });
    }
    expect(ctx.showResourceTUI).not.toHaveBeenCalled();
  });

  it("does not open a mid-turn memory overlay", async () => {
    const ctx = context(true, true);
    expect(await new CommandRegistry().execute("/memory", ctx)).toMatchObject({ type: "message" });
    expect(ctx.showResourceTUI).not.toHaveBeenCalled();
  });

  it("gates marketplace browsing in headless mode", async () => {
    const registry = new CommandRegistry();
    const ctx = context(true);
    expect(await registry.execute("/skills marketplace", ctx)).toEqual({ type: "none" });
    expect(ctx.showResourceTUI).toHaveBeenCalledWith("skills", expect.any(Function), true);
    expect(await registry.execute("/skills marketplace", context(false))).toMatchObject({ type: "message", text: expect.stringContaining("interactive terminal") });
  });

  it("restores picker state when opening the overlay fails", async () => {
    const ctx = context(true);
    vi.mocked(ctx.showResourceTUI!).mockImplementation(() => { throw new Error("render failed"); });
    await expect(openResourceManager("memory", ctx)).rejects.toThrow("render failed");
    expect(ctx.setPickerActive).toHaveBeenLastCalledWith(false);
  });
});
