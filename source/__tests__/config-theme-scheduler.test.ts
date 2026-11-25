import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/fs.js", () => ({ ensureDir: vi.fn().mockResolvedValue(undefined) }));
vi.mock("node:fs/promises", () => ({
  open: vi.fn().mockResolvedValue({ writeFile: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) }),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("node:crypto", () => ({ default: { randomUUID: () => "12345678-aaaa-bbbb-cccc-1234567890ab" } }));

const fs = await import("node:fs/promises");
const readFile = vi.mocked(fs.readFile);
const writeFile = vi.mocked(fs.writeFile);
const rename = vi.mocked(fs.rename);
const unlink = vi.mocked(fs.unlink);

describe("theme", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns and updates current theme", async () => {
    const mod = await import("../config/theme.js");
    const base = mod.getTheme();
    expect(base.userLabel).toBe("blue");

    const updated = mod.loadTheme({ userLabel: "cyan", bannerColor: "white" });
    expect(updated.userLabel).toBe("cyan");
    expect(mod.getTheme().bannerColor).toBe("white");
  });
});

describe("scheduler cronMatches", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("matches wildcards, lists, ranges, and steps", async () => {
    const { cronMatches } = await import("../config/scheduler.js");
    const date = new Date(2024, 0, 8, 10, 15, 0);
    const m = date.getMinutes();
    const h = date.getHours();
    const dom = date.getDate();
    const mon = date.getMonth() + 1;
    const dow = date.getDay();

    expect(cronMatches("* * * * *", date)).toBe(true);
    expect(cronMatches(`${m} ${h} ${dom} ${mon} ${dow}`, date)).toBe(true);
    expect(cronMatches(`*/15 ${h} * * *`, new Date(2024, 0, 8, h, 30, 0))).toBe(true);
    expect(cronMatches("0 0 * * *", new Date(2024, 0, 8, 0, 0, 0))).toBe(true);
    expect(cronMatches("59 23 * * *", new Date(2024, 0, 8, 23, 59, 0))).toBe(true);
  });

  it("starts day-of-month and month wildcard steps at 1", async () => {
    const { cronMatches } = await import("../config/scheduler.js");
    const cron = "0 9 */2 */2 *";
    expect(cronMatches(cron, new Date(2026, 0, 1, 9))).toBe(true);
    expect(cronMatches(cron, new Date(2026, 2, 3, 9))).toBe(true);
    expect(cronMatches(cron, new Date(2026, 0, 2, 9))).toBe(false);
    expect(cronMatches(cron, new Date(2026, 1, 1, 9))).toBe(false);
  });

  it("rejects invalid cron expressions and out-of-range fields", async () => {
    const { cronMatches } = await import("../config/scheduler.js");
    const date = new Date(2024, 0, 8, 10, 15, 0);

    expect(cronMatches("* * * *", date)).toBe(false);
    expect(cronMatches("61 * * * *", date)).toBe(false);
    expect(cronMatches("15 25 * * *", date)).toBe(false);
    expect(cronMatches("15 10 40 * *", date)).toBe(false);
    expect(cronMatches("15 10 * 13 *", date)).toBe(false);
    expect(cronMatches("15 10 * * 7", date)).toBe(false);
  });
});
describe("scheduled task persistence", () => {
  const task = { id: "task-01", name: "daily", cron: "0 9 * * *", prompt: "old", enabled: false, createdAt: "2026-01-01", lastRunAt: "2026-01-02" };
  beforeEach(() => {
    readFile.mockReset().mockResolvedValue(JSON.stringify([task]));
    writeFile.mockReset().mockResolvedValue(undefined);
    rename.mockReset().mockResolvedValue(undefined);
    unlink.mockClear();
  });

  it("persists changes without resetting the ID or run metadata", async () => {
    const { updateScheduledTask } = await import("../config/scheduler.js");
    const expected = { ...task, cron: "15 10 * * *", prompt: "new text" };
    expect(await updateScheduledTask(task.id, { cron: expected.cron, prompt: expected.prompt })).toEqual(expected);
    expect(JSON.parse(String(writeFile.mock.calls[0]?.[1]))).toEqual([expected]);
    expect(rename).toHaveBeenCalledWith(writeFile.mock.calls[0]?.[0], expect.stringMatching(/scheduled-tasks\.json$/));
  });

  it("does not write for invalid arguments or unknown IDs", async () => {
    const { updateScheduledTask } = await import("../config/scheduler.js");
    await expect(updateScheduledTask(task.id, { cron: "61 9 * * *", prompt: "do not save" })).rejects.toThrow("Invalid cron");
    await expect(updateScheduledTask(task.id, { prompt: " " })).rejects.toThrow("empty");
    await expect(updateScheduledTask(task.id, {})).rejects.toThrow("Specify a cron expression or prompt");
    expect(await updateScheduledTask("missing", { prompt: "new" })).toBeUndefined();
    expect(await updateScheduledTask("", { prompt: "new" })).toBeUndefined();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("resolves exact IDs before prefixes, and allows a unique prefix", async () => {
    const { updateScheduledTask } = await import("../config/scheduler.js");
    const longer = { ...task, id: `${task.id}-longer` };
    readFile.mockResolvedValue(JSON.stringify([longer, task]));
    expect(await updateScheduledTask(task.id, { prompt: "exact" })).toEqual({ ...task, prompt: "exact" });
    expect(await updateScheduledTask(`${task.id}-l`, { prompt: "unique" })).toEqual({ ...longer, prompt: "unique" });
  });

  it("rejects ambiguous update prefixes without writing", async () => {
    const { updateScheduledTask } = await import("../config/scheduler.js");
    readFile.mockResolvedValue(JSON.stringify([task, { ...task, id: "task-02" }]));
    await expect(updateScheduledTask("task", { prompt: "new" })).rejects.toThrow(/Ambiguous.*"task".*full task ID/);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("keeps first-prefix behavior for remove, enable and mark-run", async () => {
    const { markTaskRun, removeScheduledTask, setTaskEnabled } = await import("../config/scheduler.js");
    const other = { ...task, id: "task-02" };
    readFile.mockResolvedValue(JSON.stringify([task, other]));
    expect(await setTaskEnabled("task", true)).toBe(true);
    await markTaskRun("task");
    expect(await removeScheduledTask("task")).toBe(true);
    const [enabled, ran, removed] = writeFile.mock.calls.map(([, json]) => JSON.parse(String(json)));
    expect(enabled).toEqual([{ ...task, enabled: true }, other]);
    expect(ran).toEqual([{ ...task, lastRunAt: expect.any(String) }, other]);
    expect(ran[0].lastRunAt).not.toBe(task.lastRunAt);
    expect(removed).toEqual([other]);
  });

  it("handles wildcard and bounded range steps with the same validation as updates", async () => {
    const { updateScheduledTask, cronMatches } = await import("../config/scheduler.js");
    const cron = "*/15 9 * * *";
    const updated = await updateScheduledTask(task.id, { cron });
    expect(updated).toEqual({ ...task, cron });
    expect(cronMatches(cron, new Date(2026, 0, 1, 9, 30))).toBe(true);
    expect(cronMatches(cron, new Date(2026, 0, 1, 9, 31))).toBe(false);
    expect(cronMatches("10-20/5 9 * * *", new Date(2026, 0, 1, 9, 25))).toBe(false);
  });

  it("keeps prompt whitespace and removes the temporary file if replacement fails", async () => {
    const { updateScheduledTask } = await import("../config/scheduler.js");
    const prompt = "  new  ";
    expect(await updateScheduledTask(task.id, { prompt })).toEqual({ ...task, prompt });
    rename.mockRejectedValueOnce(new Error("disk failure"));
    await expect(updateScheduledTask(task.id, { prompt })).rejects.toThrow("disk failure");
    expect(unlink).toHaveBeenCalledWith(writeFile.mock.calls.at(-1)?.[0]);
  });

  it.each([
    ["* * * *", "test", /Invalid cron/],
    ["0 9 * 13 *", "test", /Invalid cron/],
    ["0 9 */0 * *", "test", /Invalid cron/],
    ["0 9 * * *", " \t\n", /empty/],
  ] as const)("rejects invalid adds before reading or writing (%s, %j)", async (cron, prompt, error) => {
    const { addScheduledTask } = await import("../config/scheduler.js");
    await expect(addScheduledTask("daily", cron, prompt)).rejects.toThrow(error);
    expect(readFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("does not replace an unreadable or malformed scheduler file", async () => {
    const { addScheduledTask } = await import("../config/scheduler.js");
    readFile.mockRejectedValueOnce(Object.assign(new Error("cannot read"), { code: "EIO" }));
    readFile.mockResolvedValueOnce("{");
    readFile.mockResolvedValueOnce("{}");
    await expect(addScheduledTask("daily", "0 9 * * *", "hello")).rejects.toThrow("cannot read");
    await expect(addScheduledTask("daily", "0 9 * * *", "hello")).rejects.toThrow(SyntaxError);
    await expect(addScheduledTask("daily", "0 9 * * *", "hello")).rejects.toThrow("Expected a list");
    expect(writeFile).not.toHaveBeenCalled();
  });
});
