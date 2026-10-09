/**
 * T07 — launch-spec normalization (the main deliverable of this directory).
 *
 * Pure structural normalization/validation: no process spawning, no IPC, no
 * storage. Everything that needs the real filesystem or OS is injected by
 * the caller (`canonicalizeCwd`), so this module stays unit-testable without
 * touching the real OS and without depending on a concrete PlatformAdapter.
 *
 * Explicitly NOT this module's job (left to later tasks):
 *   - validating that an isolation backend is actually available/authorized
 *     on this host (T08's concern — a capability/authorization decision);
 *   - resolving credential references against a real secret store (the
 *     caller resolves refs and hands this module the already-resolved
 *     values via `credentialRefs`);
 *   - anything involving spawning a process or talking to a supervisor.
 */

import {
  BackgroundJobError,
  DEFAULT_RESOURCE_LIMITS,
  type InvocationSpec,
  type IsolationPolicy,
  type LaunchSpec,
  type ProcessOwnershipScope,
  type RecurrenceBinding,
  type ResourceLimits,
} from "../types.js";
import { buildMinimalEnvironment, normalizeWindowsEnvKeyCasing } from "./environment.js";
import { resolveShellInterpreter } from "./shell.js";

export interface NormalizeLaunchSpecInput {
  requestId: string;
  invocation: InvocationSpec;
  cwd: string;
  platform: "linux" | "darwin" | "win32";
  isolation: IsolationPolicy;
  ownershipScope: ProcessOwnershipScope;
  envInherit?: string[];
  credentialRefs?: Record<string, string>;
  limits?: Partial<ResourceLimits>;
  recurrence?: RecurrenceBinding;
  headless?: boolean;
  /**
   * Caller-injected platform adapter hook (PlatformAdapter.canonicalizePath
   * shape). Resolves symlinks/junctions and verifies existence; must throw
   * when the path does not exist or is not accessible. Injected so this
   * module never touches the real filesystem directly.
   */
  canonicalizeCwd: (path: string) => Promise<string>;
}

function validateInvocation(invocation: InvocationSpec, platform: "linux" | "darwin" | "win32"): InvocationSpec {
  if (invocation.mode === "direct") {
    if (typeof invocation.executable !== "string" || invocation.executable.length === 0) {
      throw new BackgroundJobError("not-found", "Direct invocation requires a non-empty `executable`.");
    }
    if (!Array.isArray(invocation.args) || !invocation.args.every((a) => typeof a === "string")) {
      throw new BackgroundJobError("not-found", "Direct invocation `args` must be an array of strings.");
    }
    // Direct exec mode passes argv straight to the OS process-creation API
    // (no intermediate shell parses it), so arguments are preserved exactly
    // as given — including surrounding/embedded whitespace and non-ASCII
    // characters. No shell-escaping is applied or needed here.
    return { mode: "direct", executable: invocation.executable, args: [...invocation.args] };
  }

  if (invocation.mode === "shell") {
    if (typeof invocation.commandText !== "string") {
      throw new BackgroundJobError("not-found", "Shell invocation requires string `commandText`.");
    }
    const interpreter = resolveShellInterpreter(platform, invocation.interpreter);
    // commandText is preserved byte-for-byte: no trimming, no re-escaping.
    return { mode: "shell", interpreter, commandText: invocation.commandText };
  }

  const exhaustive: never = invocation;
  throw new BackgroundJobError("not-found", `Unknown invocation mode: ${JSON.stringify(exhaustive)}`);
}

export async function normalizeLaunchSpec(input: NormalizeLaunchSpecInput): Promise<LaunchSpec> {
  if (typeof input.requestId !== "string" || input.requestId.length === 0) {
    throw new BackgroundJobError("not-found", "normalizeLaunchSpec requires a non-empty requestId.");
  }

  const invocation = validateInvocation(input.invocation, input.platform);

  let cwd: string;
  try {
    cwd = await input.canonicalizeCwd(input.cwd);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new BackgroundJobError(
      "not-found",
      `Working directory does not exist or is not accessible: ${input.cwd} (${detail})`,
    );
  }

  const { env: baseEnv, missingCredentials } = buildMinimalEnvironment(input.platform, {
    inherit: input.envInherit,
    credentialRefs: input.credentialRefs,
  });
  if (missingCredentials.length > 0) {
    // Names only — never values — per solution.md §8.
    throw new BackgroundJobError(
      "not-found",
      `Missing or empty credential value(s) for: ${missingCredentials.join(", ")}`,
    );
  }
  const env = input.platform === "win32" ? normalizeWindowsEnvKeyCasing(baseEnv) : baseEnv;

  const credentialRefs = Object.keys(input.credentialRefs ?? {});

  const limits: ResourceLimits = { ...DEFAULT_RESOURCE_LIMITS, ...(input.limits ?? {}) };

  // Isolation policy is passed through structurally unchanged. Whether
  // `isolation.backend` is actually available/authorized on this host is a
  // capability/authorization decision that belongs to T08, not to this pure
  // normalization step.
  const isolation: IsolationPolicy = { backend: input.isolation.backend, required: input.isolation.required };

  const spec: LaunchSpec = {
    requestId: input.requestId,
    invocation,
    cwd,
    env,
    credentialRefs,
    isolation,
    ownershipScope: input.ownershipScope,
    limits,
    recurrence: input.recurrence,
    headless: input.headless ?? false,
    createdAt: new Date().toISOString(),
  };

  return spec;
}
