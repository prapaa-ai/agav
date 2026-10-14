/**
 * Foreground background-jobs daemon. The lock file doubles as the pidfile/status file;
 * a held lock is recovered only when the owner is verified gone (same host, pid dead
 * or reused). Age is never used, and a corrupt holder stays locked.
 * The tick function is injected, so host/ never imports the coordinator.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { hostname as osHostname, userInfo } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import { readLockOwnerStartTime } from "../platform/index.js";
import { lockPath } from "../storage/paths.js";
import {
  isLockOwnerGone,
  readLockHolder,
  tryRecoverStaleLock,
  type LockHolder,
  type LockOwnerProbes,
} from "../storage/single-writer-lock.js";

export const DAEMON_LOCK_NAME = "daemon";
export const DAEMON_TICK_INTERVAL_MS = 15_000;
export const DAEMON_STOP_TIMEOUT_MS = 10_000;
/** Legacy fixed pipe name; only kept as the `sendPipeStopRequest` default. See `daemonPipePath`. */
export const DAEMON_PIPE_PATH = "\\\\.\\pipe\\agav-job-daemon";
const DAEMON_PIPE_PREFIX = "\\\\.\\pipe\\agav-job-daemon-";

export interface DaemonLockRecord extends LockHolder {
  startedAt?: string;
  version?: string;
  pipePath?: string;
  /** Windows only: secret the stop message must carry; the lock lives in the user's private root. */
  stopToken?: string;
}

export function daemonLockPath(root: string): string {
  return lockPath(root, DAEMON_LOCK_NAME);
}

function currentUsername(): string {
  try {
    const name = userInfo().username;
    if (name) return name;
  } catch {
    // userInfo() throws when the user has no passwd entry / profile.
  }
  return process.env["USERNAME"] ?? process.env["USER"] ?? "unknown";
}

function sanitizeUsername(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9._-]/g, "_").slice(0, 64);
  return cleaned || "unknown";
}

/** Per-user, per-root stop pipe name; deterministic so `stop` can recompute it for locks without `pipePath`. */
export function daemonPipePath(root: string, username: string = currentUsername()): string {
  const digest = createHash("sha256").update(resolvePath(root)).digest("hex").slice(0, 12);
  return `${DAEMON_PIPE_PREFIX}${sanitizeUsername(username)}-${digest}`;
}

function newStopToken(): string {
  return randomBytes(32).toString("hex");
}

function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface DaemonTimers {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export type SignalRegistrar = (signal: NodeJS.Signals, handler: () => void) => () => void;

/** Subset of a `net.Socket` used by the pipe channel. */
export interface PipeSocket {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "connect", listener: () => void): unknown;
  write(data: string): unknown;
  end(data?: string): unknown;
  destroy(): unknown;
}

/** Subset of a `net.Server` used by the pipe channel. */
export interface PipeServer {
  listen(path: string, cb?: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  close(cb?: (err?: Error) => void): unknown;
}

/** Subset of `node:net` used by the Windows stop channel. */
export interface PipeNet {
  createServer(onConnection: (socket: PipeSocket) => void): PipeServer;
  connect(path: string): PipeSocket;
}

const defaultTimers: DaemonTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms), // ref'd on purpose: keeps the process alive
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

const defaultSignals: SignalRegistrar = (signal, handler) => {
  process.on(signal, handler);
  return () => {
    process.removeListener(signal, handler);
  };
};

async function defaultNet(): Promise<PipeNet> {
  return (await import("node:net")) as unknown as PipeNet;
}

export interface DaemonLockDeps {
  probes?: Partial<LockOwnerProbes>;
  recoverStaleLock?: (root: string, path: string) => Promise<boolean>;
  hostname?: () => string;
  pid?: number;
  now?: () => Date;
  readStartTime?: (pid: number) => Promise<string | undefined>;
  stopChannel?: { pipePath: string; stopToken: string };
}

export type DaemonLockResult =
  | { acquired: true; record: DaemonLockRecord; release: () => Promise<void> }
  | { acquired: false; holder: LockHolder | undefined };

async function createLockFile(path: string, record: DaemonLockRecord): Promise<boolean> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(record));
  } finally {
    await handle.close();
  }
  return true;
}

export async function acquireDaemonLock(
  root: string,
  version: string,
  deps: DaemonLockDeps = {},
): Promise<DaemonLockResult> {
  const path = daemonLockPath(root);
  const pid = deps.pid ?? process.pid;
  const startedAt = (deps.now ?? (() => new Date()))().toISOString();
  const processStartTime = await (deps.readStartTime ?? readLockOwnerStartTime)(pid).catch(() => undefined);
  const record: DaemonLockRecord = {
    pid,
    hostname: (deps.hostname ?? osHostname)(),
    startedAt,
    acquiredAt: startedAt,
    version,
    ...(processStartTime !== undefined ? { processStartTime } : {}),
    ...(deps.stopChannel ? { pipePath: deps.stopChannel.pipePath, stopToken: deps.stopChannel.stopToken } : {}),
  };
  const recover = deps.recoverStaleLock ?? ((r: string, p: string) => tryRecoverStaleLock(r, p, undefined, deps.probes));

  let created = await createLockFile(path, record);
  if (!created && (await recover(root, path))) {
    created = await createLockFile(path, record); // exactly one retry
  }
  if (!created) return { acquired: false, holder: await readLockHolder(path) };

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    // Only remove the file if it is still ours.
    const current = await readLockHolder(path);
    if (current && current.pid === record.pid && current.acquiredAt === record.acquiredAt) {
      await fs.unlink(path).catch(() => {});
    }
  };
  return { acquired: true, record, release };
}

export type DaemonStatus =
  | { state: "running"; record: DaemonLockRecord }
  | { state: "not-running" }
  | { state: "stale"; record: DaemonLockRecord }
  | { state: "unknown"; path: string };

async function readDaemonRecord(path: string): Promise<DaemonLockRecord | undefined> {
  const holder = await readLockHolder(path);
  if (!holder) return undefined;
  const record: DaemonLockRecord = { ...holder };
  try {
    const raw = JSON.parse(await fs.readFile(path, "utf8")) as Record<string, unknown>;
    if (typeof raw["startedAt"] === "string") record.startedAt = raw["startedAt"];
    if (typeof raw["version"] === "string") record.version = raw["version"];
    if (typeof raw["pipePath"] === "string") record.pipePath = raw["pipePath"];
    if (typeof raw["stopToken"] === "string") record.stopToken = raw["stopToken"];
  } catch {
    // Holder already validated; extras are diagnostics only.
  }
  return record;
}

export async function getDaemonStatus(
  root: string,
  deps: { probes?: Partial<LockOwnerProbes> } = {},
): Promise<DaemonStatus> {
  const path = daemonLockPath(root);
  try {
    await fs.stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "not-running" };
    return { state: "unknown", path };
  }
  const record = await readDaemonRecord(path);
  if (!record) {
    // Lock may have been released between stat and read.
    try {
      await fs.stat(path);
    } catch {
      return { state: "not-running" };
    }
    return { state: "unknown", path };
  }
  if (await isLockOwnerGone(record, deps.probes)) return { state: "stale", record };
  return { state: "running", record };
}

export interface DaemonOptions extends DaemonLockDeps {
  root: string;
  version: string;
  tick: () => Promise<void>;
  intervalMs?: number;
  timers?: DaemonTimers;
  onSignal?: SignalRegistrar;
  platform?: NodeJS.Platform;
  net?: PipeNet;
  pipePath?: string;
  log?: (message: string) => void;
}

export interface DaemonHandle {
  record: DaemonLockRecord;
  stopped: Promise<void>;
  stop: () => Promise<void>;
}

export type StartDaemonResult =
  | { started: true; handle: DaemonHandle }
  | { started: false; holder: LockHolder | undefined };

export async function startDaemon(opts: DaemonOptions): Promise<StartDaemonResult> {
  const platform = opts.platform ?? process.platform;
  const stopChannel =
    platform === "win32"
      ? opts.stopChannel ?? { pipePath: opts.pipePath ?? daemonPipePath(opts.root), stopToken: newStopToken() }
      : undefined;
  const lock = await acquireDaemonLock(opts.root, opts.version, { ...opts, ...(stopChannel ? { stopChannel } : {}) });
  if (!lock.acquired) return { started: false, holder: lock.holder };

  const timers = opts.timers ?? defaultTimers;
  const onSignal = opts.onSignal ?? defaultSignals;
  const log = opts.log ?? (() => {});
  const intervalMs = opts.intervalMs ?? DAEMON_TICK_INTERVAL_MS;

  let inFlight: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let intervalHandle: unknown;
  let closePipe: (() => Promise<void>) | null = null;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const runTick = (): void => {
    if (stopping || inFlight) return; // never overlap; skip this beat
    inFlight = opts
      .tick()
      .catch((err: unknown) => {
        log(`tick failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        inFlight = null;
      });
  };

  const unregister: Array<() => void> = [];

  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (intervalHandle !== undefined) timers.clearInterval(intervalHandle);
      for (const off of unregister) off();
      try {
        if (inFlight) await inFlight;
      } finally {
        if (closePipe) await closePipe().catch(() => {});
        await lock.release();
        resolveStopped();
      }
    })();
    return stopping;
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    unregister.push(
      onSignal(signal, () => {
        log(`received ${signal}, shutting down`);
        void stop();
      }),
    );
  }

  if (stopChannel) {
    try {
      closePipe = await startPipeStopServer({
        net: opts.net ?? (await defaultNet()),
        path: stopChannel.pipePath,
        pid: lock.record.pid,
        token: stopChannel.stopToken,
        onStop: () => {
          log("stop requested over pipe, shutting down");
          void stop();
        },
      });
    } catch (err) {
      for (const off of unregister) off();
      await lock.release();
      throw err;
    }
  }

  runTick();
  intervalHandle = timers.setInterval(runTick, intervalMs);

  return { started: true, handle: { record: lock.record, stopped, stop } };
}

const PIPE_MAX_REQUEST_BYTES = 1024;
/** How long shutdown waits for already-answered clients to hang up before destroying them. */
const PIPE_CLOSE_GRACE_MS = 1000;

/**
 * Only a `stop <token>` line carrying the token from `daemon.lock` triggers `onStop`.
 * The returned close function destroys still-connected clients so shutdown never waits on an idle one.
 */
export async function startPipeStopServer(args: {
  net: PipeNet;
  path: string;
  pid: number;
  token: string;
  onStop: () => void;
}): Promise<() => Promise<void>> {
  // socket -> already answered (its reply is flushing; destroyed after a grace period).
  const clients = new Map<PipeSocket, boolean>();
  const server = args.net.createServer((socket) => {
    let buffer = "";
    let answered = false;
    clients.set(socket, false);
    socket.on("error", () => {});
    socket.on("close", () => {
      clients.delete(socket);
    });
    socket.on("data", (chunk) => {
      if (answered) return;
      buffer += chunk.toString();
      const nl = buffer.indexOf("\n");
      if (nl < 0) {
        if (buffer.length > PIPE_MAX_REQUEST_BYTES) {
          answered = true;
          clients.set(socket, true);
          socket.end(`${JSON.stringify({ ok: false, error: "request too large" })}\n`);
        }
        return;
      }
      answered = true;
      clients.set(socket, true);
      const line = buffer.slice(0, nl).trim();
      const match = /^stop (\S+)$/.exec(line);
      if (match && tokensEqual(match[1]!, args.token)) {
        socket.end(`${JSON.stringify({ ok: true, pid: args.pid })}\n`);
        args.onStop();
      } else if (line === "stop" || match) {
        socket.end(`${JSON.stringify({ ok: false, error: "invalid stop token" })}\n`);
      } else {
        socket.end(`${JSON.stringify({ ok: false, error: "unknown command" })}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(args.path, () => resolve());
  });
  return () =>
    new Promise<void>((resolve) => {
      const destroyClients = (onlyIdle: boolean): void => {
        for (const [socket, answered] of clients) {
          if (onlyIdle && answered) continue;
          clients.delete(socket);
          try {
            socket.destroy();
          } catch {
            // already gone
          }
        }
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      server.close(done);
      destroyClients(true);
      timer = setTimeout(() => {
        destroyClients(false);
        done();
      }, PIPE_CLOSE_GRACE_MS);
      timer.unref?.();
    });
}

/** Sends `stop <token>` (bare `stop` for legacy locks). On `timeoutMs` the socket is destroyed and `timedOut: true` returned. */
export function sendPipeStopRequest(
  net: PipeNet,
  path: string = DAEMON_PIPE_PATH,
  token?: string,
  timeoutMs?: number,
): Promise<{ ok: boolean; pid?: number; error?: string; timedOut?: boolean }> {
  return new Promise((resolve) => {
    const socket = net.connect(path);
    let buffer = "";
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { ok: boolean; pid?: number; error?: string; timedOut?: boolean }): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    if (timeoutMs !== undefined) {
      timer = setTimeout(
        () => finish({ ok: false, error: "timed out waiting for the daemon to answer", timedOut: true }),
        Math.max(0, timeoutMs),
      );
      timer.unref?.();
    }
    socket.on("connect", () => {
      socket.write(token !== undefined ? `stop ${token}\n` : "stop\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, nl)) as { ok?: unknown; pid?: unknown; error?: unknown };
        finish({
          ok: parsed.ok === true,
          ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}),
          ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
        });
      } catch {
        finish({ ok: false, error: "malformed response" });
      }
    });
    socket.on("error", (err) => finish({ ok: false, error: err.message }));
    socket.on("close", () => finish({ ok: false, error: "connection closed without response" }));
  });
}

export interface StopDaemonOptions {
  root: string;
  probes?: Partial<LockOwnerProbes>;
  platform?: NodeJS.Platform;
  hostname?: () => string;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  net?: PipeNet;
  pipePath?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  pollMs?: number;
}

export type StopDaemonResult =
  | { outcome: "stopped"; pid: number }
  | { outcome: "not-running" }
  | { outcome: "stale"; pid: number }
  | { outcome: "refused"; reason: string }
  | { outcome: "timeout"; pid: number };

export async function stopDaemon(opts: StopDaemonOptions): Promise<StopDaemonResult> {
  const status = await getDaemonStatus(opts.root, { probes: opts.probes });
  if (status.state === "not-running") return { outcome: "not-running" };
  if (status.state === "stale") return { outcome: "stale", pid: status.record.pid };
  if (status.state === "unknown") {
    return { outcome: "refused", reason: `daemon lock is unreadable: ${status.path}` };
  }
  const { record } = status;
  const localHost = (opts.hostname ?? opts.probes?.hostname ?? osHostname)();
  if (record.hostname !== undefined && record.hostname !== localHost) {
    return { outcome: "refused", reason: `daemon lock belongs to host ${record.hostname}` };
  }
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DAEMON_STOP_TIMEOUT_MS;
  const deadline = now() + timeoutMs;

  if (platform === "win32") {
    // Older locks without the recorded pipe name fall back to recomputing it.
    const pipePath = opts.pipePath ?? record.pipePath ?? daemonPipePath(opts.root);
    const reply = await sendPipeStopRequest(
      opts.net ?? (await defaultNet()),
      pipePath,
      record.stopToken,
      Math.max(0, deadline - now()),
    );
    if (reply.timedOut) return { outcome: "timeout", pid: record.pid };
    if (!reply.ok) return { outcome: "refused", reason: `pipe stop failed: ${reply.error ?? "unknown error"}` };
    if (reply.pid !== undefined && reply.pid !== record.pid) {
      return { outcome: "refused", reason: `pipe answered for pid ${reply.pid}, lock holder is ${record.pid}` };
    }
  } else {
    const kill = opts.kill ?? ((pid: number, signal: NodeJS.Signals) => void process.kill(pid, signal));
    try {
      kill(record.pid, "SIGTERM");
    } catch (err) {
      return { outcome: "refused", reason: `could not signal pid ${record.pid}: ${(err as Error).message}` };
    }
  }

  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const path = daemonLockPath(opts.root);
  for (;;) {
    const current = await readLockHolder(path);
    let exists = true;
    if (!current) {
      exists = await fs.stat(path).then(() => true, () => false);
    }
    if (!exists || (current && (current.pid !== record.pid || current.acquiredAt !== record.acquiredAt))) {
      return { outcome: "stopped", pid: record.pid };
    }
    if (now() >= deadline) return { outcome: "timeout", pid: record.pid };
    await sleep(opts.pollMs ?? 200);
  }
}
