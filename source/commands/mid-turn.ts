/**
 * Slash commands that are safe to run while a turn is still in flight
 * (streaming or executing a tool call). Every other command is deferred
 * until the agent is idle, including commands that open interactive managers
 * or change execution settings, conversation state, or workspace files.
 * Inspection variants are allowed separately when arguments are supplied.
 * `exit` aborts the active turn before tearing down;
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
export function isCommandAllowedMidTurn(name: string, args?: string): boolean {
  name = name.toLowerCase()
  if (MID_TURN_SAFE_COMMANDS.has(name)) return true
  // A name-only check stays conservative: these commands have unsafe variants.
  if (args === undefined) return false
  const input = args.trim()
  const parts = input.split(/\s+/)
  const action = parts[0]!.toLowerCase()
  switch (name) {
    case "branch":
    case "agent":
      return input === ""
    case "job":
      return ["list", "capabilities"].includes(action)
        || (["poll", "log", "stop"].includes(action) && !!parts[1])
        || (action === "schedule" && (!parts[1] || parts[1].toLowerCase() === "list"))
    case "agents":
    case "history":
      return input === "list"
    case "skills":
      return action === "list" || (action === "info" && !!parts[1])
    case "search":
    case "search-history":
      return input !== ""
    case "memory":
      return action === "list" || action === "path"
    case "undo":
      return input === "list"
    case "plan":
      return input === "" || input.toLowerCase() === "list"
    case "schedule":
      return action === "list"
    case "mcp":
      return input === "" || input === "list"
    case "watch":
      return input === "" || input === "stop"
    case "workflows":
      // list/status reconcile runners and may launch work; they are not inspection.
      return ["help", "--help", "-h", "inbox"].includes(input)
        || /^(validate|inbox)\s+\S/.test(input)
    default:
      return false
  }
}

/** Explain why a deferred invocation cannot execute alongside active work. */
export function getMidTurnBlockReason(name: string, args: string): string {
  const command = name.toLowerCase()
  const input = args.trim()
  const managers = ["job", "schedule", "workflows", "agents", "skills", "history", "search", "search-history", "memory", "resume"]
  if (["customize", "login", "voice"].includes(command)
    || (command === "model" && !input)
    || (!input && managers.includes(command))
    || (command === "skills" && input.toLowerCase() === "marketplace")) {
    return "Cannot open a new UI while working."
  }
  if (["model", "effort", "permission", "fast", "deep", "agent", "mcp", "logout", "clear", "new", "resume", "branch", "compact", "undo", "plan", "memory", "skills", "schedule", "job", "watch", "workflows"].includes(command)) {
    return "Cannot modify execution or session state while working."
  }
  return "Cannot run this command in the current state."
}

/** Human-readable list of commands that can run while Agav is working. */
export function formatMidTurnSafeCommands(): string {
  return [...[...MID_TURN_SAFE_COMMANDS].map((name) => `/${name}`),
    "/branch (list only)", "/job list|poll|log|stop|capabilities", "/job schedule list",
    "/agents list", "/skills list|info", "/history list", "/search <query>",
    "/search-history <query>", "/memory list|path", "/undo list", "/plan [list]",
    "/schedule list", "/mcp [list]", "/agent (status only)", "/watch [stop]",
    "/workflows help|validate|inbox",
  ].join(", ")
}
