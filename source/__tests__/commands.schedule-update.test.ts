import { beforeEach, expect, it, vi } from "vitest";
import { CommandRegistry } from "../commands/registry.js";
import { scheduleCommand } from "../commands/schedule.js";
import { addScheduledTask, updateScheduledTask } from "../config/scheduler.js";
import type { CommandContext } from "../commands/types.js";

vi.mock("../commands/resource-manager.js", () => ({ openResourceManager: vi.fn() }));
vi.mock("../config/scheduler.js", () => ({ updateScheduledTask: vi.fn(), addScheduledTask: vi.fn() }));

const update = vi.mocked(updateScheduledTask);
const context = {} as CommandContext;
beforeEach(() => update.mockReset());

it.each([
  ['--cron "0 10 * * *"', { cron: "0 10 * * *", prompt: undefined }],
  ["--prompt  new  prompt  ", { cron: undefined, prompt: " new  prompt  " }],
  ['--cron "0 10 * * *" --prompt new prompt', { cron: "0 10 * * *", prompt: "new prompt" }],
])("passes the declared patch for %s", async (args, expected) => {
  await scheduleCommand.execute(`update task-01 ${args}`, context);
  expect(update).toHaveBeenCalledWith("task-01", expected);
});

it("rejects missing options before writing", async () => {
  expect(await scheduleCommand.execute("update task-01 --prompt", context))
    .toMatchObject({ type: "message", text: expect.stringMatching(/^Usage:/) });
  expect(update).not.toHaveBeenCalled();
});


it("preserves prompt whitespace through command dispatch", async () => {
  await new CommandRegistry().execute("/schedule UPDATE task --prompt  first  line\nsecond  ", context);
  expect(update).toHaveBeenCalledWith("task", { cron: undefined, prompt: " first  line\nsecond  " });
});

it("supports a quoted prompt before the cron flag", async () => {
  await scheduleCommand.execute('update task --prompt "first  line" --cron "0 10 * * *"', context);
  expect(update).toHaveBeenCalledWith("task", { cron: "0 10 * * *", prompt: "first  line" });
});

it("rejects an unquoted prompt before a cron flag instead of saving the flags as text", async () => {
  expect(await scheduleCommand.execute('update task --prompt a prompt --cron "0 10 * * *"', context))
    .toMatchObject({ text: expect.stringMatching(/^Usage:/) });
  expect(update).not.toHaveBeenCalled();
});

it("reports invalid cron when adding a task", async () => {
  vi.mocked(addScheduledTask).mockRejectedValueOnce(new Error("Invalid cron expression"));
  expect(await scheduleCommand.execute('add "99 10 * * *" run checks', context))
    .toMatchObject({ text: "Invalid cron expression" });
});
