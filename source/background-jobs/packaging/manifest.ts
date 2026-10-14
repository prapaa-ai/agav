/**
 * T09 — Static packaging/runtime manifest for the background-jobs supervisor.
 *
 * These constants exist so the supervisor-launch path never has to guess at
 * runtime requirements or invoke a bundled/downloaded interpreter. Per
 * README.md "Native packaging/runtime strategy" (T01), the supervisor is
 * always invoked with the currently-running Node binary.
 */

/**
 * Describes the runtime the compiled supervisor entry requires.
 *
 * `minNodeVersion` mirrors this repo's own `engines.node` constraint in
 * package.json (">=22.13.0") — the supervisor targets the same minimum
 * Node version as the CLI itself, since it is launched by the same binary.
 */
export const SUPERVISOR_RUNTIME = {
  kind: "node" as const,
  minNodeVersion: "22.13.0",
};

/**
 * How to invoke the supervisor entry as a child process.
 *
 * Always resolves to the currently-running Node executable
 * (`process.execPath`) with no extra prepended arguments — never a bundled
 * or separately-downloaded runtime. This matches the existing
 * `agents/sandbox-exec.mjs` precedent, which is likewise launched via the
 * active Node binary rather than a packaged interpreter.
 */
export function getNodeRuntimeInvocation(): { executable: string; prependArgs: string[] } {
  return {
    executable: process.execPath,
    prependArgs: [],
  };
}

/**
 * One entry in the native-helper asset manifest for a given platform/arch
 * pairing.
 */
export interface AssetManifestEntry {
  platform: "linux" | "darwin" | "win32";
  arch: "x64" | "arm64";
  relativePath: string;
}

/**
 * Native Windows Job Object helper binaries bundled with this delivery.
 *
 * Intentionally empty: T04's handoff confirmed there is no C/C++ toolchain
 * target in this environment, so no native Windows Job Object helper binary
 * is bundled in this delivery. See `platform/windows.ts` for the resulting
 * fail-closed capability reporting (`nativeHelperAvailable: false`) that
 * this implies — the Windows adapter refuses to claim Job Object tree
 * ownership rather than silently falling back to raw PID tracking.
 */
export const WINDOWS_HELPER_ASSETS: AssetManifestEntry[] = [];

/** Private self-reexec mode; not a user command or an authorization bypass. */
export const SUPERVISOR_INTERNAL_FLAG = "--internal-background-jobs-supervisor";

/**
 * Private headless mode that runs exactly one background-jobs tick and exits
 * without rendering the Ink UI. Invoked by packaged binaries and OS-scheduler
 * entries (systemd/launchd/Task Scheduler); not a user command, never listed
 * in `--help`, and not an authorization bypass.
 */
export const BACKGROUND_TICK_INTERNAL_FLAG = "--internal-background-jobs-tick";

/** Every private self-reexec flag recognised as `process.argv[2]` by `cli.tsx`. */
export const INTERNAL_FLAGS = [SUPERVISOR_INTERNAL_FLAG, BACKGROUND_TICK_INTERNAL_FLAG] as const;

/**
 * Arguments that make the current executable run one headless tick.
 * Standalone binaries reexec themselves directly; Node installs must prepend
 * the CLI entry script (`cliEntryPath`) before the flag.
 */
export function getBackgroundTickArgs(cliEntryPath?: string): string[] {
  return cliEntryPath ? [cliEntryPath, BACKGROUND_TICK_INTERNAL_FLAG] : [BACKGROUND_TICK_INTERNAL_FLAG];
}

/** Bun standalone module URLs are virtual, not externally executable JS files. */
export function isStandaloneBinary(moduleUrl: string = import.meta.url): boolean {
  return /^file:\/\/\/(?:\$bunfs\/|[a-z]:\/(?:~|%7e)BUN\/)/i.test(moduleUrl);
}
