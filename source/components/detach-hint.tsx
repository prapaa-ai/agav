import React, { useCallback, useEffect, useRef, useState } from "react";
import { Text, useInput } from "../ink/index.js";

import { useStdinContext } from "../ink/hooks/use-stdin.js";
import type { ParsedMouse } from "../ink/parse-mouse.js";

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
  const { internal_eventEmitter, setMouseMotionTracking } = useStdinContext();
  const visible = canDetach && isLoading && ready;
  const dismiss = useCallback(() => {
    if (dismissalTimer.current !== undefined) return;
    dismissalTimer.current = setTimeout(() => setReady(false), 2000);
  }, []);
  useInput((_input, key) => {
    if (key.eventType !== "release") dismiss();
  }, { isActive: visible });
  useEffect(() => {
    if (!visible) return;
    const onMouse = (event: ParsedMouse) => {
      if (!event.wheel && (event.action === "move" || event.action === "drag")) dismiss();
    };
    internal_eventEmitter.on("mouse", onMouse);
    setMouseMotionTracking(true);
    return () => {
      internal_eventEmitter.off("mouse", onMouse);
      setMouseMotionTracking(false);
    };
  }, [visible, internal_eventEmitter, setMouseMotionTracking, dismiss]);
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
