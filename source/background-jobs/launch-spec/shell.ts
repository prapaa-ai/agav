// Never assume the user's interactive shell: POSIX uses /bin/sh or /bin/bash (never $SHELL),
// Windows uses cmd.exe/powershell.exe by name.
import { BackgroundJobError, type ShellInterpreter } from "../types.js";

const POSIX_INTERPRETERS: ReadonlySet<ShellInterpreter> = new Set(["posix-sh", "bash"]);
const WINDOWS_INTERPRETERS: ReadonlySet<ShellInterpreter> = new Set(["cmd", "powershell"]);

/** Defaults to posix-sh (linux/darwin) or cmd (win32); a cross-platform request throws rather than being coerced. */
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

/** `commandText` is passed through verbatim; POSIX/Windows syntax is never translated. */
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
      // /d skips AutoRun commands; /s strips the surrounding quotes exactly once.
      return { executable: "cmd.exe", args: ["/d", "/s", "/c", commandText] };
    case "powershell":
      return { executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", commandText] };
    default: {
      const exhaustive: never = interpreter;
      throw new BackgroundJobError("unsupported-platform", `Unknown shell interpreter: ${String(exhaustive)}`);
    }
  }
}

/** Detection only: batch shims can't be exec'd directly on Windows; the platform adapter wraps them via cmd.exe at spawn time. */
export function looksLikeBatchShim(executablePath: string): boolean {
  const lower = executablePath.toLowerCase();
  return lower.endsWith(".cmd") || lower.endsWith(".bat");
}
