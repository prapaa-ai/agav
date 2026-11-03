import React, { useEffect, useRef, useState } from "react";
import { Text, useInput } from "../ink/index.js";

interface Props {
  canDetach: boolean;
  isLoading: boolean;
  turnStartTime: number | null;
  sessionId?: string;
  shortcut: string;
}

/** Advertise detaching only when an ordinary worker turn is taking a while. */
export default function DetachHint({ canDetach, isLoading, turnStartTime, sessionId, shortcut }: Props) {
  const [ready, setReady] = useState(false);
  const dismissalTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useInput((_input, key) => {
    if (key.eventType === "release" || dismissalTimer.current !== undefined) return;
    dismissalTimer.current = setTimeout(() => setReady(false), 2000);
  }, { isActive: canDetach && isLoading && ready });
  useEffect(() => {
    setReady(false);
    dismissalTimer.current = undefined;
    if (!canDetach || !isLoading) return;
    const delay = Math.max(0, 30_000 - (turnStartTime === null ? 0 : Date.now() - turnStartTime));
    const timer = setTimeout(() => setReady(true), delay);
    return () => {
      clearTimeout(timer);
      clearTimeout(dismissalTimer.current);
      dismissalTimer.current = undefined;
    };
  }, [canDetach, isLoading, turnStartTime, sessionId]);

  if (!canDetach || !isLoading || !ready) return null;
  return <Text color="cyan" bold>{shortcut}: detach · worker continues · resume with /resume</Text>;
}
