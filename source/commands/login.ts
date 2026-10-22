import type { SlashCommand, CommandResult, CommandContext } from "./types.js";

/**
 * `/login` and `/logout` — the in-session equivalents of `agav login` /
 * `agav logout`. They delegate to the exact same enterprise-enrollment logic
 * (`runLoginCommand`) so the two entry points can never drift apart.
 *
 * The flow writes device codes / "visit this URL" prompts to the terminal and,
 * for the auth-code flow, opens a browser and runs a loopback server. We suspend
 * Ink first so those writes land on the real terminal instead of being erased by
 * the next TUI repaint, then resume once the flow finishes. `runLoginCommand`
 * never calls `process.exit` and removes its own signal handlers, so it is safe
 * to run inside the live session.
 */
async function runEnrollment(
  command: "login" | "logout",
  args: string,
  context: CommandContext,
): Promise<CommandResult> {
  const { runLoginCommand } = await import("../cli/login-cli.js");
  const argv = args.trim().length ? args.trim().split(/\s+/) : [];

  const resume = context.suspendTerminal();
  let exitCode: number;
  try {
    exitCode = await runLoginCommand(command, argv);
  } finally {
    resume();
  }

  // runLoginCommand prints the human-readable outcome (including restart
  // guidance and any error) to the console while the terminal is suspended, so
  // the user has already seen it. Return a short confirmation line for the
  // transcript rather than duplicating that output.
  if (command === "logout") {
    return {
      type: "message",
      text: exitCode === 0
        ? "Signed out of your organization. Restart Agav to apply."
        : "Sign-out failed. See the message above for details.",
    };
  }
  return {
    type: "message",
    text: exitCode === 0
      ? "Signed in. Your organization's settings are now active — restart Agav to use them."
      : "Sign-in failed. See the message above for details.",
  };
}

export const loginCommand: SlashCommand = {
  name: "login",
  description: "Sign in to your organization (enterprise enrollment)",
  usage: "Usage: /login [--device | --oidc | --auth-code | --saml] [--control-plane URL] [--issuer URL] [--client-id ID]",
  execute(args: string, context: CommandContext): Promise<CommandResult> {
    return runEnrollment("login", args, context);
  },
};

export const logoutCommand: SlashCommand = {
  name: "logout",
  description: "Sign out of your organization and clear cached enrollment",
  usage: "Usage: /logout",
  execute(args: string, context: CommandContext): Promise<CommandResult> {
    return runEnrollment("logout", args, context);
  },
};
