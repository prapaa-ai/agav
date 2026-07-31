import type { SlashCommand, CommandResult } from "./types.js";

let activeSteers: string[] = [];

export function getActiveSteers(): string[] {
  return activeSteers;
}

export function clearSteers(): void {
  activeSteers = [];
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
  usage: "Usage: /steer <directive>\n\n  /steer be concise       Add a steering directive\n  /steer list             Show active steers\n  /steer remove <N>       Remove a specific steer\n  /steer clear            Remove all steers\n\nSteers are injected into the system prompt for all subsequent turns.",
  async execute(args: string): Promise<CommandResult> {
    const trimmed = args.trim();

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

    activeSteers.push(trimmed);
    return {
      type: "message",
      text: `Steer added: "${trimmed}"\n${activeSteers.length} active steer(s). Use /steer list to see all.`,
    };
  },
};
