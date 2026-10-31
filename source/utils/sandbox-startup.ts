export const SANDBOX_REQUIRED_UNAVAILABLE_WARNING =
  "Warning: sandboxRequired is enabled but no OS-level sandbox backend is available. " +
  "run_command calls will be refused unless they use an installed override such as sandbox: docker.\n";

export interface SandboxRequiredPolicyOptions {
  /** `--sandbox-required` CLI flag. */
  flagSet: boolean;
  /** `sandboxRequired` from config. */
  configValue: boolean | undefined;
  detectBackend: () => string;
  setRequired: (required: boolean) => void;
  warn: (message: string) => void;
}

/**
 * Apply the startup sandboxRequired policy. Returns the effective value.
 * D1: warn, don't refuse to start; run_command enforces per invocation.
 */
export function applySandboxRequiredPolicy(opts: SandboxRequiredPolicyOptions): boolean {
  const required = opts.flagSet === true || opts.configValue === true;
  opts.setRequired(required);
  if (required && opts.detectBackend() === "none") {
    opts.warn(SANDBOX_REQUIRED_UNAVAILABLE_WARNING);
  }
  return required;
}
