/**
 * Slash commands that are safe to run while a turn is still in flight
 * (streaming or executing a tool call). Every other command is deferred
 * until the agent is idle. `exit` is included so users can quit mid-turn
 * instead of waiting for the CLI to become idle; the exit handler aborts
 * the active turn before tearing down.
 */
export const MID_TURN_SAFE_COMMANDS = new Set([
  "help",
  "exit",
  "loop",
  "steer",
  "context",
  "memory",
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
