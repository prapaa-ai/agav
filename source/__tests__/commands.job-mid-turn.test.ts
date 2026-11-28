import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundJobError } from "../background-jobs/types.js";
import { jobCommand } from "../commands/job.js";
import type { CommandContext } from "../commands/types.js";

const coordinator = vi.hoisted(() => ({ stop: vi.fn() }));
vi.mock("../background-jobs-integration.js", () => ({ getSharedCoordinator: async () => coordinator }));

function context(isLoading: boolean): CommandContext {
  return {
    config: { permissionMode: "ask", backgroundJobsEnabled: true }, isLoading,
    confirmBackgroundAction: vi.fn(async () => true),
    showStatus: vi.fn(), setPickerActive: vi.fn(),
    showResourceTUI: vi.fn((_kind, done) => done()),
  } as unknown as CommandContext;
}

beforeEach(() => vi.clearAllMocks());

describe("mid-turn /job stop authorization", () => {
  it("passes inline consent through to the coordinator without opening a manager", async () => {
    const ctx = context(true);
    coordinator.stop.mockImplementation(async (_id, session) => {
      expect(session.permissionMode).toBe("ask");
      expect(await session.confirmBackgroundAction("stop", { command: "echo test" })).toBe(true);
      throw new BackgroundJobError("authorization-denied", "Background action rejected, cancelled, or changed.");
    });
    const result = await jobCommand.execute("stop abc", ctx);
    expect(coordinator.stop).toHaveBeenCalledWith("abc", expect.objectContaining({ confirmBackgroundAction: ctx.confirmBackgroundAction }));
    expect(ctx.confirmBackgroundAction).toHaveBeenCalledTimes(1);
    expect(ctx.showResourceTUI).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: "message", text: expect.stringContaining("rejected") });
  });

  it("returns approval instructions instead of opening the UI while busy", async () => {
    coordinator.stop.mockRejectedValue(new BackgroundJobError("authorization-denied", "Requires interactive confirmation; no existing grant."));
    const ctx = context(true);
    const result = await jobCommand.execute("stop abc", ctx);
    expect(result).toMatchObject({ type: "message", text: expect.stringContaining("Use the interactive /job manager") });
    expect(ctx.showResourceTUI).not.toHaveBeenCalled();
    expect(ctx.setPickerActive).not.toHaveBeenCalled();
  });

  it("retains the approval-manager fallback when idle", async () => {
    coordinator.stop.mockRejectedValue(new BackgroundJobError("authorization-denied", "Requires interactive confirmation; no existing grant."));
    const ctx = context(false);
    expect(await jobCommand.execute("stop abc", ctx)).toEqual({ type: "none" });
    expect(ctx.showResourceTUI).toHaveBeenCalledWith("jobs", expect.any(Function), false);
    expect(ctx.setPickerActive).toHaveBeenNthCalledWith(1, true);
    expect(ctx.setPickerActive).toHaveBeenLastCalledWith(false);
  });
});
