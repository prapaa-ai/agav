import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const activeCommands = new Set<() => void>();
let exitCleanupInstalled = false;

/** Own the whole POSIX process group, not just the shell at its head. */
function execCommand(
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; cwd?: string; env?: Record<string, string> },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
  signal?: AbortSignal,
): void {
  if (signal?.aborted) {
    callback(new Error("Command cancelled."), "", "");
    return;
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const bytes = { stdout: 0, stderr: 0 };
  // Share process ownership, graceful termination and pipe drainage with the
  // streaming runner; only output retention differs.
  executeProcess(file, args, options, (chunk, stream) => {
    const remaining = Math.max(0, options.maxBuffer - bytes[stream]);
    (stream === "stdout" ? stdout : stderr).push(chunk.subarray(0, remaining));
    bytes[stream] += chunk.length;
    if (chunk.length > remaining) throw new Error("Command output exceeded maxBuffer.");
  }, error => {
    callback(error, Buffer.concat(stdout).toString(), Buffer.concat(stderr).toString());
  }, signal);
}
import { platform } from "node:os";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, userInfo } from "node:os";

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
    if (/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH|(?:^|_)PAT(?:$|_)|NODE_OPTIONS|LD_PRELOAD|BASH_ENV|PROMPT_COMMAND/i.test(key)) continue;
    if (typeof val === "string" && val.match(/:\/\/[^:]+:[^@]+@/)) continue;
    env[key] = val;
  }
  return env;
}

// Rules use last-match-wins semantics. The blanket $HOME write deny protects
// the user's home, then targeted allows restore the well-known cache/config
// directories that ordinary tooling (npm, pip, git, language version managers)
// must write to — otherwise those commands fail with "Operation not permitted".
// The credential-directory denies are listed last so a broad allow can never
// re-expose ~/.ssh, ~/.aws, or ~/.gnupg.
const SEATBELT_PROFILE = `
(version 1)
(allow default)
(deny file-write* (subpath "/System"))
(deny file-write* (subpath "/usr"))
(deny file-write* (subpath "/Library"))
(deny file-write* (subpath "/Applications"))
(deny file-write* (subpath (param "HOME")))
(allow file-write* (subpath (param "CWD")))
(allow file-write* (subpath (param "HOME_CACHE")))
(allow file-write* (subpath (param "HOME_CONFIG")))
(allow file-write* (subpath (param "HOME_LOCAL")))
(allow file-write* (subpath (param "HOME_NPM")))
(allow file-write* (subpath (param "HOME_CARGO")))
(deny file-write* (subpath (param "HOME_SSH")))
(deny file-write* (subpath (param "HOME_AWS")))
(deny file-write* (subpath (param "HOME_GPG")))
(deny file-read* (subpath (param "HOME_SSH")))
(deny file-read* (subpath (param "HOME_AWS")))
(deny file-read* (subpath (param "HOME_GPG")))
(deny process-exec (subpath "/System/Library/CoreServices"))
`;

type OutputCallback = (chunk: Buffer, stream: "stdout" | "stderr") => void;

// Streaming callers own output capture; buffered non-Docker callers retain
// process-group ownership and cancellation through execCommand.
function executeProcess(
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; cwd?: string; env?: Record<string, string> },
  onOutput: OutputCallback | undefined,
  callback: (error: Error | null, stdout: string, stderr: string) => void,
  signal?: AbortSignal,
): void {
  if (!onOutput) {
    execCommand(file, args, options, callback, signal);
    return;
  }

  if (signal?.aborted) {
    callback(new Error("Command cancelled."), "", "");
    return;
  }

  const windows = platform() === "win32";
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    // Noninteractive commands intentionally have no controlling terminal.
    // Own a Unix process group so cancellation also reaches inherited children.
    detached: !windows,
  });
  let error: Error | null = null;
  let timedOut = false;
  let completed = false;
  let stopping = false;
  let exitStatus: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let drainage: ReturnType<typeof setTimeout> | undefined;
  const killTree = (force: boolean) => {
    if (windows && child.pid !== undefined) {
      // cmd.exe kill alone leaves descendants alive. taskkill /T handles the tree.
      execFile("taskkill", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])],
        { timeout: 150 }, () => {});
    } else if (!windows && child.pid !== undefined) {
      try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch {}
    } else {
      try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {}
    }
  };
  const finish = (code: number | null, exitSignal: NodeJS.Signals | null) => {
    if (completed) return;
    completed = true;
    signal?.removeEventListener("abort", onAbort);
    activeCommands.delete(cleanup);
    if (exitStatus) { code = exitStatus.code; exitSignal = exitStatus.signal; }
    if (timer) clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    if (drainage) clearTimeout(drainage);
    if (stopping) killTree(true);
    // Bound inherited pipes without turning a successful leader into a timeout.
    const leaderSucceeded = exitStatus?.code === 0 && !exitStatus.signal;
    if (timedOut && !leaderSucceeded) error = new Error(`Command timed out after ${options.timeout}ms`);
    else if (!error && (code !== 0 || exitSignal)) {
      error = new Error(exitSignal ? `Command terminated by signal ${exitSignal}` : `Command exited with code ${code}`);
    }
    // Streaming callers own output capture; do not retain a second copy here.
    callback(error, "", "");
  };
  const stop = () => {
    if (stopping || completed) return;
    stopping = true;
    killTree(false);
    escalation = setTimeout(() => killTree(true), 150);
    // Escaped descendants may retain pipes even after the group is killed. Give
    // pending output a bounded chance to drain, then close our pipe handles.
    drainage = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(null, null);
    }, 300);
  };
  const cleanup = () => killTree(true);
  const onAbort = () => {
    error = new Error("Command cancelled.");
    stop();
  };
  const timer = options.timeout > 0 ? setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeout) : undefined;
  const emit = (chunk: Buffer, stream: "stdout" | "stderr") => {
    if (completed) return;
    try {
      onOutput(chunk, stream);
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error(String(cause));
      stop();
    }
  };
  child.stdout.on("data", (chunk: Buffer) => emit(chunk, "stdout"));
  child.stderr.on("data", (chunk: Buffer) => emit(chunk, "stderr"));
  child.on("error", (cause) => { error = cause; stop(); });
  child.once("exit", (code, exitSignal) => {
    exitStatus = { code, signal: exitSignal };
    // Successful background children may still produce output. Keep the timeout
    // until close, but terminate descendants when their leader fails.
    if (code !== 0 || exitSignal) stop();
  });
  child.on("close", finish);
  activeCommands.add(cleanup);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  if (!exitCleanupInstalled) {
    exitCleanupInstalled = true;
    process.once("exit", () => { for (const stop of activeCommands) stop(); });
  }
}

function runSeatbelt(
  command: string,
  cwd: string,
  timeout: number,
  maxBuffer: number,
  onOutput?: OutputCallback,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; error: Error | null }> {
  const home = process.env.HOME ?? "/tmp";
  const profilePath = join(tmpdir(), `agav-sandbox-${process.pid}-${randomUUID()}.sb`);
  writeFileSync(profilePath, SEATBELT_PROFILE);

  return new Promise((resolve) => {
    executeProcess(
      "sandbox-exec",
      [
        "-f", profilePath,
        "-D", `HOME=${home}`,
        "-D", `CWD=${cwd}`,
        "-D", `HOME_CACHE=${home}/.cache`,
        "-D", `HOME_CONFIG=${home}/.config`,
        "-D", `HOME_LOCAL=${home}/.local`,
        "-D", `HOME_NPM=${home}/.npm`,
        "-D", `HOME_CARGO=${home}/.cargo`,
        "-D", `HOME_SSH=${home}/.ssh`,
        "-D", `HOME_AWS=${home}/.aws`,
        "-D", `HOME_GPG=${home}/.gnupg`,
        "/bin/sh", "-c", command,
      ],
      { timeout, maxBuffer, cwd, env: filterEnv() },
      onOutput,
      (error, stdout, stderr) => {
        try { unlinkSync(profilePath); } catch {}
        resolve({ stdout, stderr, error });
      },
      signal,
    );
  });
}

function runBubblewrap(
  command: string,
  cwd: string,
  timeout: number,
  maxBuffer: number,
  onOutput?: OutputCallback,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; error: Error | null }> {
  const home = process.env.HOME ?? "/tmp";
  return new Promise((resolve) => {
    executeProcess(
      "bwrap",
      [
        "--ro-bind", "/", "/",
        "--bind", cwd, cwd,
        "--tmpfs", "/tmp",
        "--dev", "/dev",
        "--proc", "/proc",
        // Empty, writable tmpfs over the credential directories hides their
        // contents from the sandbox while still letting a tool that probes them
        // succeed against an empty dir.
        "--tmpfs", home + "/.ssh",
        "--tmpfs", home + "/.aws",
        "--tmpfs", home + "/.gnupg",
        // The rest of $HOME is read-only via the root ro-bind, which breaks
        // tooling that must write to its cache/config dirs (npm, pip, cargo,
        // git). Give each a writable scratch tmpfs so those commands work
        // without exposing or persisting anything on the host.
        "--tmpfs", home + "/.cache",
        "--tmpfs", home + "/.config",
        "--tmpfs", home + "/.local",
        "--tmpfs", home + "/.npm",
        "--tmpfs", home + "/.cargo",
        "--die-with-parent",
        "--chdir", cwd,
        "/bin/sh", "-c", command,
      ],
      { timeout, maxBuffer, env: filterEnv() },
      onOutput,
      (error, stdout, stderr) => {
        resolve({ stdout, stderr, error });
      },
      signal,
    );
  });
}

interface DockerSecurity {
  isRootless: boolean;
  isUserns: boolean;
}

let dockerSecurity: DockerSecurity | null = null;

function checkDockerSecurity(): Promise<DockerSecurity> {
  if (dockerSecurity !== null) return Promise.resolve(dockerSecurity);
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["info", "--format", "{{.SecurityOptions}}"],
      { timeout: 2000 },
      (err, stdout) => {
        dockerSecurity = {
          isRootless: stdout ? stdout.includes("name=rootless") : false,
          isUserns: stdout ? stdout.includes("name=userns") : false,
        };
        resolve(dockerSecurity);
      }
    );
  });
}

function runDocker(
  command: string,
  cwd: string,
  timeout: number,
  maxBuffer: number,
  onOutput?: OutputCallback,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; error: Error | null }> {
  let uid = 1000;
  let gid = 1000;
  try {
    const info = userInfo();
    uid = info.uid >= 0 ? info.uid : 1000;
    gid = info.gid >= 0 ? info.gid : 1000;
  } catch {}

  return new Promise((resolve) => {
    checkDockerSecurity().then((security) => {
      if (signal?.aborted) {
        resolve({ stdout: "", stderr: "", error: new Error("Command cancelled.") });
        return;
      }
      const dockerArgs = [
        "run", "--rm",
        "--network=none",
        "--memory=512m",
        "--cpus=1",
        "-e", "HOME=/workspace",
        "-e", "USER=agav",
      ];

      // If daemon-level userns-remap is active (and not rootless), we must explicitly
      // bypass user namespaces to allow -u uid:gid to map to the real host user 
      // instead of a subordinate host UID.
      if (security.isUserns && !security.isRootless) {
        dockerArgs.push("--userns=host");
      }

      // Omit UID mapping only if true rootless Docker is handling user namespaces
      if (!security.isRootless) {
        dockerArgs.push("-u", `${uid}:${gid}`);
      }

      dockerArgs.push(
        "-v", `${cwd}:/workspace`,
        "-w", "/workspace",
        "node:22-slim",
        "/bin/sh", "-c", command
      );

      const callback = (error: Error | null, stdout: string, stderr: string) => {
        resolve({ stdout, stderr, error });
      };
      const options = { timeout: timeout + 10_000, maxBuffer };
      if (onOutput) {
        executeProcess("docker", dockerArgs, options, onOutput, callback, signal);
      } else {
        // Abort the local CLI promptly. Docker daemon-side/container cleanup is
        // not guaranteed by killing the CLI (including the streaming path).
        execFile("docker", dockerArgs, { ...options, signal }, callback);
      }
    });
  });
}

function runUnsandboxed(
  command: string,
  cwd: string,
  timeout: number,
  maxBuffer: number,
  onOutput?: OutputCallback,
  signal?: AbortSignal,
  inheritEnv = false,
): Promise<{ stdout: string; stderr: string; error: Error | null }> {
  const isWindows = platform() === "win32";
  const shell = isWindows ? "cmd.exe" : "/bin/sh";
  const shellArgs = isWindows ? ["/c", command] : ["-c", command];
  return new Promise((resolve) => {
    executeProcess(
      shell,
      shellArgs,
      { timeout, maxBuffer, cwd, env: inheritEnv ? undefined : filterEnv() },
      onOutput,
      (error, stdout, stderr) => {
        resolve({ stdout, stderr, error });
      },
      signal,
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
  /** Preserve legacy skill-shell inheritance; only honored with forceBackend: "none". */
  inheritEnv?: boolean;
  signal?: AbortSignal;
  /** Streams raw output in observed arrival order; stdout/stderr results are empty. */
  onOutput?: OutputCallback;
}

export async function runInSandbox(opts: SandboxOptions): Promise<{
  stdout: string;
  stderr: string;
  error: Error | null;
  backend: SandboxBackend;
}> {
  const backend = opts.forceBackend ?? detectSandboxBackend();
  if (opts.signal?.aborted) {
    return { stdout: "", stderr: "", error: new Error("Command cancelled."), backend };
  }

  let result: { stdout: string; stderr: string; error: Error | null };

  switch (backend) {
    case "seatbelt":
      result = await runSeatbelt(opts.command, opts.cwd, opts.timeout, opts.maxBuffer, opts.onOutput, opts.signal);
      if (result.error && /ENOENT|sandbox-exec.*not found/i.test(result.error.message ?? "")) {
        detectedBackend = "none";
        result = await runUnsandboxed(opts.command, opts.cwd, opts.timeout, opts.maxBuffer, opts.onOutput, opts.signal);
        return { ...result, backend: "none" };
      }
      break;
    case "bubblewrap":
      result = await runBubblewrap(opts.command, opts.cwd, opts.timeout, opts.maxBuffer, opts.onOutput, opts.signal);
      if (result.error && /ENOENT|bwrap.*not found/i.test(result.error.message ?? "")) {
        detectedBackend = "none";
        result = await runUnsandboxed(opts.command, opts.cwd, opts.timeout, opts.maxBuffer, opts.onOutput, opts.signal);
        return { ...result, backend: "none" };
      }
      break;
    case "docker":
      result = await runDocker(opts.command, opts.cwd, opts.timeout, opts.maxBuffer, opts.onOutput, opts.signal);
      break;
    default:
      result = await runUnsandboxed(opts.command, opts.cwd, opts.timeout, opts.maxBuffer, opts.onOutput, opts.signal, opts.forceBackend === "none" && opts.inheritEnv);
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
