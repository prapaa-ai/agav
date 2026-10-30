import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "../ink/index.js";
import { getTheme } from "../config/theme.js";
import { readSecretFromTty } from "../account/secret-prompt.js";
import { signInWithApiKey } from "../account/account-login.js";
import { AccountAcknowledgementError, signInWithBrowser } from "../account/browser-auth.js";
import { accountEndpoint } from "../account/account-client.js";

export type LoginWizardResult = { cancelled: boolean; message?: string };
export interface LoginTUIProps {
  /** Resolved and validated once by /login; shared by browser and validation. */
  accountService: string;
  openBrowser: (url: string) => Promise<boolean>;
  onDone: (result: LoginWizardResult) => void;
}
type Phase = "menu" | "browser" | "entry" | "validating" | "cancelling" | "retry";
const ITEMS = ["Sign in with your Agav account", "Paste an Agav API key"];

/**
 * The /login wizard.
 *
 *  - Option 1 "Sign in with your Agav account" runs the browser-authorization
 *    flow: we open the browser, show a short code to confirm, and wait for the
 *    user to approve. The credential is delivered to the CLI automatically — the
 *    user never copies a key. No raw terminal input is needed, so Ink stays live.
 *  - Option 2 "Paste an Agav API key" keeps the masked, isolated reader for users
 *    who already have a key. That reader suspends Ink and never leaks a secret to
 *    the composer, even on cancellation.
 */
export function LoginTUI({ accountService, openBrowser, onDone }: LoginTUIProps) {
  const theme = getTheme();
  const { suspendTerminalSync } = useApp();
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const [phase, setPhase] = useState<Phase>("menu");
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string>();
  // Live browser-flow prompt (the short code + whether the browser opened).
  const [prompt, setPrompt] = useState<{ userCode: string; verificationUrl: string; openedBrowser: boolean }>();
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const finished = useRef(false);
  const accountUrl = accountEndpoint(accountService, "account").href;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);

  const done = (result: LoginWizardResult) => {
    if (!mounted.current || finished.current) return;
    finished.current = true;
    onDone(result);
  };
  const cancel = () => {
    const controller = active.current;
    if (controller) {
      controller.abort();
      if (phase === "validating" || phase === "cancelling") {
        // Await the commit-aware save result: a cancellation after commit must
        // report success, whereas pre-commit cancellation preserves old state.
        setPhase("cancelling");
        return;
      }
    }
    done({ cancelled: true });
  };

  const success = (email: string | null) =>
    done({ cancelled: false, message: `Signed in to your Agav account${email ? ` as ${email}` : ""}. Use /status to see your account.` });

  /** Option 1: browser authorization — no key typed, Ink stays live. */
  const connectWithBrowser = async () => {
    if (active.current || finished.current) return;
    const controller = new AbortController();
    active.current = controller;
    setError(undefined);
    setPhase("browser");
    try {
      const identity = await signInWithBrowser({
        accountService,
        signal: controller.signal,
        openBrowser,
        onPrompt: (info) => { if (mounted.current) setPrompt(info); },
        onStatus: (status) => { if (mounted.current && status === "saving") setPhase("validating"); },
      });
      success(identity.email);
    } catch (error) {
      if (!mounted.current || finished.current) return;
      // A post-commit acknowledgement failure needs retry guidance even when
      // cancellation arrived after saving; it is not a rolled-back sign-in.
      if (controller.signal.aborted && !(error instanceof AccountAcknowledgementError)) {
        done({ cancelled: true }); return;
      }
      // Surface the account-service message (these are curated, secret-free) so a
      // denial / timeout / service outage is actionable. Fall back generically.
      const { AccountError } = await import("../account/types.js");
      setError(error instanceof AccountError ? error.message : "Could not complete browser sign-in. Please try again.");
      setPhase("retry");
    } finally {
      if (active.current === controller) active.current = null;
    }
  };

  /** Option 2: paste an existing key via the masked, isolated reader. */
  const connectWithKey = async () => {
    if (active.current || finished.current) return;
    const controller = new AbortController();
    active.current = controller;
    setError(undefined);
    setPhase("entry");
    try {
      const resume = suspendTerminalSync();
      let key: string | undefined;
      try {
        stdout.write(`Sign in to Agav · API key\nCreate a key at ${accountUrl} if you don't have one.\nThe key stays hidden and is not sent to the model or saved in prompt history.\n`);
        key = await readSecretFromTty({
          label: "Paste your Agav API key, then Enter: ",
          signal: controller.signal, input: stdin, out: stdout,
          restoreBracketedPaste: "enabled",
        });
      } finally {
        resume();
      }
      if (!mounted.current || finished.current) return;
      if (key === undefined || controller.signal.aborted) { done({ cancelled: true }); return; }
      setPhase("validating");
      let identity;
      try {
        identity = await signInWithApiKey(key, { accountService, signal: controller.signal });
      } finally { key = undefined; }
      success(identity.email);
    } catch {
      if (!mounted.current || finished.current) return;
      if (controller.signal.aborted) { done({ cancelled: true }); return; }
      setError("Could not connect your account. Check that your Agav key is valid, your connection works, and local credential storage is available.");
      setPhase("retry");
    } finally {
      if (active.current === controller) active.current = null;
    }
  };

  useInput((input, key) => {
    if (finished.current) return;
    if (key.escape || (key.ctrl && input === "c")) { cancel(); return; }
    if (active.current) return;
    if (phase === "retry") {
      // Retry resumes whichever route the user was on (browser vs key), chosen by
      // the current selection; B returns to the menu.
      if (key.return || input.toLowerCase() === "r") void (selected === 0 ? connectWithBrowser() : connectWithKey());
      else if (input.toLowerCase() === "b") { setPrompt(undefined); setPhase("menu"); }
      return;
    }
    if (input === "1" || input === "2") { setSelected(Number(input) - 1); return; }
    if (key.upArrow || key.downArrow) { setSelected(i => 1 - i); return; }
    if (key.return) void (selected === 0 ? connectWithBrowser() : connectWithKey());
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.bannerColor} paddingX={1}>
      <Text bold color={theme.bannerColor}>Sign in to your Agav account</Text>
      <Box marginTop={1}><Text dimColor>Sign in to use models through your Agav subscription. You can keep using Agav for free with your own API key.</Text></Box>

      {phase === "menu" && <Box marginTop={1} flexDirection="column">
        {ITEMS.map((label, index) => <Box key={label} flexDirection="column">
          <Text bold={index === selected} color={index === selected ? theme.promptColor : undefined}>{index === selected ? "❯" : " "} {index + 1}. {label}</Text>
          <Text dimColor>    {index === 0 ? "Use existing agav subscription by doing browser authentication." : "Already have a key from agav account?"}</Text>
        </Box>)}
        <Text dimColor>↑/↓ Navigate · 1/2 Select · Enter Choose · Esc / Ctrl-C Cancel</Text>
      </Box>}

      {phase === "browser" && <Box marginTop={1} flexDirection="column">
        {!prompt
          ? <Text>Starting secure sign-in…</Text>
          : <>
              <Text>
                {prompt.openedBrowser
                  ? "Opened your browser. Sign in with Google or GitHub, then approve this request."
                  : "Couldn't open a browser automatically — open this link:"}
              </Text>
              {!prompt.openedBrowser && <Text color={theme.promptColor}>{prompt.verificationUrl}</Text>}
              <Box marginTop={1}>
                <Text>Confirm this code matches the one shown in your browser: </Text>
                <Text bold color={theme.bannerColor}>{prompt.userCode}</Text>
              </Box>
              <Box marginTop={1}><Text dimColor>Waiting for approval… Esc / Ctrl-C Cancel</Text></Box>
            </>}
      </Box>}

      {phase === "entry" && <Text>Secure key entry · Ctrl-C cancels; Esc then Enter also cancels.</Text>}
      {phase === "validating" && <Text>Validating and saving your account… Esc / Ctrl-C Cancel</Text>}
      {phase === "cancelling" && <Text>Cancelling… Waiting for credential storage to finish safely.</Text>}
      {phase === "retry" && <Box marginTop={1} flexDirection="column">
        <Text color={theme.errorColor}>{error}</Text>
        <Text dimColor>Enter / R Try again · B Back to options · Esc / Ctrl-C Cancel</Text>
      </Box>}

      <Text dimColor>Account page: {accountUrl}</Text>
    </Box>
  );
}
