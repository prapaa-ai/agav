import stringWidth from "string-width";
import type { ConfirmSubject, GrantAction, LaunchSpec } from "../background-jobs/types.js";

/** Consent-relevant spec handed to `confirmBackgroundAction`. */
export type BackgroundConfirmSpec = Omit<LaunchSpec, "requestId" | "createdAt">;

export const BACKGROUND_ACTION_LABELS: Partial<Record<GrantAction, string>> = {
  stop: "Stop running job",
  "schedule-revoke": "Stop future runs of schedule",
  "schedule-create": "Allow schedule to launch",
  start: "Start job",
};

export interface BackgroundConfirmation {
  label: string;
  /** Full, untruncated command text. */
  command: string;
  cwd: string;
  isolation: string;
  /** True when no sandbox applies; callers should make this stand out. */
  unrestricted: boolean;
  schedule?: string;
  /** Set for actions on an existing job (stop): a short summary instead of the full launch terms. */
  job?: { id: string; parent: string };
  extras: string[];
  /** Explains that approval outlives this single invocation. */
  reuse: string;
}

/** Keep newlines/tabs but make other control characters visible instead of acting on the terminal. */
function visible(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

export function detailViewport(lines: string[], columns: number, maxRows: number): { contentRows: number; rows: number; overflows: boolean } {
  const width = Math.max(1, columns);
  const contentRows = lines.reduce((sum, line) => sum + line.split("\n").reduce((n, part) => n + Math.max(1, Math.ceil(stringWidth(part) / width)), 0), 0);
  const rows = Math.min(contentRows, Math.max(1, maxRows));
  return { contentRows, rows, overflows: contentRows > rows };
}

function describeIsolation(spec: BackgroundConfirmSpec): { text: string; unrestricted: boolean } {
  if (!spec.isolation) return { text: "unspecified — treat as unrestricted", unrestricted: true };
  const { backend, required } = spec.isolation;
  if (backend === "none") {
    return { text: "NONE — unrestricted execution, no sandbox (full access as your OS user)", unrestricted: true };
  }
  if (backend === "job-object") {
    return { text: `job-object${required ? " (required)" : ""} — process ownership only, NOT a filesystem/network sandbox`, unrestricted: false };
  }
  return { text: `${backend}${required ? " (required)" : ""}`, unrestricted: false };
}

function reuseNotice(action: GrantAction): string {
  switch (action) {
    case "start":
      return "Approval is reusable: this exact command, directory and isolation can be started again later without asking. Any change asks again.";
    case "schedule-create":
      return "Approval is reusable: every future run of this exact schedule launches without asking again, until it is revoked.";
    default:
      return "Approval is reusable: the same action for this exact spec will not ask again. Any change asks again.";
  }
}

/** Gathers every term the user must see before approving; nothing here is truncated. */
export function describeBackgroundConfirmation(action: GrantAction, spec: BackgroundConfirmSpec, subject?: ConfirmSubject): BackgroundConfirmation {
  const command = !spec.invocation ? "(unspecified)"
    : spec.invocation.mode === "shell"
      ? spec.invocation.commandText
      : [spec.invocation.executable, ...spec.invocation.args].join(" ");
  const isolation = describeIsolation(spec);
  const extras: string[] = [];
  const envNames = Object.keys(spec.env ?? {});
  if (envNames.length > 0) extras.push(`Environment: ${visible(envNames.join(", "))}`);
  if (spec.credentialRefs?.length) extras.push(`Credentials: ${visible(spec.credentialRefs.join(", "))}`);
  if (spec.headless) extras.push("Headless: yes");
  const job = action === "stop" && subject
    ? {
        id: visible(subject.jobId),
        parent: subject.parent
          ? `schedule ${visible(subject.parent.scheduleId)}${subject.parent.cron ? ` (cron "${visible(subject.parent.cron)}")` : ""}`
          : "none (independent run)",
      }
    : undefined;
  return {
    label: BACKGROUND_ACTION_LABELS[action] ?? action,
    job,
    command: visible(command),
    cwd: visible(spec.cwd ?? "(unspecified)"),
    isolation: isolation.text,
    unrestricted: isolation.unrestricted,
    schedule: spec.recurrence
      ? `cron "${visible(spec.recurrence.cron ?? "(unspecified)")}" · timezone ${visible(spec.recurrence.timezone ?? "(unspecified)")} — repeats automatically`
      : undefined,
    extras,
    reuse: reuseNotice(action),
  };
}

export function backgroundConfirmationLines(info: BackgroundConfirmation): string[] {
  if (info.job) return [`${info.label}: ${info.command}?`, `Job: ${info.job.id}`, `Parent: ${info.job.parent}`];
  return [
    `${info.label}: ${info.command}?`,
    `Directory: ${info.cwd}`,
    `Isolation: ${info.isolation}`,
    ...(info.schedule ? [`Schedule: ${info.schedule}`] : []),
    ...info.extras,
    info.reuse,
  ];
}

export function parseBackgroundConfirmInput(
  input: Record<string, unknown>,
): { action: GrantAction; spec: BackgroundConfirmSpec; subject?: ConfirmSubject } | undefined {
  const { action, spec, subject } = input;
  if (typeof action !== "string" || typeof spec !== "object" || spec === null) return undefined;
  const candidate = spec as Partial<BackgroundConfirmSpec>;
  const invocation = candidate.invocation;
  if (typeof candidate.cwd !== "string" || !candidate.isolation || !invocation) return undefined;
  if (invocation.mode === "shell" ? typeof invocation.commandText !== "string"
    : !(typeof invocation.executable === "string" && Array.isArray(invocation.args))) return undefined;
  const parsedSubject = typeof subject === "object" && subject !== null && typeof (subject as ConfirmSubject).jobId === "string"
    ? (subject as ConfirmSubject)
    : undefined;
  return { action: action as GrantAction, spec: candidate as BackgroundConfirmSpec, subject: parsedSubject };
}
