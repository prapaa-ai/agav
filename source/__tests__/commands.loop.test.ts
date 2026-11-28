import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLoopStatus, loopCommand, stopActiveLoop } from "../commands/loop.js";
import type { CommandContext } from "../commands/types.js";

describe("/loop intervals", () => {
  const handleSubmit = vi.fn();
  const context = { handleSubmit } as unknown as CommandContext;

  beforeEach(() => {
    handleSubmit.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopActiveLoop();
    vi.useRealTimers();
  });

  it.each(["25d", "2147484s"])("rejects %s without scheduling a timer", async (interval) => {
    const result = await loopCommand.execute(`${interval} summarize progress`, context);

    expect(result).toEqual({
      type: "message",
      text: expect.stringContaining("2,147,483,647 ms"),
    });
    expect(getLoopStatus()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the current loop running when a replacement interval is too long", async () => {
    await loopCommand.execute("5m check status", context);

    await loopCommand.execute("25d summarize progress", context);

    expect(getLoopStatus()).toMatchObject({ prompt: "check status", interval: "5m" });
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(5 * 60_000);
    expect(handleSubmit).toHaveBeenCalledExactlyOnceWith(
      "check status",
      expect.objectContaining({ source: "loop" }),
    );
  });

  it("accepts the largest supported whole-second interval", async () => {
    await loopCommand.execute("2147483s check status", context);

    vi.advanceTimersByTime(2_147_483_000 - 1);
    expect(handleSubmit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(handleSubmit).toHaveBeenCalledTimes(1);
  });

  it("uses ten minutes when the command contains only a prompt", async () => {
    await loopCommand.execute("check status", context);

    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(handleSubmit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(handleSubmit).toHaveBeenCalledTimes(1);
  });
});
