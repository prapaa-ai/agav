import { beforeEach, describe, expect, it } from "vitest";

import { clearSteers, createSteerQueue, drainSteers, formatSteersForPrompt, getActiveSteers, steerCommand } from "../commands/steer.js";
import type { CommandContext } from "../commands/types.js";

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

  it.each(["worker directive", "list", "", "clear", "remove 1"])("rejects /steer %s on a live worker without changing local steers or delivery queues", async (args) => {
    const childQueue = createSteerQueue();
    try {
      await steerCommand.execute("foreground directive", {} as CommandContext);
      const context = { isLoading: true, isWorkerAttached: () => true } as CommandContext;

      await expect(steerCommand.execute(args, context)).resolves.toEqual({
        type: "message",
        text: "Steering is not supported while this session is executing in a background worker. Wait for the turn to finish before using /steer.",
      });
      expect(getActiveSteers()).toEqual(["foreground directive"]);
      expect(drainSteers()).toEqual(["foreground directive"]);
      expect(childQueue.drain()).toEqual(["foreground directive"]);
    } finally {
      childQueue.dispose();
    }
  });

  it("checks current worker ownership and preserves foreground delivery after attachment ends", async () => {
    let live = true;
    const context = { isLoading: true, isWorkerAttached: () => live } as CommandContext;
    await steerCommand.execute("rejected directive", context);
    live = false;

    await expect(steerCommand.execute("foreground directive", context)).resolves.toEqual({
      type: "message",
      text: 'Steer added: "foreground directive"\nWill be delivered to the running agent before it continues.',
    });
    expect(getActiveSteers()).toEqual(["foreground directive"]);
    expect(drainSteers()).toEqual(["foreground directive"]);
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
