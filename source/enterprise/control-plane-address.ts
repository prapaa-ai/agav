/**
 * Resolve the control-plane address the CLI should sign in to.
 *
 * Agav runs a hosted control plane, so the CLI ships with a built-in default
 * address. That makes `agav login` work out of the box for the SaaS path, while
 * still letting an enterprise point at a self-hosted control plane by overriding
 * it. Precedence, highest first:
 *
 *   1. --control-plane flag           (explicit, this invocation)
 *   2. AGAV_CONTROL_PLANE env var      (dev container / shell)
 *   3. org policy `controlPlane`       (self-hosted, shipped by MDM/file)
 *   4. built-in hosted default         (Agav SaaS)
 *
 * The default can be overridden at build/run time via AGAV_DEFAULT_CONTROL_PLANE
 * so staging builds can point elsewhere without code changes.
 */

/** Agav's hosted control plane. Overridable via AGAV_DEFAULT_CONTROL_PLANE. */
const HOSTED_DEFAULT = "https://auth.agav.dev";

/** The built-in default control-plane address for this build. */
export function defaultControlPlane(env: NodeJS.ProcessEnv = process.env): string {
  return env["AGAV_DEFAULT_CONTROL_PLANE"] || HOSTED_DEFAULT;
}

export interface ResolveControlPlaneOptions {
  /** From --control-plane. */
  flag?: string;
  /** From the resolved org policy (config.controlPlane). */
  orgConfig?: string;
  /** Env accessor, injectable for tests. */
  env?: NodeJS.ProcessEnv;
}

/** Resolve the effective control-plane address using the precedence above. */
export function resolveControlPlane(options: ResolveControlPlaneOptions = {}): string {
  const env = options.env ?? process.env;
  return (
    options.flag ||
    env["AGAV_CONTROL_PLANE"] ||
    options.orgConfig ||
    defaultControlPlane(env)
  );
}

export { HOSTED_DEFAULT };
