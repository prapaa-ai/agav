import type { SlashCommand, CommandResult, CommandContext } from "./types.js";

/**
 * `/login` and `/logout` — the in-session equivalents of `agav login` /
 * `agav logout`. They delegate to the exact same enterprise-enrollment logic
 * (`runLoginCommand`) so the two entry points can never drift apart.
 *
 * Two TUI-specific hazards are handled here:
 *
 *   1. **The outcome must survive the repaint.** The flow's final success/error
 *      line would otherwise be written to the console while the terminal is
 *      suspended and then erased the moment Ink resumes (resetDisplay on the
 *      alternate screen), leaving "Sign-in failed." pointing at nothing. We pass
 *      `onMessage`/`onError` sinks into `runLoginCommand` so every outcome line
 *      is captured and folded into the command result, which lands in the
 *      transcript and survives the repaint. (Interactive sub-steps — the device
 *      code prompt and the browser hand-off — still write live to the terminal
 *      during the suspended window, which is what we want.)
 *
 *   2. **Ctrl-C must cancel.** suspendTerminal() only detaches Ink's stdin
 *      handler; it leaves the terminal in raw mode, so Ctrl-C arrives as a byte
 *      (0x03), not SIGINT — the signal the flow normally listens for. We install
 *      a temporary stdin listener for the suspended window that aborts a
 *      flow-local AbortSignal on Ctrl-C or ESC. We deliberately do NOT re-emit
 *      SIGINT: the app installs its own SIGINT handler that would tear down the
 *      whole session.
 */
async function runEnrollment(
  command: "login" | "logout",
  args: string,
  context: CommandContext,
): Promise<CommandResult> {
  const { runLoginCommand } = await import("../cli/login-cli.js");
  const argv = args.trim().length ? args.trim().split(/\s+/) : [];

  // Capture outcome lines through the sinks (robust, no stream patching).
  const captured: string[] = [];
  const onMessage = (text: string): void => { captured.push(text); };
  const onError = (text: string): void => { captured.push(text); };

  // Ctrl-C / ESC cancellation while the terminal is suspended.
  const abort = new AbortController();
  const stdin = process.stdin;
  const onKey = (data: Buffer): void => {
    const s = data.toString("utf8");
    // 0x03 = Ctrl-C, 0x1b = ESC. Either cancels the in-flight flow.
    if (s.includes("\x03") || s === "\x1b") {
      if (!abort.signal.aborted) abort.abort();
    }
  };

  const resume = context.suspendTerminal();
  stdin.on("data", onKey);

  let exitCode: number;
  try {
    exitCode = await runLoginCommand(command, argv, { signal: abort.signal, onMessage, onError });
  } finally {
    stdin.removeListener("data", onKey);
    resume();
  }

  const transcript = captured.join("\n").replace(/\s+$/, "");
  // Success takes precedence over the aborted signal. Enrollment is persisted
  // before runLoginCommand awaits its (up to ~2s) success-audit event; a Ctrl-C
  // during that window aborts the signal but the login already succeeded and
  // returned 0. Reporting "cancelled" then would contradict the persisted
  // credentials. Only treat an abort as a cancellation when the flow did NOT
  // succeed.
  const cancelled = abort.signal.aborted && exitCode !== 0;

  if (command === "logout") {
    const header = exitCode === 0 ? "Signed out of your organization. Restart Agav to apply." : "Sign-out failed.";
    // The success line already restates the restart guidance, so for success show
    // the captured line alone; on failure, show the header then the detail.
    const text = exitCode === 0 ? (transcript || header) : (transcript ? `${header}\n\n${transcript}` : header);
    return { type: "message", text, preservePaths: true };
  }

  if (exitCode === 0) {
    return {
      type: "message",
      text: transcript || "Signed in. Your organization's settings are now active — restart Agav to use them.",
      preservePaths: true,
    };
  }

  const header = cancelled ? "Sign-in cancelled." : "Sign-in failed.";
  return { type: "message", text: transcript ? `${header}\n\n${transcript}` : header, preservePaths: true };
}

export const loginCommand: SlashCommand = {
  name: "login",
  description: "Sign in to your organization (enterprise enrollment)",
  usage: "Usage: /login [--device | --oidc | --auth-code | --saml] [--control-plane URL] [--issuer URL] [--client-id ID]\n\nPress Ctrl-C or Esc to cancel an in-progress sign-in.",
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
