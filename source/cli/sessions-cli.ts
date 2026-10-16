import { listSessions, deleteSession } from "../config/history.js";

/**
 * Handle `agav sessions <command> [args]`
 */
export async function runSessionsCommand(
  command: string | undefined,
  args: string[],
): Promise<number> {
  // Reject any flags early (e.g. `agav sessions delete <id> --bogus`)
  for (const arg of args) {
    if (arg.startsWith("-")) {
      console.error(`\nError: Unknown option '${arg}'\n`);
      return 1;
    }
  }

  if (!command) {
    console.error("\nUsage: agav sessions <command> [args]");
    console.error("Commands: delete (alias: rm)\n");
    return 1;
  }

  switch (command) {
    case "delete":
    case "rm": {
      if (args.length === 0) {
        console.error("\nError: No session ID provided.");
        console.error("Usage: agav sessions delete <session-id>\n");
        return 1;
      }

      if (args.length > 1) {
        console.error(`\nError: Unexpected argument '${args[1]}'\n`);
        return 1;
      }

      const id = args[0]!.trim();
      if (!id) {
        console.error("\nError: No session ID provided.");
        console.error("Usage: agav sessions delete <session-id>\n");
        return 1;
      }

      const sessions = await listSessions();

      // Support exact ID match or unique prefix matching
      const matching = sessions.filter(
        (s) => s.id === id || s.id.startsWith(id),
      );

      if (matching.length === 0) {
        console.error(`\nError: Session '${id}' not found.\n`);
        return 1;
      }

      if (matching.length > 1) {
        console.error(
          `\nError: Ambiguous session ID prefix '${id}' matches ${matching.length} sessions.\n`,
        );
        return 1;
      }

      const targetId = matching[0]!.id;
      const ok = await deleteSession(targetId);
      if (!ok) {
        console.error(`\nError: Failed to delete session '${targetId}'.\n`);
        return 1;
      }

      console.log(`\n✓ Deleted session ${targetId}\n`);
      return 0;
    }

    default: {
      console.error(`\nError: Unknown sessions command '${command}'.`);
      console.error("Usage: agav sessions <delete|rm> <session-id>\n");
      return 1;
    }
  }
}
