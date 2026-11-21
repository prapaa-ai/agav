import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ScheduledTask } from "../config/scheduler.js";

vi.mock("../config/scheduler.js", () => ({
  loadScheduledTasks: vi.fn(),
  addScheduledTask: vi.fn(),
  removeScheduledTask: vi.fn(),
  setTaskEnabled: vi.fn(),
  markTaskRun: vi.fn(),
  findScheduledTask: (tasks: ScheduledTask[], id: string) =>
    tasks.find((t) => t.id === id) ?? tasks.find((t) => t.id.startsWith(id)),
}));

import { scheduleCommand } from "../commands/schedule.js";
import type { CommandContext } from "../commands/types.js";
import {
  loadScheduledTasks,
  markTaskRun,
  setTaskEnabled,
  addScheduledTask,
} from "../config/scheduler.js";

const loadTasks = vi.mocked(loadScheduledTasks);
const markRun = vi.mocked(markTaskRun);

/** A scheduled task; only the fields `/schedule run` reads are set. */
function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "abc12345",
    name: "morning review",
    prompt: "review counter.py for TODO comments",
    cron: "0 9 * * 1-5",
    enabled: true,
    createdAt: "2026-11-21T00:00:00.000Z",
    ...overrides,
  };
}

/** Context with a spied submit path; the command only touches handleSubmit. */
function createContext(): { context: CommandContext; handleSubmit: ReturnType<typeof vi.fn> } {
  const handleSubmit = vi.fn();
  return {
    context: { handleSubmit } as unknown as CommandContext,
    handleSubmit,
  };
}

describe("commands/schedule run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs an enabled task once through the schedule submit path", async () => {
    const { context, handleSubmit } = createContext();
    const t = task();
    loadTasks.mockResolvedValue([t]);

    const result = await scheduleCommand.execute("run abc12345", context);

    expect(result.type).toBe("message");
    if (result.type === "message") {
      expect(result.text).toContain("Running scheduled task abc12345 now");
      expect(result.text).toContain("Schedule and enabled state unchanged");
    }
    expect(handleSubmit).toHaveBeenCalledTimes(1);
    expect(handleSubmit).toHaveBeenCalledWith("review counter.py for TODO comments", {
      source: "schedule",
      detail: expect.stringContaining("abc12345"),
    });
    expect(markRun).toHaveBeenCalledTimes(1);
    expect(markRun).toHaveBeenCalledWith("abc12345");
    // Only the last-run stamp moves: nothing else about the task is rewritten.
    expect(setTaskEnabled).not.toHaveBeenCalled();
    expect(addScheduledTask).not.toHaveBeenCalled();
  });

  it("runs a disabled task too, without re-enabling it", async () => {
    const { context, handleSubmit } = createContext();
    loadTasks.mockResolvedValue([task({ enabled: false })]);

    const result = await scheduleCommand.execute("run abc12345", context);

    expect(result.type).toBe("message");
    expect(handleSubmit).toHaveBeenCalledTimes(1);
    expect(markRun).toHaveBeenCalledWith("abc12345");
    expect(setTaskEnabled).not.toHaveBeenCalled();
  });

  it("matches a task by id prefix, like remove/enable/disable", async () => {
    const { context, handleSubmit } = createContext();
    loadTasks.mockResolvedValue([task()]);

    await scheduleCommand.execute("run abc", context);

    expect(handleSubmit).toHaveBeenCalledTimes(1);
    expect(markRun).toHaveBeenCalledWith("abc12345");
  });

  it("reports a missing task and submits nothing", async () => {
    const { context, handleSubmit } = createContext();
    loadTasks.mockResolvedValue([task()]);

    const result = await scheduleCommand.execute("run nope", context);

    expect(result.type).toBe("message");
    if (result.type === "message") expect(result.text).toContain("Task nope not found.");
    expect(handleSubmit).not.toHaveBeenCalled();
    expect(markRun).not.toHaveBeenCalled();
  });

  it("asks for an id when none is given", async () => {
    const { context, handleSubmit } = createContext();

    const result = await scheduleCommand.execute("run", context);

    expect(result.type).toBe("message");
    if (result.type === "message") expect(result.text).toContain("Usage: /schedule run <id>");
    expect(handleSubmit).not.toHaveBeenCalled();
    expect(markRun).not.toHaveBeenCalled();
  });

  it("does not update last-run metadata when the submission is refused", async () => {
    const { context, handleSubmit } = createContext();
    loadTasks.mockResolvedValue([task()]);
    handleSubmit.mockImplementation(() => {
      throw new Error("turn already running");
    });

    const result = await scheduleCommand.execute("run abc12345", context);

    expect(result.type).toBe("message");
    if (result.type === "message") expect(result.text).toContain("Could not run scheduled task abc12345");
    expect(markRun).not.toHaveBeenCalled();
  });

  it("advertises run in its usage", () => {
    expect(scheduleCommand.usage).toContain("/schedule run <id>");
  });
});
