/**
 * Sandboxed agent tool executor.
 *
 * Runs marketplace / user-installed agent tool code in an OS-level
 * sandbox (Seatbelt or Bubblewrap) via a child subprocess.  The tool
 * module is imported only inside the sandboxed process — the main Agav
 * process never executes untrusted code directly.
 *
 * Protocol: the child process receives `{ toolPath, input }` on stdin
 * and writes a `ToolResult` JSON to stdout.  See `sandbox-exec.mjs`.
 */

import { execFile } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import type { ToolResult } from "../tools/types.js";
import { detectSandboxBackend, type SandboxBackend } from "../utils/sandbox.js";

const TOOL_TIMEOUT = 60_000;   // 60 s per tool call
const MAX_OUTPUT = 200_000;    // bytes

/**
 * Resolve the path to sandbox-exec.mjs.
 *
 * Works both in development (source/agents/) and in compiled builds
 * (build/agents/) because the .mjs file is copied alongside the
 * compiled output.
 */
function getSandboxExecPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "sandbox-exec.mjs");
}

/**
 * Build env for the sandboxed subprocess.
 *
 * Starts from a filtered copy of the current env (stripping secrets),
 * then layers on the agent's own credentials so the tool can access
 * them via `process.env` inside the sandbox.
 */
function buildSandboxEnv(agentCredentials?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val === undefined) continue;
    // Strip secrets from parent env — agent tools should only see their
    // own credentials, not the host's API keys.
    if (/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH/i.test(key)) continue;
    env[key] = val;
  }
  // Layer agent-specific credentials on top
  if (agentCredentials) {
    Object.assign(env, agentCredentials);
  }
  return env;
}

// ── Seatbelt (macOS) ─────────────────────────────────────────────

const AGENT_SEATBELT_PROFILE = `
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

function runSeatbelted(
  scriptPath: string,
  stdinPayload: string,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; error: Error | null }> {
  const home = process.env.HOME ?? "/tmp";
  const profilePath = join(tmpdir(), `agav-agent-sb-${process.pid}-${Date.now()}.sb`);
  writeFileSync(profilePath, AGENT_SEATBELT_PROFILE);

  return new Promise((resolve) => {
    const child = execFile(
      "sandbox-exec",
      [
        "-f", profilePath,
        "-D", `HOME_SSH=${home}/.ssh`,
        "-D", `HOME_AWS=${home}/.aws`,
        "-D", `HOME_GPG=${home}/.gnupg`,
        "-D", `CWD=${process.cwd()}`,
        "-D", `TMPDIR=${tmpdir()}`,
        process.execPath, scriptPath,
      ],
      { timeout: TOOL_TIMEOUT, maxBuffer: MAX_OUTPUT, env },
      (error, stdout, stderr) => {
        try { unlinkSync(profilePath); } catch {}
        resolve({ stdout, stderr, error });
      },
    );
    child.stdin?.write(stdinPayload);
    child.stdin?.end();
  });
}

// ── Bubblewrap (Linux) ───────────────────────────────────────────

function runBubblewrapped(
  scriptPath: string,
  stdinPayload: string,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; error: Error | null }> {
  const home = process.env.HOME ?? "/tmp";
  return new Promise((resolve) => {
    const child = execFile(
      "bwrap",
      [
        "--ro-bind", "/", "/",
        "--bind", process.cwd(), process.cwd(),
        "--bind", "/tmp", "/tmp",
        "--dev", "/dev",
        "--proc", "/proc",
        "--tmpfs", home + "/.ssh",
        "--tmpfs", home + "/.aws",
        "--tmpfs", home + "/.gnupg",
        "--tmpfs", home + "/.config",
        "--unshare-net",
        "--die-with-parent",
        "--chdir", process.cwd(),
        process.execPath, scriptPath,
      ],
      { timeout: TOOL_TIMEOUT, maxBuffer: MAX_OUTPUT, env },
      (error, stdout, stderr) => {
        resolve({ stdout, stderr, error });
      },
    );
    child.stdin?.write(stdinPayload);
    child.stdin?.end();
  });
}

// ── Unsandboxed fallback ─────────────────────────────────────────

function runUnsandboxed(
  scriptPath: string,
  stdinPayload: string,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; error: Error | null }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [scriptPath],
      { timeout: TOOL_TIMEOUT, maxBuffer: MAX_OUTPUT, env },
      (error, stdout, stderr) => {
        resolve({ stdout, stderr, error });
      },
    );
    child.stdin?.write(stdinPayload);
    child.stdin?.end();
  });
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Execute an agent tool's .mjs file inside an OS-level sandbox.
 *
 * The tool module is imported only inside the child process — the main
 * Agav process never runs untrusted code.
 *
 * @param toolPath  Absolute path to the tool .mjs / .js file
 * @param input     Tool input (will be JSON-serialised to the child)
 * @param credentials  Agent-specific env vars to inject (only these are visible)
 * @param forceBackend  Override the auto-detected sandbox backend
 */
export async function executeSandboxedTool(
  toolPath: string,
  input: Record<string, unknown>,
  credentials?: Record<string, string>,
  forceBackend?: SandboxBackend,
): Promise<ToolResult & { backend: SandboxBackend }> {
  const scriptPath = getSandboxExecPath();
  if (!existsSync(scriptPath)) {
    return {
      output: `Agent sandbox executor not found at ${scriptPath}. This is an Agav installation error.`,
      isError: true,
      backend: "none",
    };
  }

  const payload = JSON.stringify({ toolPath: resolve(toolPath), input });
  const env = buildSandboxEnv(credentials);
  const backend = forceBackend ?? detectSandboxBackend();

  let result: { stdout: string; stderr: string; error: Error | null };

  switch (backend) {
    case "seatbelt":
      result = await runSeatbelted(scriptPath, payload, env);
      // Fallback if sandbox-exec disappeared
      if (result.error && /ENOENT|sandbox-exec.*not found/i.test(result.error.message ?? "")) {
        result = await runUnsandboxed(scriptPath, payload, env);
        return { ...parseResult(result), backend: "none" };
      }
      break;
    case "bubblewrap":
      result = await runBubblewrapped(scriptPath, payload, env);
      if (result.error && /ENOENT|bwrap.*not found/i.test(result.error.message ?? "")) {
        result = await runUnsandboxed(scriptPath, payload, env);
        return { ...parseResult(result), backend: "none" };
      }
      break;
    case "docker":
      // Docker support for agent tools is future work — fall through to unsandboxed
      // (Docker sandbox for shell commands is already handled in sandbox.ts)
      result = await runUnsandboxed(scriptPath, payload, env);
      break;
    default:
      result = await runUnsandboxed(scriptPath, payload, env);
      break;
  }

  return { ...parseResult(result), backend };
}

/**
 * Parse the child process output into a ToolResult.
 */
function parseResult(result: {
  stdout: string;
  stderr: string;
  error: Error | null;
}): ToolResult {
  const { stdout, stderr, error } = result;

  // The child writes a single JSON object to stdout
  if (stdout.trim()) {
    try {
      const parsed = JSON.parse(stdout.trim());
      if (parsed.error) {
        return { output: parsed.error, isError: true };
      }
      return {
        output: String(parsed.output ?? ""),
        isError: Boolean(parsed.isError),
      };
    } catch {
      // stdout wasn't valid JSON — use raw output
      return { output: stdout, isError: !!error };
    }
  }

  // No stdout — build a result from stderr / error
  if (error) {
    const msg = stderr
      ? `Sandboxed tool failed: ${error.message}\n${stderr}`
      : `Sandboxed tool failed: ${error.message}`;
    return { output: msg, isError: true };
  }

  return { output: stderr || "Sandboxed tool produced no output.", isError: false };
}
