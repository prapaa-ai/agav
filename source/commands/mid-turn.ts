/**
 * Slash commands that are safe to run while a turn is still in flight
 * (streaming or executing a tool call). Every other command is deferred
 * until the agent is idle, including commands that open interactive managers
 * or change execution settings, conversation state, or workspace files.
 * This is a command-level policy: read-only arguments of deferred commands
 * still wait for idle. `exit` aborts the active turn before tearing down;
 * `detach` intentionally leaves a worker-owned turn running.
 */
export const MID_TURN_SAFE_COMMANDS = new Set([
  "help",
  "exit",
  "detach",
  "loop",
  "steer",
  "context",
  "status",
  // Metadata, committed snapshots, and text-only inspection (no UI takeover).
  "name",
  "copy",
  "export",
  "open",
  "debug",
  "changelog",
  // These shortcuts never open the interactive /memory manager.
  "remember",
  "forget",
])

/** Whether a slash command may run while a turn is still in flight. */
export function isCommandAllowedMidTurn(name: string): boolean {
  return MID_TURN_SAFE_COMMANDS.has(name.toLowerCase())
}

/** Human-readable list of commands that can run while Agav is working. */
export function formatMidTurnSafeCommands(): string {
  return [...MID_TURN_SAFE_COMMANDS].map((name) => `/${name}`).join(", ")
}
