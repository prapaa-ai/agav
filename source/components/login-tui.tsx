import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "../ink/index.js";
import { getTheme } from "../config/theme.js";
import { readSecretFromTty } from "../account/secret-prompt.js";
import { signInWithApiKey } from "../account/account-login.js";
import { accountEndpoint } from "../account/account-client.js";

export type LoginWizardResult = { cancelled: boolean; message?: string };
export interface LoginTUIProps {
  /** Resolved and validated once by /login; shared by browser and validation. */
  accountService: string;
  openBrowser: (url: string) => Promise<boolean>;
  onDone: (result: LoginWizardResult) => void;
}
type Phase = "menu" | "opening" | "entry" | "validating" | "cancelling" | "retry";
const ITEMS = ["Sign in with your Agav account", "Paste an Agav API key"];

/**
 * Ink owns the menu/progress screens. Secret entry temporarily suspends Ink and
 * uses the incremental raw reader: useInput alone neither receives framed paste
 * nor safely distinguishes a delayed paste opener from Escape. The reader never
 * relinquishes an unfinished frame to the composer, even after cancellation.
 */
export function LoginTUI({ accountService, openBrowser, onDone }: LoginTUIProps) {
  const theme = getTheme();
  const { suspendTerminalSync } = useApp();
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const [phase, setPhase] = useState<Phase>("menu");
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string>();
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

  const connect = async (browser: boolean) => {
    // Ref lock is synchronous, unlike a React busy-state update: coalesced Enter
    // keys cannot launch two browsers or start two saves in the same read.
    if (active.current || finished.current) return;
    const controller = new AbortController();
    active.current = controller;
    setError(undefined);
    let browserHint = `Create a key at ${accountUrl} if you don't have one yet.`;
    try {
      if (browser) {
        setPhase("opening");
        let opened = false;
        try { opened = await openBrowser(accountUrl); } catch { /* manual URL below */ }
        if (!mounted.current || controller.signal.aborted || finished.current) return;
        browserHint = opened
          ? `Browser requested. Sign in with Google or GitHub, create a key, then return here.\n${accountUrl}`
          : `Could not open your browser. Visit ${accountUrl}, sign in and create a key.`;
      }
      setPhase("entry");
      // Synchronously detach Ink before accepting any secret bytes. No secret is
      // held in component state, callbacks to App, or the ordinary composer.
      const resume = suspendTerminalSync();
      let key: string | undefined;
      try {
        stdout.write(`Sign in to Agav · API key\n${browserHint}\nThe key stays hidden and is not sent to the model or saved in prompt history.\n`);
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
      // Success wins over a late cancellation after the atomic commit boundary.
      done({ cancelled: false, message: `Signed in to your Agav account${identity.email ? ` as ${identity.email}` : ""}. Use /status to see your account.` });
    } catch {
      if (!mounted.current || finished.current) return;
      if (controller.signal.aborted) { done({ cancelled: true }); return; }
      // Do not echo untrusted errors: a failed storage/transport operation may
      // embed a credential. Keep retry guidance actionable without secret detail.
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
      if (key.return || input.toLowerCase() === "r") void connect(false);
      else if (input.toLowerCase() === "b") setPhase("menu");
      return;
    }
    if (input === "1" || input === "2") { setSelected(Number(input) - 1); return; }
    if (key.upArrow || key.downArrow) { setSelected(i => 1 - i); return; }
    if (key.return) void connect(selected === 0);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.bannerColor} paddingX={1}>
      <Text bold color={theme.bannerColor}>Sign in to your Agav account</Text>
      <Box marginTop={1}><Text dimColor>Sign in to use models through your Agav subscription. You can keep using Agav for free with your own API key.</Text></Box>
      {phase === "menu" && <Box marginTop={1} flexDirection="column">
        {ITEMS.map((label, index) => <Box key={label} flexDirection="column">
          <Text bold={index === selected} color={index === selected ? theme.promptColor : undefined}>{index === selected ? "❯" : " "} {index + 1}. {label}</Text>
          <Text dimColor>    {index === 0 ? "Sign in on the web, create a key, then paste it here." : "Already have a key? Connect it securely."}</Text>
        </Box>)}
        <Text dimColor>↑/↓ Navigate · 1/2 Select · Enter Choose · Esc / Ctrl-C Cancel</Text>
      </Box>}
      {phase === "opening" && <Text>Opening your browser… Esc / Ctrl-C Cancel</Text>}
      {phase === "entry" && <Text>Secure key entry · Ctrl-C cancels; Esc then Enter also cancels.</Text>}
      {phase === "validating" && <Text>Validating your key and saving your account… Esc / Ctrl-C Cancel</Text>}
      {phase === "cancelling" && <Text>Cancelling… Waiting for credential storage to finish safely.</Text>}
      {phase === "retry" && <Box marginTop={1} flexDirection="column">
        <Text color={theme.errorColor}>{error}</Text>
        <Text dimColor>Enter / R Paste a new key · B Back to options · Esc / Ctrl-C Cancel</Text>
      </Box>}
      <Text dimColor>Account page: {accountUrl}</Text>
    </Box>
  );
}
