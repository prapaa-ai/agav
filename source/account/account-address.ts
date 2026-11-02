/**
 * Resolve the Agav consumer account-service address the CLI talks to.
 *
 * Agav runs a hosted account service, so the CLI ships a built-in default. That
 * makes consumer sign-in work out of the box, while still allowing an override
 * for staging/self-hosting. Precedence, highest first:
 *
 *   1. --account-service flag            (explicit, this invocation)
 *   2. AGAV_ACCOUNT_SERVICE env var      (dev container / shell)
 *   3. built-in hosted default           (Agav SaaS)
 *
 * The default can be overridden at build/run time via AGAV_DEFAULT_ACCOUNT_SERVICE
 * so staging builds can point elsewhere without code changes.
 *
 * This is deliberately separate from the enterprise control-plane address: the
 * two services are different products and must resolve independently.
 */

/** Agav's hosted account service. Overridable via AGAV_DEFAULT_ACCOUNT_SERVICE. */
const HOSTED_DEFAULT = "https://agav.dev";

/** The built-in default account-service address for this build. */
export function defaultAccountService(env: NodeJS.ProcessEnv = process.env): string {
  return env["AGAV_DEFAULT_ACCOUNT_SERVICE"] || HOSTED_DEFAULT;
}

export interface ResolveAccountServiceOptions {
  /** From --account-service. */
  flag?: string;
  /** Env accessor, injectable for tests. */
  env?: NodeJS.ProcessEnv;
}

/** Resolve the effective account-service address using the precedence above. */
export function resolveAccountService(options: ResolveAccountServiceOptions = {}): string {
  const env = options.env ?? process.env;
  return options.flag || env["AGAV_ACCOUNT_SERVICE"] || defaultAccountService(env);
}

export { HOSTED_DEFAULT };
