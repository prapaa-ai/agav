// Pure normalization: filesystem access is injected (`canonicalizeCwd`).
// Not handled here: isolation backend availability (authorization service) and credential resolution (caller).
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
  /** Overlaid on the minimal inherited environment (wins over it), before Windows key-casing normalization. */
  env?: Record<string, string>;
  /** Treat `env` as the complete environment (replaying an earlier-approved one, e.g. schedule dispatch). */
  envExact?: boolean;
  credentialRefs?: Record<string, string>;
  limits?: Partial<ResourceLimits>;
  recurrence?: RecurrenceBinding;
  headless?: boolean;
  /** PlatformAdapter.canonicalizePath-shaped hook; must throw if the path is missing or inaccessible. */
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

  const { env: baseEnv, missingCredentials } = input.envExact
    ? { env: {}, missingCredentials: [] }
    : buildMinimalEnvironment(input.platform, {
        inherit: input.envInherit,
        credentialRefs: input.credentialRefs,
      });
  if (missingCredentials.length > 0) {
    // Names only, never values.
    throw new BackgroundJobError(
      "not-found",
      `Missing or empty credential value(s) for: ${missingCredentials.join(", ")}`,
    );
  }
  const overlaidEnv = input.env === undefined ? baseEnv : { ...baseEnv, ...input.env };
  const env = input.platform === "win32" ? normalizeWindowsEnvKeyCasing(overlaidEnv) : overlaidEnv;

  const credentialRefs = Object.keys(input.credentialRefs ?? {});

  const limits: ResourceLimits = { ...DEFAULT_RESOURCE_LIMITS, ...(input.limits ?? {}) };

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
