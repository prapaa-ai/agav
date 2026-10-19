import React, { useEffect, useMemo, useRef, useState } from "react";
import { useInput } from "../ink/index.js";
import { ResourceManager, type ResourceAction } from "./resource-manager.js";
import { createJobsAdapter, createJobSchedulesAdapter, jobCapabilities, revokeSchedule, REVOKE_SCHEDULE_CONFIRM, stopJob } from "../resources/job-adapters.js";
import type { ResourceItem } from "../resources/types.js";
import type { ConfirmSubject, GrantAction, SessionPolicySnapshot } from "../background-jobs/types.js";
import {
  backgroundConfirmationLines,
  describeBackgroundConfirmation,
  type BackgroundConfirmSpec,
} from "./background-confirmation.js";

export interface JobsTUIProps {
  onExit: () => void;
  permissionMode: SessionPolicySnapshot["permissionMode"];
  height?: number;
}

type ConfirmSpec = BackgroundConfirmSpec;

interface PendingConfirmation {
  action: GrantAction;
  spec: ConfirmSpec;
  subject?: ConfirmSubject;
  resolve(ok: boolean): void;
}

const CONFIRM_CONTROLS = "y: Approve · n/ESC: Deny";

/** Fallback when the manager cannot render `confirmationDetails`. */
function confirmationPrompt({ action, spec, subject }: PendingConfirmation): string {
  const info = describeBackgroundConfirmation(action, spec, subject);
  return `${info.label}: ${info.command}? ${CONFIRM_CONTROLS}`;
}

function confirmationDetails({ action, spec, subject }: PendingConfirmation): { lines: string[]; controls: string } {
  return { lines: backgroundConfirmationLines(describeBackgroundConfirmation(action, spec, subject)), controls: CONFIRM_CONTROLS };
}

export function JobsTUI({ onExit, permissionMode, height }: JobsTUIProps) {
  const [schedules, setSchedules] = useState(false);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const pendingRef = useRef<PendingConfirmation | null>(null);
  pendingRef.current = pending;
  // ResourceManager stays busy (ignoring input) while the action awaits this answer.
  const session = useMemo<SessionPolicySnapshot>(() => ({
    permissionMode,
    headlessApprovedActions: [],
    confirmBackgroundAction: (action, spec, subject) => new Promise<boolean>((resolve) => setPending({ action, spec, subject, resolve })),
  }), [permissionMode]);
  const jobs = useMemo(() => createJobsAdapter(), []);
  const scheduleAdapter = useMemo(() => createJobSchedulesAdapter(session), [session]);
  useEffect(() => () => { pendingRef.current?.resolve(false); pendingRef.current = null; }, []);
  useInput((input, key) => {
    if (!pending) return;
    const answer = input.toLowerCase();
    if (answer !== "y" && answer !== "n" && !key.escape) return;
    pendingRef.current = null;
    setPending(null);
    pending.resolve(answer === "y");
  });
  const actions: ResourceAction[] = [
    { key: "Tab", label: schedules ? "Jobs" : "Schedules", run: () => setSchedules(!schedules) },
    ...(schedules ? [
      // Revoked schedules report `enabled: undefined`; there is nothing left to revoke.
      { key: "x", label: "Revoke", inDetail: true, confirm: REVOKE_SCHEDULE_CONFIRM, when: (item: ResourceItem) => item.enabled !== undefined, run: async (item: Parameters<ResourceAction["run"]>[0]) => item ? revokeSchedule(item.id, session) : undefined },
    ] : [
      // Only live jobs can be stopped, so the action is hidden (and no approval is requested) otherwise.
      { key: "x", label: "Stop", inDetail: true, when: (item: ResourceItem) => item.stoppable === true, run: async (item: Parameters<ResourceAction["run"]>[0]) => item ? stopJob(item.id, session) : undefined },
    ]),
    { key: "c", label: "Capabilities", run: async () => ({ detail: await jobCapabilities() }) },
  ];
  return <ResourceManager key={String(schedules)} adapter={schedules ? scheduleAdapter : jobs} height={height} onExit={onExit} actions={actions} prompt={pending ? confirmationPrompt(pending) : undefined} promptDetails={pending ? confirmationDetails(pending) : undefined} />;
}
