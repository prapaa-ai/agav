import { beforeEach, describe, expect, it } from "vitest";

import { clearSteers, formatSteersForPrompt, getActiveSteers, steerCommand } from "../commands/steer.js";

describe("commands/steer", () => {
  beforeEach(() => {
    clearSteers();
  });

  it("returns empty prompt block when there are no steers", () => {
    expect(getActiveSteers()).toEqual([]);
    expect(formatSteersForPrompt()).toBe("");
  });

  it("adds steers and formats them for prompt and listing", async () => {
    const addResult = await steerCommand.execute("Focus on tests", {} as any);
    const listResult = await steerCommand.execute("list", {} as any);

    expect(addResult).toEqual({
      type: "message",
      text: 'Steer added: "Focus on tests"\n1 active steer(s). Use /steer list to see all.',
    });
    expect(formatSteersForPrompt()).toContain("Active steering directives");
    expect(formatSteersForPrompt()).toContain("1. Focus on tests");
    expect(listResult).toEqual({
      type: "message",
      text: "Active steers:\n  1. Focus on tests\n\nUse /steer clear to remove all, or /steer remove <number> to remove one.",
    });
  });

  it("removes and clears steers with helpful messages", async () => {
    await steerCommand.execute("one", {} as any);
    await steerCommand.execute("two", {} as any);

    const removeResult = await steerCommand.execute("remove 1", {} as any);
    const clearResult = await steerCommand.execute("clear", {} as any);
    const emptyClearResult = await steerCommand.execute("clear", {} as any);

    expect(removeResult).toEqual({ type: "message", text: 'Removed steer: "one"' });
    expect(clearResult).toEqual({ type: "message", text: "Cleared 1 steer(s)." });
    expect(emptyClearResult).toEqual({ type: "message", text: "No steers to clear." });
  });

  it("validates remove indexes", async () => {
    await steerCommand.execute("only", {} as any);

    await expect(steerCommand.execute("remove 0", {} as any)).resolves.toEqual({
      type: "message",
      text: "Invalid number. Use 1-1.",
    });
  });

  it("queues added directives for delivery and reports mid-turn status via isLoading", async () => {
    const { drainSteers } = await import("../commands/steer.js");

    const runningResult = await steerCommand.execute("mid-turn directive", { isLoading: true } as any);
    expect(runningResult).toEqual({
      type: "message",
      text: 'Steer added: "mid-turn directive"\nWill be delivered to the running agent before it continues.',
    });

    const idleResult = await steerCommand.execute("idle directive", {} as any);
    expect(idleResult).toEqual({
      type: "message",
      text: 'Steer added: "idle directive"\n2 active steer(s). Use /steer list to see all.',
    });

    // Both directives are queued in arrival order for the running loop.
    expect(drainSteers()).toEqual(["mid-turn directive", "idle directive"]);
    expect(drainSteers()).toEqual([]);
  });
});
