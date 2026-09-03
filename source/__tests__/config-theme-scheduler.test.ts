import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/fs.js", () => ({ ensureDir: vi.fn().mockResolvedValue(undefined) }));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn(), writeFile: vi.fn() }));
vi.mock("node:crypto", () => ({ default: { randomUUID: () => "12345678-aaaa-bbbb-cccc-1234567890ab" } }));

const fs = await import("node:fs/promises");
const readFile = vi.mocked(fs.readFile);
const writeFile = vi.mocked(fs.writeFile);

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

describe("scheduler process tasks", () => {
  beforeEach(() => {
    vi.resetModules();
    readFile.mockRejectedValue(new Error("missing"));
    writeFile.mockResolvedValue(undefined as never);
  });

  it("creates scheduled background process tasks", async () => {
    const { addScheduledProcessTask } = await import("../config/scheduler.js");

    const task = await addScheduledProcessTask("run tests", "0 9 * * *", "pnpm test", "C:/repo");

    expect(task).toMatchObject({
      id: "12345678",
      kind: "process",
      prompt: "pnpm test",
      command: "pnpm test",
      cwd: "C:/repo",
      cron: "0 9 * * *",
      enabled: true,
    });
    expect(writeFile).toHaveBeenCalledWith(expect.stringContaining("scheduled-tasks.json"), expect.stringContaining('"kind": "process"'));
  });
});
