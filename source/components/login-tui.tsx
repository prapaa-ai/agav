import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "../ink/index.js";
import { getTheme } from "../config/theme.js";
import { readSecretFromTty } from "../account/secret-prompt.js";
import { signInWithApiKey } from "../account/account-login.js";
import { AccountAcknowledgementError, signInWithBrowser } from "../account/browser-auth.js";
import { accountEndpoint } from "../account/account-client.js";
import { HoverText, pointerSelect, usePointerMotion } from "./hover-text.js";
import { wheelSelect } from "./wheel-select.js";

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
  usePointerMotion(phase === "menu" || phase === "browser" || phase === "validating" || phase === "retry");
  const phaseRef = useRef<Phase>("menu");
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
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

  // Mouse and keyboard reports can arrive before the next frame is rendered.
  const showPhase = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  };
  const done = (result: LoginWizardResult) => {
    if (!mounted.current || finished.current) return;
    finished.current = true;
    onDone(result);
  };
  const cancel = () => {
    const current = phaseRef.current;
    // During entry only the isolated reader may handle cancellation.
    if (!mounted.current || finished.current || current === "entry" || current === "cancelling") return;
    const controller = active.current;
    if (controller) {
      controller.abort();
      if (current === "validating") {
        // Await the commit-aware save result: a cancellation after commit must
        // report success, whereas pre-commit cancellation preserves old state.
        showPhase("cancelling");
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
    showPhase("browser");
    try {
      const identity = await signInWithBrowser({
        accountService,
        signal: controller.signal,
        openBrowser,
        onPrompt: (info) => { if (mounted.current) setPrompt(info); },
        onStatus: (status) => { if (mounted.current && status === "saving") showPhase("validating"); },
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
      showPhase("retry");
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
    showPhase("entry");
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
      showPhase("validating");
      let identity;
      try {
        identity = await signInWithApiKey(key, { accountService, signal: controller.signal });
      } finally { key = undefined; }
      success(identity.email);
    } catch (error) {
      if (!mounted.current || finished.current) return;
      if (controller.signal.aborted) { done({ cancelled: true }); return; }
      // As in browser sign-in, show curated account errors, never raw exceptions.
      const { AccountError } = await import("../account/types.js");
      setError(error instanceof AccountError ? error.message : "Could not connect your account. Check that your Agav key is valid, your connection works, and local credential storage is available.");
      showPhase("retry");
    } finally {
      if (active.current === controller) active.current = null;
    }
  };

  const canChoose = (expected: Phase) =>
    mounted.current && !finished.current && !active.current && phaseRef.current === expected;
  const select = (index: number) => {
    if (!canChoose("menu")) return;
    selectedRef.current = index;
    setSelected(index);
  };
  const move = () => select(1 - selectedRef.current);
  const connect = (index: number) => void (index === 0 ? connectWithBrowser() : connectWithKey());
  const choose = (index: number) => {
    if (!canChoose("menu")) return;
    select(index);
    connect(index);
  };
  const retry = () => {
    if (canChoose("retry")) connect(selectedRef.current);
  };
  const back = () => {
    if (!canChoose("retry")) return;
    setPrompt(undefined);
    showPhase("menu");
  };

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) { cancel(); return; }
    if (phaseRef.current === "retry") {
      if (key.return || input.toLowerCase() === "r") retry();
      else if (input.toLowerCase() === "b") back();
      return;
    }
    if (input === "1" || input === "2") select(Number(input) - 1);
    else if (key.upArrow || key.downArrow) move();
    else if (key.return) choose(selectedRef.current);
  });

  const cancelAction = <HoverText onClick={cancel}>Esc / Ctrl-C Cancel</HoverText>;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.bannerColor} paddingX={1}>
      <Text bold color={theme.bannerColor}>Sign in to your Agav account</Text>
      <Box marginTop={1}><Text dimColor>Sign in to use models through your Agav subscription. You can keep using Agav for free with your own API key.</Text></Box>

      {phase === "menu" && <Box marginTop={1} flexDirection="column">
        <Box flexDirection="column" onWheel={wheelSelect(move)}>
          {ITEMS.map((label, index) => (
            <LoginOption key={label} label={label} index={index} active={index === selected} onPoint={() => select(index)} onClick={() => choose(index)} />
          ))}
        </Box>
        <Box flexWrap="wrap">
          <Text dimColor>↑/↓ Navigate · 1/2 Select · </Text>
          <HoverText onClick={() => choose(selectedRef.current)}>Enter Choose</HoverText>
          <Text dimColor> · </Text>
          {cancelAction}
        </Box>
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
              <Box marginTop={1}><Text dimColor>Waiting for approval…</Text></Box>
            </>}
        <Box>{cancelAction}</Box>
      </Box>}

      {phase === "entry" && <Text>Secure key entry · Ctrl-C cancels; Esc then Enter also cancels.</Text>}
      {phase === "validating" && <Box flexWrap="wrap">
        <Text>Validating and saving your account… </Text>
        {cancelAction}
      </Box>}
      {phase === "cancelling" && <Text>Cancelling… Waiting for credential storage to finish safely.</Text>}
      {phase === "retry" && <Box marginTop={1} flexDirection="column">
        <Text color={theme.errorColor}>{error}</Text>
        <Box flexWrap="wrap">
          <HoverText onClick={retry}>Enter / R Try again</HoverText>
          <Text dimColor> · </Text>
          <HoverText onClick={back}>B Back to options</HoverText>
          <Text dimColor> · </Text>
          {cancelAction}
        </Box>
      </Box>}

      <Text dimColor>Account page: {accountUrl}</Text>
    </Box>
  );
}

function LoginOption({ label, index, active, onPoint, onClick }: {
  label: string;
  index: number;
  active: boolean;
  onPoint: () => void;
  onClick: () => void;
}) {
  const theme = getTheme();
  return (
    <Box flexDirection="column" onClick={onClick} onMouseMove={pointerSelect(onPoint)}>
      <Text bold={active} inverse={active} color={active ? theme.promptColor : undefined}>{active ? "❯" : " "} {index + 1}. {label}</Text>
      <Text dimColor>    {index === 0 ? "Use existing agav subscription by doing browser authentication." : "Already have a key from agav account?"}</Text>
    </Box>
  );
}
