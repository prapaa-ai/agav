import type { GrantAction, LaunchSpec } from "../background-jobs/types.js";

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
  /** Cron and timezone for a recurring spec. */
  schedule?: string;
  /** Environment names, credential references and headless flag, when present. */
  extras: string[];
  /** Explains that approval outlives this single invocation. */
  reuse: string;
}

/** Keep newlines/tabs but make other control characters visible instead of acting on the terminal. */
function visible(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
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
export function describeBackgroundConfirmation(action: GrantAction, spec: BackgroundConfirmSpec): BackgroundConfirmation {
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
  return {
    label: BACKGROUND_ACTION_LABELS[action] ?? action,
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

/** Plain-text lines for one-line-per-term renderers; the caller appends its own controls line. */
export function backgroundConfirmationLines(info: BackgroundConfirmation): string[] {
  return [
    `${info.label}: ${info.command}?`,
    `Directory: ${info.cwd}`,
    `Isolation: ${info.isolation}`,
    ...(info.schedule ? [`Schedule: ${info.schedule}`] : []),
    ...info.extras,
    info.reuse,
  ];
}

/** Recognizes the `{ action, spec }` input the agent loop passes for background consent. */
export function parseBackgroundConfirmInput(
  input: Record<string, unknown>,
): { action: GrantAction; spec: BackgroundConfirmSpec } | undefined {
  const { action, spec } = input;
  if (typeof action !== "string" || typeof spec !== "object" || spec === null) return undefined;
  const candidate = spec as Partial<BackgroundConfirmSpec>;
  const invocation = candidate.invocation;
  if (typeof candidate.cwd !== "string" || !candidate.isolation || !invocation) return undefined;
  if (invocation.mode === "shell" ? typeof invocation.commandText !== "string"
    : !(typeof invocation.executable === "string" && Array.isArray(invocation.args))) return undefined;
  return { action: action as GrantAction, spec: candidate as BackgroundConfirmSpec };
}
