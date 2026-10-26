import { useCallback, useEffect, useRef, useState } from "react";
import type { ConfirmResult } from "../agent/loop.js";
import type { SessionRecord } from "../config/history.js";
import type { PendingSessionApproval } from "../sessions/approvals.js";
import { answerSessionApproval, subscribeSession, type SessionSnapshot } from "../sessions/client.js";

/** Presentation ownership only: selecting another session or unmounting never denies worker consent. */
export function useSessionAttachment(options: {
  initialId?: string;
  initialRuntime?: SessionRecord["runtime"];
  onSnapshot: (snapshot: SessionSnapshot) => void;
  onError: (error: Error) => void;
}) {
  const callbacks = useRef(options);
  callbacks.current = options;
  const [target, setTarget] = useState<{ id: string; generation: string } | null>(() =>
    options.initialId && options.initialRuntime ? { id: options.initialId, generation: options.initialRuntime.generation } : null);
  const targetRef = useRef(target);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const displayedRef = useRef<PendingSessionApproval | undefined>(undefined);
  const answering = useRef(false);
  const detach = useCallback(() => {
    targetRef.current = null;
    displayedRef.current = undefined;
    setTarget(null);
    setSnapshot(null);
  }, []);
  const attach = useCallback((id: string, generation: string) => {
    const next = { id, generation };
    targetRef.current = next;
    displayedRef.current = undefined;
    setSnapshot(null);
    setTarget(next);
  }, []);
  useEffect(() => {
    if (!target) return;
    return subscribeSession(target.id, {
      onSnapshot(next) {
        if (targetRef.current !== target) return;
        if (next.record.generation !== target.generation) {
          callbacks.current.onError(new Error("Session execution changed; select it again in /resume."));
          return;
        }
        // Keep identity stable between polls so a keypress for an old prompt cannot answer its successor.
        const first = next.approvals[0];
        if (displayedRef.current?.approvalId !== first?.approvalId) displayedRef.current = first;
        setSnapshot(next);
        callbacks.current.onSnapshot(next);
      },
      onError(error) { if (targetRef.current === target) callbacks.current.onError(error); },
    });
  }, [target]);
  const answer = useCallback((choice: ConfirmResult, expected: PendingSessionApproval) => {
    const selected = targetRef.current;
    if (!selected || expected !== displayedRef.current || answering.current) return;
    answering.current = true;
    void answerSessionApproval(selected.id, expected, choice).catch(error => {
      if (targetRef.current === selected) callbacks.current.onError(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => { answering.current = false; });
  }, []);
  const approval = snapshot?.approvals[0] ? displayedRef.current : undefined;
  const live = !!target && (!snapshot || ["starting", "running", "needs-approval"].includes(snapshot.record.status));
  return { attached: !!target, target: targetRef.current, live, snapshot, approval, attach, detach, answer };
}
