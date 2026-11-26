import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const watchers: Array<{ listener: (event: string, filename: string | null) => void; close: ReturnType<typeof vi.fn> }> = [];

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: vi.fn((_dir: string, _options: unknown, listener: (event: string, filename: string | null) => void) => {
    const watcher = { listener, close: vi.fn() };
    watchers.push(watcher);
    return watcher;
  }),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: vi.fn(),
}));

import { watch } from "node:fs";
import { execFile } from "node:child_process";
import { watchCommand } from "../commands/watch.js";
import type { CommandContext } from "../commands/types.js";

const DEBOUNCE_MS = 300;
const execFileMock = vi.mocked(execFile);
const watchMock = vi.mocked(watch);
const context = { showStatus: vi.fn() } as unknown as CommandContext;

const run = (args: string) => watchCommand.execute(args, context);
const latestWatcher = () => watchers[watchers.length - 1]!;
const commandsRun = () => execFileMock.mock.calls.map((call) => (call[1] as string[])[1]);

describe("/watch pending callbacks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    watchers.length = 0;
    execFileMock.mockClear();
  });

  afterEach(async () => {
    await run("stop");
    vi.useRealTimers();
  });

  it("does not run a pending callback after /watch stop", async () => {
    await run("source echo old");
    latestWatcher().listener("change", "a.ts");

    await run("stop");
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(commandsRun()).toEqual([]);
  });

  it("does not run the replaced watcher's pending callback, and the new watcher still fires once", async () => {
    await run("source echo old");
    const first = latestWatcher();
    first.listener("change", "a.ts");

    await run("source echo new");
    expect(first.close).toHaveBeenCalled();
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(commandsRun()).toEqual([]);

    latestWatcher().listener("change", "b.ts");
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(commandsRun()).toEqual(["echo new"]);
  });

  it("cancels the old pending callback when the replacement watcher fails to start", async () => {
    await run("source echo old");
    latestWatcher().listener("change", "a.ts");

    watchMock.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    const result = await run("missing echo new");
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(result).toMatchObject({ text: "Watch failed: ENOENT" });
    expect(commandsRun()).toEqual([]);
    expect(await run("")).toMatchObject({ text: expect.stringContaining("Watcher: Inactive") });
  });
});
