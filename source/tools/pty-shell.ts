import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import {
  analyzeCommandSafety,
  type CommandAnalysisResult,
} from "../utils/sandbox-guard.js";

export interface PtyCommandOptions {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  maxBuffer?: number;
  stdin?: string | AsyncIterable<string> | NodeJS.ReadableStream;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
  cols?: number;
  rows?: number;
  forceNonPty?: boolean;
  confirmed?: boolean;
  signal?: AbortSignal;
}

export interface PtyCommandResult {
  stdout: string;
  stderr: string;
  output: string;
  exitCode: number;
  signal?: string;
  isError: boolean;
  timedOut: boolean;
  usedPty: boolean;
}

export interface PtySession {
  readonly pid?: number;
  readonly isPty: boolean;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (chunk: string) => void): () => void;
  onError(callback: (err: Error) => void): () => void;
  onExit(callback: (code: number, signal?: string) => void): () => void;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_BUFFER = 100_000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export function stripAnsi(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g,
    "",
  );
}

export function filterEnv(customEnv?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val === undefined) continue;
    if (/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH/i.test(key)) continue;
    env[key] = val;
  }
  if (customEnv) {
    for (const [key, val] of Object.entries(customEnv)) {
      if (val !== undefined) env[key] = val;
    }
  }
  return env;
}

let cachedNodePty: any = undefined;

export async function loadNodePty(): Promise<any> {
  if (cachedNodePty !== undefined) return cachedNodePty;
  try {
    // Dynamic import to allow graceful non-PTY fallback if native bindings are not installed
    // @ts-ignore - optional native dependency
    const mod = await import("node-pty");
    cachedNodePty = mod.default ?? mod;
    return cachedNodePty;
  } catch {
    cachedNodePty = null;
    return null;
  }
}

export async function isPtySupported(): Promise<boolean> {
  const mod = await loadNodePty();
  return mod !== null;
}

export function setMockNodePty(mock: any): void {
  cachedNodePty = mock;
}

export function resetNodePtyCache(): void {
  cachedNodePty = undefined;
}

export function getShellCommand(command: string): { shell: string; args: string[] } {
  const isWindows = platform() === "win32";
  if (isWindows) {
    const comSpec = process.env.COMSPEC || "cmd.exe";
    return {
      shell: comSpec,
      args: ["/c", command],
    };
  }
  const userShell = process.env.SHELL || "/bin/sh";
  return {
    shell: userShell,
    args: ["-c", command],
  };
}

class NodePtySession implements PtySession {
  readonly isPty = true;
  private ptyProcess: any;
  private dataListeners = new Set<(chunk: string) => void>();
  private errorListeners = new Set<(err: Error) => void>();
  private exitListeners = new Set<(code: number, signal?: string) => void>();
  private disposed = false;

  constructor(ptyProcess: any) {
    this.ptyProcess = ptyProcess;

    this.ptyProcess.onData((data: string) => {
      if (this.disposed) return;
      for (const listener of this.dataListeners) {
        try {
          listener(data);
        } catch {}
      }
    });

    if (typeof this.ptyProcess.onExit === "function") {
      this.ptyProcess.onExit((event: { exitCode: number; signal?: number | string }) => {
        const sig = event.signal !== undefined ? String(event.signal) : undefined;
        for (const listener of this.exitListeners) {
          try {
            listener(event.exitCode, sig);
          } catch {}
        }
      });
    }
  }

  get pid(): number | undefined {
    return this.ptyProcess.pid;
  }

  write(data: string): void {
    if (this.disposed) return;
    try {
      this.ptyProcess.write(data);
    } catch {}
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    try {
      this.ptyProcess.resize(cols, rows);
    } catch {}
  }

  kill(signal?: string): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.ptyProcess.kill(signal);
    } catch {}
  }

  onData(callback: (chunk: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }

  onError(callback: (err: Error) => void): () => void {
    this.errorListeners.add(callback);
    return () => this.errorListeners.delete(callback);
  }

  onExit(callback: (code: number, signal?: string) => void): () => void {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }
}

class SpawnSession implements PtySession {
  readonly isPty = false;
  private cp: ChildProcess;
  private dataListeners = new Set<(chunk: string) => void>();
  private errorListeners = new Set<(err: Error) => void>();
  private exitListeners = new Set<(code: number, signal?: string) => void>();
  private disposed = false;

  constructor(cp: ChildProcess) {
    this.cp = cp;

    this.cp.stdout?.on("data", (chunk: Buffer | string) => {
      if (this.disposed) return;
      const str = chunk.toString();
      for (const listener of this.dataListeners) {
        try {
          listener(str);
        } catch {}
      }
    });

    this.cp.stderr?.on("data", (chunk: Buffer | string) => {
      if (this.disposed) return;
      const str = chunk.toString();
      for (const listener of this.dataListeners) {
        try {
          listener(str);
        } catch {}
      }
    });

    this.cp.on("error", (err: Error) => {
      if (this.disposed) return;
      for (const listener of this.errorListeners) {
        try {
          listener(err);
        } catch {}
      }
    });

    this.cp.on("close", (code: number | null, sig: NodeJS.Signals | null) => {
      const exitCode = code ?? (sig ? 1 : 0);
      const signalName = sig ?? undefined;
      for (const listener of this.exitListeners) {
        try {
          listener(exitCode, signalName);
        } catch {}
      }
    });
  }

  get pid(): number | undefined {
    return this.cp.pid;
  }

  write(data: string): void {
    if (this.disposed || !this.cp.stdin?.writable) return;
    try {
      this.cp.stdin.write(data);
    } catch {}
  }

  resize(_cols: number, _rows: number): void {
    // Non-PTY child processes do not have terminal dimensions
  }

  kill(signal: string = "SIGTERM"): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.cp.stdin?.destroy();
      if (platform() === "win32" && this.cp.pid) {
        try {
          execFileSync("taskkill", ["/pid", String(this.cp.pid), "/t", "/f"], { stdio: "ignore" });
        } catch {
          this.cp.kill("SIGKILL");
        }
      } else {
        this.cp.kill(signal as NodeJS.Signals);
      }
    } catch {}
  }

  onData(callback: (chunk: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }

  onError(callback: (err: Error) => void): () => void {
    this.errorListeners.add(callback);
    return () => this.errorListeners.delete(callback);
  }

  onExit(callback: (code: number, signal?: string) => void): () => void {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }
}

export async function createPtySession(options: {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  forceNonPty?: boolean;
}): Promise<PtySession> {
  const cwd = options.cwd ?? process.cwd();
  const env = filterEnv(options.env);
  const cols = options.cols ?? DEFAULT_COLS;
  const rows = options.rows ?? DEFAULT_ROWS;

  if (!options.forceNonPty) {
    const ptyMod = await loadNodePty();
    if (ptyMod && typeof ptyMod.spawn === "function") {
      try {
        const { shell, args } = getShellCommand(options.command);
        const ptyProc = ptyMod.spawn(shell, args, {
          name: "xterm-256color",
          cols,
          rows,
          cwd,
          env,
        });
        return new NodePtySession(ptyProc);
      } catch {
        // Fall back to spawned child process if native PTY fails to initialize
      }
    }
  }

  const cp = spawn(options.command, {
    cwd,
    env,
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  return new SpawnSession(cp);
}

export async function runPtyCommand(options: PtyCommandOptions): Promise<PtyCommandResult> {
  const command = options.command.trim();
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;

  // 1. Sandbox guard checks
  const analysis: CommandAnalysisResult = analyzeCommandSafety(command);

  if (analysis.level === "blocked") {
    const output = `Blocked: "${command}" matches a critically dangerous command pattern (${analysis.reason ?? "catastrophic command"}). This command is blocked unconditionally.`;
    return {
      stdout: "",
      stderr: output,
      output,
      exitCode: 1,
      isError: true,
      timedOut: false,
      usedPty: false,
    };
  }

  if (analysis.level === "destructive" && !options.confirmed) {
    const output = `Blocked: "${command}" matches a destructive command pattern (${analysis.reason ?? "destructive command"}). This command requires explicit user confirmation and cannot be auto-approved.`;
    return {
      stdout: "",
      stderr: output,
      output,
      exitCode: 1,
      isError: true,
      timedOut: false,
      usedPty: false,
    };
  }

  let session: PtySession;
  try {
    session = await createPtySession({
      command,
      cwd: options.cwd,
      env: options.env,
      cols: options.cols,
      rows: options.rows,
      forceNonPty: options.forceNonPty,
    });
  } catch (err: any) {
    const errMsg = `Failed to spawn process: ${err?.message ?? String(err)}`;
    return {
      stdout: "",
      stderr: errMsg,
      output: errMsg,
      exitCode: 1,
      isError: true,
      timedOut: false,
      usedPty: false,
    };
  }

  let stdoutAccum = "";
  let stderrAccum = "";
  let timedOut = false;
  let exitCode = 0;
  let exitSignal: string | undefined = undefined;

  let timeoutTimer: NodeJS.Timeout | null = null;
  let abortCleanup: (() => void) | null = null;

  const promise = new Promise<PtyCommandResult>((resolve) => {
    // Timeout handler
    if (timeout > 0 && timeout < Infinity) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        session.kill("SIGINT");
        setTimeout(() => {
          session.kill("SIGTERM");
        }, 300);
      }, timeout);
    }

    // AbortSignal handler
    if (options.signal) {
      const onAbort = () => {
        session.kill("SIGINT");
      };
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
        abortCleanup = () => options.signal?.removeEventListener("abort", onAbort);
      }
    }

    session.onData((chunk: string) => {
      stdoutAccum += chunk;
      if (options.onStdoutChunk) {
        try {
          options.onStdoutChunk(chunk);
        } catch {}
      }
    });

    session.onError((err: Error) => {
      stderrAccum += (stderrAccum ? "\n" : "") + err.message;
      if (options.onStderrChunk) {
        try {
          options.onStderrChunk(err.message);
        } catch {}
      }
    });

    session.onExit((code: number, signal?: string) => {
      exitCode = code;
      exitSignal = signal;

      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (abortCleanup) abortCleanup();

      let combinedOutput = stripAnsi(stdoutAccum);
      if (stderrAccum) {
        combinedOutput += (combinedOutput ? "\n" : "") + stripAnsi(stderrAccum);
      }

      if (timedOut) {
        const timeoutMsg = `\nCommand timed out after ${timeout}ms.`;
        combinedOutput += timeoutMsg;
        exitCode = 124; // standard POSIX timeout code
      }

      if (!combinedOutput.trim()) {
        combinedOutput = exitCode === 0
          ? "Command completed with no output."
          : `Command failed with exit code ${exitCode}.`;
      }

      if (combinedOutput.length > maxBuffer) {
        combinedOutput = combinedOutput.slice(0, maxBuffer) + "\n...(truncated)";
      }

      resolve({
        stdout: stdoutAccum,
        stderr: stderrAccum,
        output: combinedOutput,
        exitCode,
        signal: exitSignal,
        isError: exitCode !== 0 || timedOut,
        timedOut,
        usedPty: session.isPty,
      });
    });
  });

  // Handle stdin input forwarding
  if (options.stdin !== undefined) {
    if (typeof options.stdin === "string") {
      session.write(options.stdin);
    } else if (Symbol.asyncIterator in options.stdin) {
      (async () => {
        try {
          for await (const chunk of options.stdin as AsyncIterable<string>) {
            session.write(chunk);
          }
        } catch {}
      })();
    } else if (typeof (options.stdin as any).on === "function") {
      const stream = options.stdin as NodeJS.ReadableStream;
      stream.on("data", (chunk: Buffer | string) => {
        session.write(chunk.toString());
      });
    }
  }

  return promise;
}
