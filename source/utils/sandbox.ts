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
(allow default)
(deny file-write* (subpath "/System"))
(deny file-write* (subpath "/usr"))
(deny file-write* (subpath "/Library"))
(deny file-write* (subpath "/Applications"))
(deny file-read* (subpath (param "HOME_SSH")))
(deny file-read* (subpath (param "HOME_AWS")))
(deny file-read* (subpath (param "HOME_GPG")))
(deny process-exec (subpath "/System/Library/CoreServices"))
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
  return new Promise((resolve) => {
    execFile(
      shell,
      shellArgs,
      { timeout, maxBuffer, cwd, env: filterEnv() },
      (error, stdout, stderr) => {
        resolve({ stdout, stderr, error });
      },
    );
  });
}

import {
  isDestructiveCommand,
  isBlockedCommand,
  analyzeCommandSafety,
  type CommandSafetyLevel,
  type CommandAnalysisResult,
} from "./sandbox-guard.js";

export {
  isDestructiveCommand,
  isBlockedCommand,
  analyzeCommandSafety,
  type CommandSafetyLevel,
  type CommandAnalysisResult,
};

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
