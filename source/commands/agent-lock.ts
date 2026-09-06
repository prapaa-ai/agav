import type { SlashCommand, CommandResult } from "./types.js";

export interface AgentLockState {
  name: string;
  full: boolean;
}

let lockedAgent: AgentLockState | null = null;

export function getLockedAgent(): AgentLockState | null {
  return lockedAgent;
}

export function clearLockedAgent(): void {
  lockedAgent = null;
}

export const agentLockCommand: SlashCommand = {
  name: "agent",
  description: "Lock/unlock session to a specific agent",
  usage: [
    "Usage:",
    "  /agent <name>          Lock all queries to the named agent (read-only + HITL)",
    "  /agent <name> --full   Lock with full access (destructive tools auto-approve)",
    "  /agent off             Unlock (return to normal mode)",
    "  /agent                 Show current lock status",
  ].join("\n"),

  async execute(args: string): Promise<CommandResult> {
    const parts = args.trim().split(/\s+/);
    const name = parts[0]?.toLowerCase() ?? "";
    const flags = parts.slice(1);

    if (!name) {
      if (lockedAgent) {
        const mode = lockedAgent.full ? "full" : "read-only";
        return {
          type: "message",
          text: `Session locked to agent: ${lockedAgent.name} (${mode})\nUse /agent off to unlock.`,
        };
      }
      return {
        type: "message",
        text: "No agent lock active. Use /agent <name> to lock.\nUse /help agent for usage details.",
      };
    }

    if (name === "off" || name === "unlock" || name === "none") {
      const prev = lockedAgent;
      lockedAgent = null;
      return {
        type: "message",
        text: prev
          ? `Unlocked from agent: ${prev.name}`
          : "No agent lock was active.",
      };
    }

    const { resolveTargetAgent } = await import("../agents/targeting.js");
    const resolved = await resolveTargetAgent(name);
    if ("error" in resolved) {
      return { type: "message", text: resolved.error };
    }

    const full = flags.includes("--full");
    lockedAgent = { name, full };

    const lines = [
      `Session locked to agent: ${name}`,
      `Mode: ${full ? "full access" : "read-only (HITL confirmation for destructive tools)"}`,
      "",
      "All queries will be sent directly to this agent.",
      "Use /agent off to unlock.",
    ];

    if (full) {
      lines.push("", "⚠ Full access granted — destructive tools will not require confirmation.");
    }

    return { type: "message", text: lines.join("\n") };
  },
};
