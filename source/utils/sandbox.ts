import { execFile, execFileSync } from "node:child_process";
import { platform } from "node:os";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export type SandboxBackend = "seatbelt" | "bubblewrap" | "docker" | "none";

let detectedBackend: SandboxBackend | null = null;

function canExec(cmd: string): boolean {
  try {
    // Use command -v which works in sh/bash/zsh and doesn't depend on 'which' being installed
    execFileSync("/bin/sh", ["-c", `command -v ${cmd}`], { stdio: "pipe", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export function detectSandboxBackend(): SandboxBackend {
  // Always respect the env var — check every call, not just first
  if (process.env["AGAV_NO_SANDBOX"] === "1") {
    return "none";
  }

  if (detectedBackend !== null) return detectedBackend;

  // Windows has no sandbox-exec or bwrap.  Attempting the `/bin/sh` probes
  // there just spawns two doomed child processes, adding to the child-process
  // count that triggers Bun's non-deterministic JSC heap-corruption segfault
  // on Windows (oven-sh/bun#23177, oven-sh/bun#30745).
  if (platform() === "win32") {
    detectedBackend = "none";
    return detectedBackend;
  }

  // Check what's actually available at runtime
  if (canExec("sandbox-exec")) {
    detectedBackend = "seatbelt";
  } else if (canExec("bwrap")) {
    detectedBackend = "bubblewrap";
  } else {
    detectedBackend = "none";
  }

  return detectedBackend;
}

export function getSandboxName(): string {
  const names: Record<SandboxBackend, string> = {
    seatbelt: "macOS Seatbelt",
    bubblewrap: "Linux Bubblewrap",
    docker: "Docker",
    none: "none (unsandboxed)",
  };
  return names[detectSandboxBackend()];
}

function filterEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val === undefined) continue;
    if (/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH/i.test(key)) continue;
    env[key] = val;
  }
  return env;
}

const SEATBELT_PROFILE = `
(version 1)
(deny default)

;; --- process execution ---
(allow process-exec)
(deny process-exec (subpath "/System/Library/CoreServices"))
(allow process-fork)
(allow signal (target self))

;; --- filesystem reads ---
(allow file-read*)
(deny file-read* (subpath (param "HOME_SSH")))
(deny file-read* (subpath (param "HOME_AWS")))
(deny file-read* (subpath (param "HOME_GPG")))

;; --- filesystem writes: only CWD and temp ---
(allow file-write* (subpath (param "CWD")))
(allow file-write* (subpath (param "TMPDIR")))
(allow file-write* (literal "/dev/null"))
(allow file-write* (literal "/dev/dtracehelper"))
(deny file-write* (subpath "/System"))
(deny file-write* (subpath "/usr"))
(deny file-write* (subpath "/Library"))
(deny file-write* (subpath "/Applications"))

;; --- network: blocked ---
(deny network*)

;; --- IPC / mach / sysctl (required for basic process operation) ---
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm-read-data)
(allow ipc-posix-shm-write-data)
(allow ipc-posix-shm-write-create)
`;

function runSeatbelt(
  command: string,
  cwd: string,
  timeout: number,
  maxBuffer: number,
): Promise<{ stdout: string; stderr: string; error: Error | null }> {
  const home = process.env.HOME ?? "/tmp";
  const profilePath = join(tmpdir(), `agav-sandbox-${process.pid}.sb`);
  writeFileSync(profilePath, SEATBELT_PROFILE);

  return new Promise((resolve) => {
    execFile(
      "sandbox-exec",
      [
        "-f", profilePath,
        "-D", `HOME_SSH=${home}/.ssh`,
        "-D", `HOME_AWS=${home}/.aws`,
        "-D", `HOME_GPG=${home}/.gnupg`,
        "-D", `CWD=${cwd}`,
        "-D", `TMPDIR=${tmpdir()}`,
        "/bin/sh", "-c", command,
      ],
      { timeout, maxBuffer, cwd, env: filterEnv() },
      (error, stdout, stderr) => {
        try { unlinkSync(profilePath); } catch {}
        resolve({ stdout, stderr, error });
      },
    );
  });
}

function runBubblewrap(
  command: string,
  cwd: string,
  timeout: number,
  maxBuffer: number,
): Promise<{ stdout: string; stderr: string; error: Error | null }> {
  const home = process.env.HOME ?? "/tmp";
  return new Promise((resolve) => {
    execFile(
      "bwrap",
      [
        "--ro-bind", "/", "/",
        "--bind", cwd, cwd,
        "--bind", "/tmp", "/tmp",
        "--dev", "/dev",
        "--proc", "/proc",
        "--tmpfs", home + "/.ssh",
        "--tmpfs", home + "/.aws",
        "--tmpfs", home + "/.gnupg",
        "--tmpfs", home + "/.config",
        "--unshare-net",
        "--die-with-parent",
        "--chdir", cwd,
        "/bin/sh", "-c", command,
      ],
      { timeout, maxBuffer, env: filterEnv() },
      (error, stdout, stderr) => {
        resolve({ stdout, stderr, error });
      },
    );
  });
}

function runDocker(
  command: string,
  cwd: string,
  timeout: number,
  maxBuffer: number,
): Promise<{ stdout: string; stderr: string; error: Error | null }> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      [
        "run", "--rm",
        "--network=none",
        "--memory=512m",
        "--cpus=1",
        "-v", `${cwd}:/workspace`,
        "-w", "/workspace",
        "node:22-slim",
        "/bin/sh", "-c", command,
      ],
      { timeout: timeout + 10_000, maxBuffer },
      (error, stdout, stderr) => {
        resolve({ stdout, stderr, error });
      },
    );
  });
}

function runUnsandboxed(
  command: string,
  cwd: string,
  timeout: number,
  maxBuffer: number,
): Promise<{ stdout: string; stderr: string; error: Error | null }> {
  const isWindows = platform() === "win32";
  const shell = isWindows ? "cmd.exe" : "/bin/sh";
  const shellArgs = isWindows ? ["/c", command] : ["-c", command];
  const env = filterEnv();
  if (isWindows) {
    // On Windows there is no kernel-level sandbox. Apply env-var shaping as a
    // best-effort mitigation: mark the process as sandboxed so well-behaved
    // tools can self-restrict, and strip proxy vars to reduce network reach.
    env["AGAV_SANDBOX_ACTIVE"] = "1";
    delete env["HTTP_PROXY"];
    delete env["HTTPS_PROXY"];
    delete env["ALL_PROXY"];
    delete env["http_proxy"];
    delete env["https_proxy"];
    delete env["all_proxy"];
  }
  return new Promise((resolve) => {
    execFile(
      shell,
      shellArgs,
      { timeout, maxBuffer, cwd, env },
      (error, stdout, stderr) => {
        resolve({ stdout, stderr, error });
      },
    );
  });
}

const DESTRUCTIVE_PATTERNS = [
  /\brm\s+-rf\s+[/~]/,
  /\brm\s+-rf\s+\.\s*$/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+push\s+--force/,
  /\bgit\s+push\s+-f\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
  /\bgit\s+branch\s+-D\b/,
  /\bsudo\s+rm\b/,
  /\bsudo\s+dd\b/,
  /\bdd\s+if=/,
  /\bmkfs\./,
  /\bchmod\s+-R\s+777/,
  /\bchown\s+-R\b/,
  /\b>\s*\/dev\/sd/,
  /\bdropdb\b/i,
  /\bdrop\s+database\b/i,
  /\bkillall\b/,
  /\bpkill\s+-9/,
  /\bcurl\s+.*\|\s*sh\b/,
  /\bwget\s+.*\|\s*(sh|bash)\b/,
  /\btruncate\b.*--size\s+0/,
];

export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
}

export interface SandboxOptions {
  command: string;
  cwd: string;
  timeout: number;
  maxBuffer: number;
  forceBackend?: SandboxBackend;
}

export async function runInSandbox(opts: SandboxOptions): Promise<{
  stdout: string;
  stderr: string;
  error: Error | null;
  backend: SandboxBackend;
}> {
  const backend = opts.forceBackend ?? detectSandboxBackend();

  let result: { stdout: string; stderr: string; error: Error | null };

  switch (backend) {
    case "seatbelt":
      result = await runSeatbelt(opts.command, opts.cwd, opts.timeout, opts.maxBuffer);
      if (result.error && /ENOENT|sandbox-exec.*not found/i.test(result.error.message ?? "")) {
        detectedBackend = "none";
        result = await runUnsandboxed(opts.command, opts.cwd, opts.timeout, opts.maxBuffer);
        return { ...result, backend: "none" };
      }
      break;
    case "bubblewrap":
      result = await runBubblewrap(opts.command, opts.cwd, opts.timeout, opts.maxBuffer);
      if (result.error && /ENOENT|bwrap.*not found/i.test(result.error.message ?? "")) {
        detectedBackend = "none";
        result = await runUnsandboxed(opts.command, opts.cwd, opts.timeout, opts.maxBuffer);
        return { ...result, backend: "none" };
      }
      break;
    case "docker":
      result = await runDocker(opts.command, opts.cwd, opts.timeout, opts.maxBuffer);
      break;
    default:
      result = await runUnsandboxed(opts.command, opts.cwd, opts.timeout, opts.maxBuffer);
      break;
  }

  return { ...result, backend };
}

/**
 * Throw if no OS-level sandbox backend is available. Used when
 * `sandboxRequired` is enabled in config or via `--sandbox-required`.
 */
export function requireSandbox(): void {
  const backend = detectSandboxBackend();
  if (backend === "none") {
    throw new Error(
      "Sandbox required but no sandbox backend is available. " +
      "Install sandbox-exec (macOS) or bubblewrap (Linux), use --sandbox docker, " +
      "or remove the sandboxRequired setting to run without a sandbox.",
    );
  }
}
