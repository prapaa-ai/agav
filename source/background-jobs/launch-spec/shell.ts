/**
 * T07 — shell interpreter resolution and invocation building.
 *
 * Pure, side-effect-free helpers: no process spawning here. This module only
 * decides *what* executable/argv a given interpreter maps to; actually
 * spawning it is the supervisor/platform adapter's job.
 *
 * Philosophy (matches source/utils/sandbox.ts): never assume the user's
 * interactive shell. On POSIX we always invoke `/bin/sh` (or `/bin/bash`
 * when explicitly requested), never `$SHELL`. On Windows we always invoke
 * `cmd.exe`/`powershell.exe` by well-known name, never an inherited/guessed
 * shell path.
 */

import { BackgroundJobError, type ShellInterpreter } from "../types.js";

const POSIX_INTERPRETERS: ReadonlySet<ShellInterpreter> = new Set(["posix-sh", "bash"]);
const WINDOWS_INTERPRETERS: ReadonlySet<ShellInterpreter> = new Set(["cmd", "powershell"]);

/**
 * Pick the interpreter to use for a given platform, honoring an explicit
 * request only when it is valid for that platform. Defaults:
 *   - linux/darwin -> "posix-sh"
 *   - win32        -> "cmd"
 *
 * Throws BackgroundJobError("unsupported-platform", ...) if the caller
 * explicitly requests an interpreter that does not belong on the target
 * platform (e.g. "cmd" on linux, "posix-sh" on win32) — we never silently
 * coerce a cross-platform request into something else.
 */
export function resolveShellInterpreter(
  platform: "linux" | "darwin" | "win32",
  requested?: ShellInterpreter,
): ShellInterpreter {
  const isWindows = platform === "win32";

  if (requested === undefined) {
    return isWindows ? "cmd" : "posix-sh";
  }

  const validSet = isWindows ? WINDOWS_INTERPRETERS : POSIX_INTERPRETERS;
  if (!validSet.has(requested)) {
    throw new BackgroundJobError(
      "unsupported-platform",
      `Shell interpreter "${requested}" is not valid on platform "${platform}" ` +
        `(expected one of: ${[...validSet].join(", ")}).`,
    );
  }
  return requested;
}

/**
 * Build the {executable, args} pair used to invoke a shell with verbatim
 * command text.
 *
 * IMPORTANT: `commandText` is passed through completely unmodified/unparsed.
 * This function NEVER attempts to translate POSIX shell syntax into Windows
 * syntax or vice versa — per solution.md §8 ("do not translate POSIX syntax
 * into Windows syntax"). The caller is responsible for choosing an
 * interpreter appropriate to the text they wrote; this function's only job
 * is wiring the chosen interpreter's standard "run this text" invocation.
 */
export function buildShellInvocation(
  interpreter: ShellInterpreter,
  commandText: string,
): { executable: string; args: string[] } {
  switch (interpreter) {
    case "posix-sh":
      return { executable: "/bin/sh", args: ["-c", commandText] };
    case "bash":
      return { executable: "/bin/bash", args: ["-c", commandText] };
    case "cmd":
      // /d - skip AutoRun registry/env commands (determinism, no surprise init)
      // /s - modify how the remainder of the command line is parsed so that
      //      surrounding quotes around the whole command text are stripped
      //      exactly once per standard cmd.exe /s quoting rules, rather than
      //      cmd re-interpreting embedded quotes itself.
      // /c - carry out the command then terminate (vs /k which stays open).
      return { executable: "cmd.exe", args: ["/d", "/s", "/c", commandText] };
    case "powershell":
      // -NoProfile: don't load user profile scripts (determinism).
      // -NonInteractive: never block waiting on a prompt.
      // -Command: everything after this is the script text, passed verbatim.
      return { executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", commandText] };
    default: {
      const exhaustive: never = interpreter;
      throw new BackgroundJobError("unsupported-platform", `Unknown shell interpreter: ${String(exhaustive)}`);
    }
  }
}

/**
 * Detection helper only: true when `executablePath` looks like a Windows
 * batch shim (`.cmd`/`.bat`, case-insensitive extension check).
 *
 * This module does NOT decide how to wrap batch shims for spawning — that is
 * the supervisor/platform adapter's responsibility at actual spawn time
 * (e.g. wrapping with `cmd.exe /d /s /c "<shim>" <args...>` instead of
 * attempting to exec the shim directly, which fails on Windows because batch
 * files are not independently executable images). This function only flags
 * that such wrapping will be needed; it performs no spawning or wrapping
 * itself.
 */
export function looksLikeBatchShim(executablePath: string): boolean {
  const lower = executablePath.toLowerCase();
  return lower.endsWith(".cmd") || lower.endsWith(".bat");
}
