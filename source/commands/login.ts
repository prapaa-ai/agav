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

/**
 * Smart /login routing. The command serves two distinct products:
 *   - Consumer Agav account (opt-in paid): sign in with an Agav API key.
 *   - Enterprise enrollment: org policy + gateway via the control plane.
 *
 * Consumer sign-in is selected EXPLICITLY (never inferred) with `--key` /
 * `--consumer`. The key is NOT taken from the command line in the TUI — it would
 * otherwise be recorded in prompt history and could be routed to the model as an
 * attachment. Instead we collect it with a masked, isolated terminal prompt.
 * Everything else routes to enterprise enrollment, unchanged.
 */

/**
 * Run consumer sign-in: prompt for the key (masked, off the composer), validate,
 * and persist. Mirrors the enterprise flow's terminal handling: suspend Ink,
 * read raw stdin, support Ctrl-C/Esc cancellation, and survive the repaint.
 */
async function runConsumerLogin(
  accountService: string | undefined,
  context: CommandContext,
): Promise<CommandResult> {
  const { signInWithApiKey } = await import("../account/account-login.js");
  const { readSecretFromTty, SecretPromptError } = await import("../account/secret-prompt.js");
  const { AccountError } = await import("../account/types.js");

  const abort = new AbortController();
  // The terminal stays suspended across BOTH the masked prompt AND validation, so
  // Ctrl-C/Esc can cancel the in-flight whoami request (not just the prompt). The
  // masked prompt owns stdin while it reads; once it returns we install our own
  // raw-stdin listener for the validation window to keep cancellation working —
  // mirroring the enterprise flow's handling of the suspended terminal.
  const resume = context.suspendTerminal();

  let key: string | undefined;
  try {
    key = await readSecretFromTty({
      label: "Paste your Agav API key (from https://agav.dev/account), then Enter: ",
      signal: abort.signal,
    });
  } catch (error) {
    resume();
    if (error instanceof SecretPromptError) {
      return { type: "message", text: `Agav account sign-in failed.\n\n${error.message}`, preservePaths: true };
    }
    throw error;
  }

  if (key === undefined) {
    resume();
    return { type: "message", text: "Agav account sign-in cancelled.", preservePaths: true };
  }
  if (!key.trim()) {
    resume();
    return { type: "message", text: "Agav account sign-in failed.\n\nNo key entered.", preservePaths: true };
  }

  // Keep cancellation alive during validation: raw Ctrl-C/Esc aborts the request.
  // The masked prompt paused stdin on its way out, so we must resume it or the
  // listener below would never receive bytes.
  const stdin = process.stdin;
  const onKey = (data: Buffer): void => {
    const s = data.toString("utf8");
    if (s.includes("\x03") || s === "\x1b") {
      if (!abort.signal.aborted) abort.abort(new AccountError("Sign-in cancelled."));
    }
  };
  const wasPaused = stdin.isPaused?.() ?? false;
  stdin.on("data", onKey);
  if (wasPaused) stdin.resume();

  try {
    const identity = await signInWithApiKey(key, { accountService, signal: abort.signal });
    const who = identity.email ? ` as ${identity.email}` : "";
    return {
      type: "message",
      // Honest wording: we validated identity and connected the account. We do NOT
      // claim a subscription is active — entitlement/gateway are a later slice.
      text: `Signed in to your Agav account${who}. Restart Agav to use it.`,
      preservePaths: true,
    };
  } catch (error) {
    if (abort.signal.aborted) {
      return { type: "message", text: "Agav account sign-in cancelled.", preservePaths: true };
    }
    const detail = error instanceof AccountError || error instanceof Error ? error.message : String(error);
    return { type: "message", text: `Agav account sign-in failed.\n\n${detail}`, preservePaths: true };
  } finally {
    stdin.removeListener("data", onKey);
    // Restore the paused state we found, so Ink's resume() re-attaches its own
    // handler to a stream in the expected state rather than one we left flowing.
    if (wasPaused) stdin.pause();
    resume();
  }
}

/** Sign out of the consumer account (clear the local store + credential entry). */
async function runConsumerLogout(): Promise<CommandResult> {
  const { signOutAccount } = await import("../account/account-login.js");
  try {
    await signOutAccount();
    return { type: "message", text: "Signed out of your Agav account.", preservePaths: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      type: "message",
      text: `Could not sign out of your Agav account: ${detail}\nYour account is still connected. Fix the file permissions and try again.`,
      preservePaths: true,
    };
  }
}

export const loginCommand: SlashCommand = {
  name: "login",
  description: "Sign in to your Agav account (--key) or your organization (enterprise)",
  usage: "Usage:\n  /login --key     Sign in to your Agav account; you'll be prompted to paste your key (never shown)\n  /login [--device | --oidc | --auth-code | --saml] [--control-plane URL] [--issuer URL] [--client-id ID]     Enterprise enrollment\n\nGet an Agav API key at https://agav.dev/account. At the secret prompt, Ctrl-C cancels; Esc then Enter also cancels. An incomplete paste stays isolated until its closing marker or EOF. During validation, Ctrl-C or Esc cancels.",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const { parseConsumerArgs } = await import("../account/account-login.js");
    const argv = args.trim().length ? args.trim().split(/\s+/) : [];
    const parsed = parseConsumerArgs(argv);
    if ("error" in parsed) {
      return { type: "message", text: parsed.error, preservePaths: true };
    }
    if (parsed.consumer) {
      // A key pasted inline in the TUI would already be in the composer/history;
      // ignore it and always collect via the masked prompt. (inlineKey is only
      // meaningful on the CLI, which warns about shell history there.)
      return runConsumerLogin(parsed.accountService, context);
    }
    return runEnrollment("login", args, context);
  },
};

export const logoutCommand: SlashCommand = {
  name: "logout",
  description: "Sign out of your Agav account (--account) or your organization",
  usage: "Usage:\n  /logout --account     Sign out of your Agav account (consumer)\n  /logout               Sign out of your organization (enterprise)",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const { parseConsumerArgs } = await import("../account/account-login.js");
    const argv = args.trim().length ? args.trim().split(/\s+/) : [];
    const parsed = parseConsumerArgs(argv);
    if ("error" in parsed) {
      return { type: "message", text: parsed.error, preservePaths: true };
    }
    if (parsed.consumer) return runConsumerLogout();
    return runEnrollment("logout", args, context);
  },
};
