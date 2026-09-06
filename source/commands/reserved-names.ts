/**
 * Names reserved by built-in slash commands. Exported so skill loading can
 * reject skills whose slugs would shadow a core command.
 *
 * Kept in a separate file to avoid a circular dependency between the command
 * registry (which imports from skills/) and the skill loader.
 */
export const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "help", "clear", "new", "name", "model", "effort", "exit",
  "history", "export", "watch", "branch", "compact", "memory",
  "remember", "forget", "fast", "deep", "undo", "plan", "debug",
  "search", "loop", "schedule", "skills", "steer", "changelog",
  "context", "agents", "open",
]);
