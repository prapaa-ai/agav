import type { SlashCommand, CommandResult, CommandContext } from "./types.js";

let activeSteers: string[] = [];

/**
 * Directives added while an agent turn was already running. The agent loop
 * drains these at its next safe point — right after tool results are appended,
 * where a user message is protocol-legal — so a /steer typed mid-turn reaches
 * the model within the same turn instead of waiting for the next one.
 */
let steerQueue: string[] = [];

const childSteerQueues = new Map<string, string[]>();

/** Independent delivery queue, addressable only by this child's ID. */
export function createSteerQueue(id?: string): { drain: () => string[]; dispose: () => void } {
  const queue: string[] = [];
  if (id !== undefined) {
    if (childSteerQueues.has(id)) throw new Error(`Subagent ${id} is already active.`);
    childSteerQueues.set(id, queue);
  }
  return {
    drain: () => queue.splice(0),
    dispose: () => {
      if (id !== undefined && childSteerQueues.get(id) === queue) childSteerQueues.delete(id);
      queue.length = 0;
    },
  };
}

/** Queue a directive for the main agent only. */
export function queueSteer(directive: string): void {
  steerQueue.push(directive);
}

/** Queue a directive for one live child, never the main agent or siblings. */
export function queueSubagentSteer(id: string, directive: string): void {
  const queue = childSteerQueues.get(id);
  if (!queue) throw new Error(`Subagent ${id} is not active.`);
  queue.push(directive);
}

/** Return queued mid-turn directives in arrival order and empty the queue. */
export function drainSteers(): string[] {
  if (steerQueue.length === 0) return [];
  const drained = steerQueue;
  steerQueue = [];
  return drained;
}

export function getActiveSteers(): string[] {
  return activeSteers;
}

export function clearSteers(): void {
  activeSteers = [];
  steerQueue = [];
}

export function formatSteersForPrompt(): string {
  if (activeSteers.length === 0) return "";
  const lines = activeSteers.map((s, i) => `${i + 1}. ${s}`);
  return [
    "Active steering directives (apply these to all subsequent work):",
    ...lines,
  ].join("\n");
}

export const steerCommand: SlashCommand = {
  name: "steer",
  description: "Add context or direction to guide the agent",
  argumentHint: "<directive>",
  usage: "Usage: /steer <directive>\n\n  /steer be concise       Add a steering directive\n  /steer list             Show active steers\n  /steer remove <N>       Remove a specific steer\n  /steer clear            Remove all steers\n\nTargets the main agent, or only the inspected subagent while its inspector is open.\nWorks during foreground and background-worker turns, before the next safe step.\nMain-agent steers persist for subsequent main turns; they are not inherited by children.\nList/remove/clear management is unavailable in a worker or subagent inspector.",
  async execute(args: string, contextArg?: CommandContext): Promise<CommandResult> {
    const trimmed = args.trim();
    const targetId = contextArg?.steerTargetId;
    const workerAttached = contextArg?.isWorkerAttached?.();
    const management = !trimmed || trimmed === "list" || trimmed === "clear" || trimmed.startsWith("remove ");
    if (management && (targetId !== undefined || workerAttached)) {
      return {
        type: "message",
        text: "Steer management (list/clear/remove) is not supported in a background worker or subagent inspector.",
      };
    }

    if (!trimmed || trimmed === "list") {
      if (activeSteers.length === 0) {
        return { type: "message", text: "No active steers. Use /steer <directive> to add one." };
      }
      const lines = activeSteers.map((s, i) => `  ${i + 1}. ${s}`);
      return {
        type: "message",
        text: `Active steers:\n${lines.join("\n")}\n\nUse /steer clear to remove all, or /steer remove <number> to remove one.`,
      };
    }

    if (trimmed === "clear") {
      const count = activeSteers.length;
      clearSteers();
      return { type: "message", text: count > 0 ? `Cleared ${count} steer(s).` : "No steers to clear." };
    }

    if (trimmed.startsWith("remove ")) {
      const num = parseInt(trimmed.slice(7).trim(), 10);
      if (isNaN(num) || num < 1 || num > activeSteers.length) {
        return { type: "message", text: `Invalid number. Use 1-${activeSteers.length}.` };
      }
      const removed = activeSteers.splice(num - 1, 1)[0];
      return { type: "message", text: `Removed steer: "${removed}"` };
    }

    try {
      if (contextArg?.steer) {
        await contextArg.steer(trimmed);
      } else if (workerAttached) {
        return { type: "message", text: "Steering delivery is not available for this background worker." };
      } else if (targetId !== undefined) {
        queueSubagentSteer(targetId, trimmed);
      } else {
        queueSteer(trimmed);
      }
    } catch (error) {
      return { type: "message", text: `Failed to steer: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (targetId === undefined) activeSteers.push(trimmed);

    if (targetId !== undefined) {
      return { type: "message", text: `Steer added for subagent ${targetId}: "${trimmed}"\nWill be delivered before it continues.` };
    }

    const context = contextArg as CommandContext | undefined;
    if (context?.isLoading) {
      return {
        type: "message",
        text: `Steer added: "${trimmed}"\nWill be delivered to the running agent before it continues.`,
      };
    }
    return {
      type: "message",
      text: `Steer added: "${trimmed}"\n${activeSteers.length} active steer(s). Use /steer list to see all.`,
    };
  },
};
