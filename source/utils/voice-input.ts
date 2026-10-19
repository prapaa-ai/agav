import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { cleanVoiceTranscript } from "./voice-transcript.js";
import { getVoiceModelPath } from "./voice-model.js";
import { getVoiceRuntimePath } from "./voice-runtime.js";

export type VoicePhase = "preparing" | "recording" | "transcribing";
export interface VoiceSession {
  stop(): void;
  cancel(): void;
  result: Promise<string>;
}

function cancelled(): Error {
  return Object.assign(new Error("Voice input cancelled."), { name: "AbortError" });
}
function cleanText(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[P^_X][\s\S]*?\x1b\\/g, "")
    .replace(/[\x1b\x9b]\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x9b[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim();
}
const asError = (error: unknown) => error instanceof Error ? error : new Error(cleanText(String(error)));

interface RunningCommand {
  result: Promise<void>;
  stop(): void;
  deadline(milliseconds: number, label: string): void;
}

/** Own both the probe and capture child, including failed spawn and inherited-pipe races. */
function command(
  bin: string, args: string[], signal: AbortSignal,
  onData: (chunk: Buffer) => void, onClose: () => void, maxBuffer?: number,
): RunningCommand {
  let child: ChildProcessWithoutNullStreams | undefined;
  let stop = () => {};
  let deadline = (_milliseconds: number, _label: string) => {};
  const result = new Promise<void>((accept, reject) => {
    let finished = false;
    let exited = false;
    let stopping = false;
    let failure: Error | undefined;
    let stderr = Buffer.alloc(0);
    let stderrBytes = 0;
    let phaseTimer: ReturnType<typeof setTimeout> | undefined;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      const timer = setTimeout(() => { timers.delete(timer); if (!finished) fn(); }, ms);
      timers.add(timer);
      return timer;
    };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      for (const timer of timers) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy();
      if (error) reject(error); else accept();
    };
    const kill = (sig: NodeJS.Signals) => {
      if (finished || exited || !child?.pid || child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill(sig); } catch { /* Exit may race the signal. */ }
    };
    const write = (text: string) => {
      if (finished || exited || !child) return;
      try { child.stdin.write(text, (error) => { if (error && !failure) fail(new Error(`Voice helper pipe failed: ${cleanText(error.message)}`)); }); }
      catch (error) { if (!failure) fail(asError(error)); }
    };
    const fail = (error: Error) => {
      if (finished || failure) return;
      failure = error;
      if (phaseTimer) { clearTimeout(phaseTimer); timers.delete(phaseTimer); }
      // EOF means cancellation to the native helper; keep stdin open until close.
      write("cancel\n");
      if (finished) return;
      later(() => kill("SIGTERM"), 500);
      later(() => kill("SIGKILL"), 1000);
      later(() => finish(exited ? failure : Object.assign(new Error(
        `Voice helper termination was not acknowledged. Check local processes and microphone access before recording again. ${failure?.message}`,
      ), { name: "VoiceCleanupError" })), 1500);
    };
    const abort = () => fail(asError(signal.reason ?? cancelled()));
    if (signal.aborted) { finish(asError(signal.reason ?? cancelled())); return; }
    try {
      child = spawn(bin, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) { finish(new Error(`Cannot start voice helper: ${cleanText(String(error))}. Check AGAV_VOICE_HELPER_BIN.`)); return; }
    child.on("error", (error) => {
      const message = new Error(`Cannot run voice helper: ${cleanText(error.message)}. Check AGAV_VOICE_HELPER_BIN; no microphone may have been opened.`);
      if (!child?.pid) finish(failure ?? message); else fail(message);
    });
    child.on("exit", (code, sig) => {
      if (finished) return;
      exited = true;
      later(() => finish(failure ?? new Error(`Voice helper exited without closing its output pipes (${code ?? sig}).`)), 500);
    });
    child.on("close", (code, sig) => {
      exited = true;
      if (finished) return;
      if (failure) { finish(failure); return; }
      if (code !== 0) { finish(new Error(`Voice helper failed (${code ?? sig}): ${cleanText(stderr.toString("utf8")) || "check microphone permissions, device and English .en model"}`)); return; }
      try { onClose(); finish(); } catch (error) { finish(asError(error)); }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (finished || failure) return;
      stderrBytes += chunk.length;
      if (maxBuffer !== undefined && stderrBytes > maxBuffer) {
        fail(new Error(`Voice helper protocol probe stderr exceeds ${maxBuffer} bytes.`));
        return;
      }
      stderr = Buffer.concat([stderr, chunk.subarray(-8192)]).subarray(-8192);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (finished || failure) return;
      try { onData(chunk); } catch (error) { fail(asError(error)); }
    });
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.on("error", (error) => fail(new Error(`Voice helper pipe failed: ${cleanText(error.message)}`)));
    }
    stop = () => {
      if (finished || exited || failure || stopping) return;
      stopping = true;
      write("stop\n");
      deadline(5000, "microphone stop");
    };
    deadline = (milliseconds, label) => {
      if (finished || failure) return;
      if (phaseTimer) { clearTimeout(phaseTimer); timers.delete(phaseTimer); }
      phaseTimer = later(() => fail(new Error(`Voice helper ${label} timed out.`)), milliseconds);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  void result.catch(() => {});
  return { result, stop: () => stop(), deadline: (ms, label) => deadline(ms, label) };
}


interface Configuration { bin: string; model: string; device?: string; key: string; env: NodeJS.ProcessEnv }
interface Request {
  onPhase: (phase: VoicePhase) => void;
  onLevel?: (level: number) => void;
  onPartial?: (text: string) => void;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  error?: Error;
  transcript?: string;
  phase?: VoicePhase;
  stopped: boolean;
  sent: boolean;
  cancel?: () => void;
  started: number;
  terminal?: boolean;
  timings: Record<string, number>;
}
let pool: VoiceRuntime | undefined;
let owner: Request | undefined;
let disposal: Promise<void> | undefined;
let retiring: Promise<void> = Promise.resolve();
const invalid = () => new Error("Invalid voice helper protocol event or order.");

/** One helper owns the warm model and, only between start and ready, the microphone. */
class VoiceRuntime {
  private child: ChildProcessWithoutNullStreams;
  private pending = Buffer.alloc(0);
  private bytes = 0;
  private stderr = Buffer.alloc(0);
  private initial: "preparing" | "ready" | undefined;
  private request?: Request;
  private timer?: ReturnType<typeof setTimeout>;
  private idle?: ReturnType<typeof setTimeout>;
  private cleanup: ReturnType<typeof setTimeout>[] = [];
  private ended = false;
  private exited = false;
  private closing = false;
  private failure?: Error;
  private acceptClose!: () => void;
  readonly closed = new Promise<void>(resolve => { this.acceptClose = resolve; });

  constructor(readonly config: Configuration, request: Request) {
    this.request = request;
    this.child = spawn(config.bin, ["--model", config.model, "--persistent", ...(config.device ? ["--device", config.device] : [])],
      { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: config.env });
    this.child.on("error", error => {
      const failure = new Error(`Cannot run voice helper: ${cleanText(error.message)}. Check AGAV_VOICE_HELPER_BIN.`);
      if (!this.child.pid) this.finish(failure); else this.fail(failure);
    });
    this.child.on("exit", () => {
      if (this.ended) return;
      this.exited = true;
      this.cleanup.push(setTimeout(() => this.finish(this.failure ?? this.request?.error ?? new Error("Voice helper exited without closing its output pipes.")), 500));
    });
    this.child.on("close", (code, signal) => {
      this.exited = true;
      this.finish(this.failure ?? this.request?.error ?? new Error(`Voice helper exited before ready (${code ?? signal}): ${cleanText(this.stderr.toString()) || "no complete transcript"}`));
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.ended || this.closing) return;
      try { this.consume(chunk); } catch (error) { this.fail(asError(error)); }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = Buffer.concat([this.stderr, chunk.subarray(-8192)]).subarray(-8192);
    });
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      stream.on("error", error => this.fail(new Error(`Voice helper pipe failed: ${cleanText(error.message)}`)));
    }
    this.deadline(60000, "loading");
  }
  private refs(active: boolean) {
    if (active) this.child.ref(); else this.child.unref();
    // Pipe is a net.Socket in Node; keep EOF ownership but don't keep the parent alive idle.
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      const pipe = stream as unknown as { ref?: () => void; unref?: () => void };
      if (active) pipe.ref?.(); else pipe.unref?.();
    }
  }
  private write(command: string) {
    if (this.ended || this.exited) return;
    try {
      this.child.stdin.write(`${command}\n`, error => { if (error && !this.closing) this.fail(new Error(`Voice helper pipe failed: ${cleanText(error.message)}`)); });
    } catch (error) { if (!this.closing) this.fail(asError(error)); }
  }
  private deadline(ms: number, name: string) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const error = new Error(`Voice helper ${name} timed out.`);
      if (this.request?.error) this.fail(error); else this.cancel(error);
    }, ms);
  }
  private clearTimers() {
    if (this.timer) clearTimeout(this.timer);
    if (this.idle) clearTimeout(this.idle);
    for (const timer of this.cleanup) clearTimeout(timer);
    this.cleanup = [];
  }
  private kill(signal: NodeJS.Signals) {
    if (this.ended || this.exited || !this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) return;
    try { this.child.kill(signal); } catch { /* Process exit can race a signal. */ }
  }
  private escalate() {
    if (this.ended) return;
    this.cleanup.push(setTimeout(() => this.kill("SIGTERM"), 500));
    this.cleanup.push(setTimeout(() => this.kill("SIGKILL"), 1000));
    this.cleanup.push(setTimeout(() => this.finish(this.exited ? this.failure ?? this.request?.error : Object.assign(new Error(
      `Voice helper termination was not acknowledged. Check local processes and microphone access before recording again. ${this.failure?.message ?? this.request?.error?.message ?? ""}`,
    ), { name: "VoiceCleanupError" })), 1500));
  }
  private finish(error?: Error) {
    if (this.ended) return;
    this.ended = true;
    this.clearTimers();
    if (pool === this) pool = undefined;
    this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
    if (this.request) { this.request.reject(error ?? new Error("Voice helper closed before ready.")); this.request = undefined; }
    this.acceptClose();
  }
  private fail(error: Error) {
    if (this.ended || this.closing) return;
    this.failure = error;
    this.closing = true;
    retiring = this.closed;
    if (pool === this) pool = undefined;
    this.clearTimers();
    this.write("cancel");
    this.escalate();
  }
  shutdown(): Promise<void> {
    if (this.ended || this.closing) return this.closed;
    retiring = this.closed;
    if (this.request) { this.cancel(cancelled()); return this.closed.then(() => {}); }
    this.closing = true;
    if (pool === this) pool = undefined;
    this.clearTimers(); this.refs(true);
    this.write("shutdown"); this.child.stdin.end(); this.escalate();
    return this.closed;
  }
  start(request: Request) {
    if (this.request || this.ended || this.closing || this.initial !== "ready") throw new Error("Voice input busy.");
    if (this.idle) clearTimeout(this.idle);
    this.request = request; this.bytes = 0; this.refs(true); this.begin();
  }
  private begin() {
    const request = this.request!;
    request.sent = true;
    this.deadline(60000, "preparing"); this.write("start");
  }
  stop() {
    const request = this.request;
    if (!request || request.stopped || request.error || request.terminal || request.phase === "transcribing") return;
    request.stopped = true;
    request.timings.stopMs = performance.now() - request.started;
    if (!request.sent) { this.cancel(new Error("No audio recorded: stopped before microphone capture was ready.")); return; }
    this.write("stop"); this.deadline(5000, "microphone stop");
  }
  cancel(error: Error) {
    const request = this.request;
    if (!request || request.error || this.ended || this.closing) return;
    request.error = error;
    request.timings.cancelMs = performance.now() - request.started;
    if (this.timer) clearTimeout(this.timer);
    // Native accepts cancel only after start; a terminal event already owns a ready acknowledgment.
    if (request.sent && !request.terminal) this.write("cancel");
    this.escalate();
  }
  private ready() {
    const request = this.request;
    if (this.initial !== "ready") {
      if (this.initial !== "preparing") throw invalid();
      this.initial = "ready";
      if (request) request.timings.loadedMs = performance.now() - request.started;
      if (!request?.error) { this.begin(); return; }
    } else if (!request || !request.sent || (!request.error && request.transcript === undefined)) throw invalid();
    this.clearTimers(); this.request = undefined;
    if (request) {
      if (this.config.env.AGAV_VOICE_PROFILE === "1") {
        try { process.stderr.write(`[agav-voice] ${JSON.stringify({ ...request.timings, readyMs: performance.now() - request.started })}\n`); }
        catch { /* Diagnostics must not strand an acknowledged request. */ }
      }
      if (request.error) request.reject(request.error); else request.resolve(request.transcript!);
    }
    this.refs(false);
    this.idle = setTimeout(() => { retiring = this.shutdown(); }, 30000);
    this.idle.unref();
  }
  private event(data: Buffer) {
    let value: Record<string, unknown>;
    try { value = JSON.parse(data.toString("utf8")) as Record<string, unknown>; } catch { throw invalid(); }
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2) throw invalid();
    if (value.type === "ready") { if (value.protocol !== 1) throw invalid(); this.ready(); return; }
    const request = this.request;
    if (this.initial !== "ready") {
      if (value.type === "error" && this.initial === "preparing" && typeof value.message === "string" && Buffer.byteLength(value.message) <= 65536) {
        this.fail(request?.error ?? new Error(`Voice helper: ${cleanText(value.message) || "unknown error"}`));
        return;
      }
      if (value.type !== "phase" || value.phase !== "preparing" || this.initial) throw invalid();
      this.initial = "preparing"; return;
    }
    if (!request || !request.sent || request.terminal) throw invalid();
    // During cancellation native may finish a write already in flight. Validate it,
    // but don't invoke callbacks or expose a late transcript.
    switch (value.type) {
      case "phase": {
        const next = value.phase;
        if (!(request.phase === undefined && next === "preparing" || request.phase === "preparing" && next === "recording" || request.phase === "recording" && next === "transcribing")) throw invalid();
        request.phase = next as VoicePhase;
        request.timings[`${next}Ms`] = performance.now() - request.started;
        if (!request.error) {
          if (!request.stopped || next === "transcribing") this.deadline(next === "preparing" ? 60000 : next === "recording" ? 125000 : 120000, next as string);
          if (next !== "preparing") request.onPhase(request.phase);
        }
        return;
      }
      case "level":
        if ((request.phase !== "preparing" && request.phase !== "recording") || typeof value.level !== "number" || !Number.isFinite(value.level) || value.level < 0 || value.level > 1) throw invalid();
        if (!request.error) request.onLevel?.(value.level); return;
      case "partial":
        if ((request.phase !== "recording" && request.phase !== "transcribing") || typeof value.text !== "string" || Buffer.byteLength(value.text) > 48000) throw invalid();
        request.timings.firstPartialMs ??= performance.now() - request.started;
        if (!request.error) request.onPartial?.(cleanText(value.text)); return;
      case "transcript":
        if (request.phase !== "transcribing" || typeof value.text !== "string" || Buffer.byteLength(value.text) > 65536) throw invalid();
        request.terminal = true;
        request.timings.transcriptMs = performance.now() - request.started;
        request.transcript = cleanVoiceTranscript(cleanText(value.text));
        if (!request.transcript && !request.error) request.error = new Error("Voice helper returned no speech text.");
        if (request.timings.cancelMs === undefined) this.deadline(5000, "ready acknowledgment");
        return;
      case "error":
        if (typeof value.message !== "string" || Buffer.byteLength(value.message) > 65536) throw invalid();
        request.terminal = true;
        if (!request.error) {
          request.error = new Error(`Voice helper: ${cleanText(value.message) || "unknown error"}`);
          this.deadline(5000, "error cleanup");
        }
        return;
      default: throw invalid();
    }
  }
  private consume(chunk: Buffer) {
    this.bytes += chunk.length;
    if (this.bytes > 4 * 1024 ** 2) throw new Error("Voice helper output exceeds 4 MiB.");
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 10) continue;
      const part = chunk.subarray(start, i);
      if (this.pending.length + part.length > 65536) throw new Error("Voice helper line exceeds 64 KiB.");
      const line = Buffer.concat([this.pending, part]); this.pending = Buffer.alloc(0); start = i + 1;
      this.event(line);
      if (this.closing || this.ended) return;
    }
    const rest = chunk.subarray(start);
    if (this.pending.length + rest.length > 65536) throw new Error("Voice helper line exceeds 64 KiB.");
    this.pending = Buffer.concat([this.pending, rest]);
  }
}

/** Explicit application teardown; idle helpers otherwise shut down after 30 seconds. */
export function disposeVoiceRuntime(): Promise<void> {
  if (disposal) return disposal;
  const operation = (async () => {
    owner?.cancel?.(); // Ownership remains held until cleanup has been acknowledged.
    const runtime = pool;
    const activeResult = ownerResult;
    await activeResult;
    if (runtime) retiring = runtime.shutdown();
    await retiring;
  })();
  disposal = operation.finally(() => { disposal = undefined; });
  return disposal;
}
export const stopVoiceRuntime = disposeVoiceRuntime;
let ownerResult: Promise<unknown> = Promise.resolve();

/** Offline dictation only: no downloads, shell commands or automatic text execution. */
export function startVoiceInput(onPhase: (phase: VoicePhase) => void, onLevel?: (level: number) => void, onPartial?: (text: string) => void): VoiceSession {
  const controller = new AbortController();
  let runtime: VoiceRuntime | undefined;
  let stopped = false;
  let done = false;
  let request!: Request;
  const result = new Promise<string>((resolve, reject) => {
    request = { onPhase, onLevel, onPartial, resolve, reject, stopped: false, sent: false, started: performance.now(), timings: {} };
  });
  request.cancel = () => { controller.abort(cancelled()); runtime?.cancel(cancelled()); };
  const busy = Boolean(owner || disposal);
  if (!busy) owner = request;
  const check = () => controller.signal.throwIfAborted();
  void Promise.resolve().then(async () => {
    if (busy) throw new Error("Voice input busy: another session is active.");
    check(); onPhase("preparing"); check();
    const model = resolve(getVoiceModelPath());
    let modelInfo;
    try {
      modelInfo = await stat(model);
      if (!modelInfo.isFile() || modelInfo.size < 1024 ** 2 || modelInfo.size > 4 * 1024 ** 3) throw new Error("invalid model");
      await access(model, constants.R_OK);
    } catch { check(); throw new Error("AGAV_VOICE_MODEL must be a readable regular model file between 1 MiB and 4 GiB."); }
    check();
    const bin = getVoiceRuntimePath();
    let helperInfo;
    try {
      if (!bin || bin.includes("\0")) throw new Error("invalid helper");
      helperInfo = await stat(bin);
      if (!helperInfo.isFile()) throw new Error("invalid helper");
      await access(bin, process.platform === "win32" ? constants.R_OK : constants.R_OK | constants.X_OK);
    } catch { check(); throw new Error("Cannot find executable voice helper. Check AGAV_VOICE_HELPER_BIN; no microphone was opened."); }
    check();
    const device = process.env.AGAV_VOICE_DEVICE;
    if (device?.includes("\0")) throw new Error("AGAV_VOICE_DEVICE must not contain NUL characters.");
    const env = { ...process.env };
    const key = JSON.stringify([resolve(bin!), model, device ?? "",
      helperInfo.dev, helperInfo.ino, helperInfo.size, helperInfo.mtimeMs, helperInfo.ctimeMs,
      modelInfo.dev, modelInfo.ino, modelInfo.size, modelInfo.mtimeMs, modelInfo.ctimeMs,
      env.AGAV_VOICE_THREADS ?? "", env.AGAV_VOICE_BACKEND ?? ""]);
    await retiring; check();
    if (pool && pool.config.key !== key) { retiring = pool.shutdown(); await retiring; check(); }
    if (pool) { runtime = pool; runtime.start(request); return; }
    let version = Buffer.alloc(0);
    const probe = command(bin!, ["--protocol-version"], controller.signal, chunk => {
      if (chunk.length > 1024 - version.length) throw new Error("Voice helper protocol probe exceeds 1024 bytes.");
      version = Buffer.concat([version, chunk]);
    }, () => {
      if (version.toString("utf8").trim() !== "1") throw new Error("Unsupported voice helper protocol version (expected 1); no microphone was opened.");
    }, 1024);
    probe.deadline(5000, "protocol probe"); await probe.result; check();
    try { runtime = new VoiceRuntime({ bin: bin!, model, device, key, env }, request); pool = runtime; }
    catch (error) { throw new Error(`Cannot start voice helper: ${cleanText(String(error))}. Check AGAV_VOICE_HELPER_BIN.`); }
  }).catch(error => request.reject(asError(error)));
  const settled = result.finally(() => { done = true; if (owner === request) owner = undefined; });
  void settled.catch(() => {});
  if (!busy) ownerResult = settled.catch(() => {});
  return {
    result: settled,
    stop() {
      if (done || stopped || controller.signal.aborted) return;
      stopped = true;
      if (runtime) runtime.stop(); else controller.abort(new Error("No audio recorded: stopped before microphone capture was ready."));
    },
    cancel() {
      if (done || controller.signal.aborted) return;
      controller.abort(cancelled()); if (runtime) runtime.cancel(cancelled());
    },
  };
}
