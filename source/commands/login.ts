import type { SlashCommand, CommandResult, CommandContext } from "./types.js";

/**
 * `/login` and `/logout` — the in-session equivalents of `agav login` /
 * `agav logout`. They delegate to the exact same enterprise-enrollment logic
 * (`runLoginCommand`) so the two entry points can never drift apart.
 *
 * Two TUI-specific hazards are handled here:
 *
 *   1. **Live output must survive the repaint.** The flow writes device codes /
 *      "visit this URL" prompts and its final success/error line to the console
 *      while the terminal is suspended. On the alternate screen, resuming Ink
 *      clears whatever the flow left on screen (resetDisplay), so "see the
 *      message above" would point at nothing. We tee stdout/stderr: the bytes
 *      still render live (needed for the device/browser flows) AND are captured,
 *      then returned in the command result so the transcript keeps them after the
 *      repaint.
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

  // --- Capture (tee) console output so it survives the post-resume repaint. ---
  // Keep the EXACT existing writer references so we restore the stream to the
  // precise function it had before (not a fresh .bind() copy, which would both
  // break identity and stack a new `bound` layer on every invocation).
  const captured: string[] = [];
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  const tee = (
    stream: NodeJS.WriteStream,
    original: typeof process.stdout.write,
  ): typeof process.stdout.write =>
    (function (this: unknown, chunk: unknown, ...rest: unknown[]): boolean {
      try {
        captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
      } catch {
        // Never let capture break the real write.
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (original as any).call(stream, chunk, ...rest);
    }) as typeof process.stdout.write;

  // --- Ctrl-C / ESC cancellation while the terminal is suspended. ---
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
  process.stdout.write = tee(process.stdout, origStdoutWrite);
  process.stderr.write = tee(process.stderr, origStderrWrite);
  stdin.on("data", onKey);

  let exitCode: number;
  try {
    exitCode = await runLoginCommand(command, argv, { signal: abort.signal });
  } finally {
    stdin.removeListener("data", onKey);
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    resume();
  }

  // Fold the captured output into the transcript so actionable diagnostics
  // (argument errors, missing org config, browser-fallback hints, logout
  // permission errors) are not lost when Ink repaints over the suspended screen.
  const transcript = captured.join("").replace(/\s+$/, "");
  const cancelled = abort.signal.aborted;

  if (command === "logout") {
    const header = exitCode === 0 ? "Signed out of your organization. Restart Agav to apply." : "Sign-out failed.";
    return { type: "message", text: transcript ? `${header}\n\n${transcript}` : header, preservePaths: true };
  }

  const header = cancelled
    ? "Sign-in cancelled."
    : exitCode === 0
      ? "Signed in. Your organization's settings are now active — restart Agav to use them."
      : "Sign-in failed.";
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
