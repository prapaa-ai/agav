import React, { useEffect, useMemo, useRef, useState } from "react";
import { useInput } from "../ink/index.js";
import { ResourceManager, type ResourceAction } from "./resource-manager.js";
import { createJobsAdapter, createJobSchedulesAdapter, jobCapabilities, stopJob } from "../resources/job-adapters.js";
import type { GrantAction, SessionPolicySnapshot } from "../background-jobs/types.js";

export interface JobsTUIProps {
  onExit: () => void;
  permissionMode: SessionPolicySnapshot["permissionMode"];
}

type ConfirmSpec = Parameters<NonNullable<SessionPolicySnapshot["confirmBackgroundAction"]>>[1];

interface PendingConfirmation {
  action: GrantAction;
  spec: ConfirmSpec;
  resolve(ok: boolean): void;
}

const ACTION_LABELS: Partial<Record<GrantAction, string>> = {
  stop: "Stop running job",
  "schedule-revoke": "Stop future runs of schedule",
  "schedule-create": "Allow schedule to launch",
  start: "Start job",
};

function confirmationPrompt({ action, spec }: PendingConfirmation): string {
  const command = spec.invocation.mode === "shell"
    ? spec.invocation.commandText
    : [spec.invocation.executable, ...spec.invocation.args].join(" ");
  return `${ACTION_LABELS[action] ?? action}: ${command}? y: Approve · n/ESC: Deny`;
}

/** Jobs and their schedules share one manager; Tab switches like /skills marketplace. */
export function JobsTUI({ onExit, permissionMode }: JobsTUIProps) {
  const [schedules, setSchedules] = useState(false);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const pendingRef = useRef<PendingConfirmation | null>(null);
  pendingRef.current = pending;
  // ResourceManager stays busy (ignoring input) while the action awaits this answer.
  const session = useMemo<SessionPolicySnapshot>(() => ({
    permissionMode,
    headlessApprovedActions: [],
    confirmBackgroundAction: (action, spec) => new Promise<boolean>((resolve) => setPending({ action, spec, resolve })),
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
    ...(schedules ? [] : [
      { key: "x", label: "Stop", run: async (item: Parameters<ResourceAction["run"]>[0]) => item ? stopJob(item.id, session) : undefined },
    ]),
    { key: "c", label: "Capabilities", run: async () => ({ detail: await jobCapabilities() }) },
  ];
  return <ResourceManager key={String(schedules)} adapter={schedules ? scheduleAdapter : jobs} onExit={onExit} actions={actions} prompt={pending ? confirmationPrompt(pending) : undefined} />;
}
