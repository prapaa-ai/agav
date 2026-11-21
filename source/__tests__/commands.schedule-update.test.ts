import { beforeEach, expect, it, vi } from "vitest";
import { scheduleCommand } from "../commands/schedule.js";
import { updateScheduledTask } from "../config/scheduler.js";
import type { CommandContext } from "../commands/types.js";

vi.mock("../commands/resource-manager.js", () => ({ openResourceManager: vi.fn() }));
vi.mock("../config/scheduler.js", () => ({ updateScheduledTask: vi.fn() }));

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
