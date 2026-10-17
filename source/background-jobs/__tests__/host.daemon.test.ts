/**
 * WP-11 (plan item 1.4) — foreground daemon: lifetime lock, tick loop,
 * graceful shutdown, status/stop, Windows named-pipe stop channel.
 *
 * Uses real temp storage roots; timers, signals, platform, kill and net are
 * injected so no real intervals or signals are involved (except the one
 * real-process stop test at the bottom, POSIX only).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { resolveStorageRoot } from "../storage/paths.js";
import {
  acquireDaemonLock,
  DAEMON_PIPE_PATH,
  daemonLockPath,
  daemonPipePath,
  getDaemonStatus,
  sendPipeStopRequest,
  startPipeStopServer,
  startDaemon,
  stopDaemon,
  type DaemonTimers,
  type PipeNet,
  type PipeServer,
  type PipeSocket,
  type SignalRegistrar,
} from "../host/daemon.js";
import { runJobCli, type JobCliDeps } from "../../cli/job-cli.js";
import type { BackgroundTickSummary } from "../../background-jobs-integration.js";
import type { Coordinator } from "../coordinator/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function makeRoot(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "agav-bg-daemon-test-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  return resolveStorageRoot(base);
}

function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  if (typeof result.pid !== "number" || result.pid <= 0) throw new Error("no child pid");
  return result.pid;
}

async function writeDaemonLock(root: string, record: Record<string, unknown>): Promise<string> {
  const path = daemonLockPath(root);
  await mkdir(join(root, "locks"), { recursive: true });
  await writeFile(path, JSON.stringify(record), "utf8");
  return path;
}

const exists = (p: string) => stat(p).then(() => true, () => false);

/** Manual interval driver: `fire()` invokes the registered callback. */
function fakeTimers() {
  let cb: (() => void) | null = null;
  const timers: DaemonTimers & { fire: () => void; active: () => boolean; ms?: number } = {
    setInterval: (fn, ms) => {
      cb = fn;
      timers.ms = ms;
      return 1;
    },
    clearInterval: () => {
      cb = null;
    },
    fire: () => cb?.(),
    active: () => cb !== null,
  };
  return timers;
}

function fakeSignals() {
  const handlers = new Map<string, () => void>();
  const onSignal: SignalRegistrar = (signal, handler) => {
    handlers.set(signal, handler);
    return () => handlers.delete(signal);
  };
  return { onSignal, handlers, emit: (s: string) => handlers.get(s)?.() };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

// Probes: the "live" owner is this test process (pid alive, same host).
const liveProbes = { hostname: () => hostname(), pidExists: async () => true, readStartTime: async () => undefined };

describe("daemon lifetime lock", () => {
  it("acquires daemon.lock with pid/hostname/startedAt/version and releases it", async () => {
    const root = await makeRoot();
    const lock = await acquireDaemonLock(root, "9.9.9");
    expect(lock.acquired).toBe(true);
    if (!lock.acquired) return;
    const raw = JSON.parse(await readFile(daemonLockPath(root), "utf8"));
    expect(raw).toMatchObject({ pid: process.pid, hostname: hostname(), version: "9.9.9" });
    expect(typeof raw.startedAt).toBe("string");
    await lock.release();
    expect(await exists(daemonLockPath(root))).toBe(false);
  });

  it("refuses a second daemon while the owner is alive", async () => {
    const root = await makeRoot();
    const first = await acquireDaemonLock(root, "1");
    expect(first.acquired).toBe(true);
    const second = await acquireDaemonLock(root, "1");
    expect(second).toEqual({ acquired: false, holder: expect.objectContaining({ pid: process.pid }) });
    if (first.acquired) await first.release();
  });

  it("recovers a lock whose owner is verified dead", async () => {
    const root = await makeRoot();
    await writeDaemonLock(root, { pid: deadPid(), hostname: hostname(), acquiredAt: "2000-01-01T00:00:00Z" });
    const lock = await acquireDaemonLock(root, "1");
    expect(lock.acquired).toBe(true);
    if (lock.acquired) {
      expect(JSON.parse(await readFile(daemonLockPath(root), "utf8")).pid).toBe(process.pid);
      await lock.release();
    }
  });

  it("never recovers a corrupt lock or one from another host", async () => {
    const root = await makeRoot();
    await writeDaemonLock(root, { pid: deadPid(), hostname: "some-other-host" });
    expect((await acquireDaemonLock(root, "1")).acquired).toBe(false);
    await writeFile(daemonLockPath(root), "{not json", "utf8");
    expect(await acquireDaemonLock(root, "1")).toEqual({ acquired: false, holder: undefined });
    expect(await readFile(daemonLockPath(root), "utf8")).toBe("{not json");
  });
});

describe("daemon loop", () => {
  it("ticks immediately and then on each interval beat", async () => {
    const root = await makeRoot();
    const timers = fakeTimers();
    const sig = fakeSignals();
    const tick = vi.fn(async () => {});
    const res = await startDaemon({ root, version: "1", tick, timers, onSignal: sig.onSignal, platform: "linux" });
    expect(res.started).toBe(true);
    expect(timers.ms).toBe(15_000);
    expect(tick).toHaveBeenCalledTimes(1);
    await flush();
    timers.fire();
    await flush();
    timers.fire();
    expect(tick).toHaveBeenCalledTimes(3);
    if (res.started) await res.handle.stop();
  });

  it("works with vitest fake timers on the default interval", async () => {
    vi.useFakeTimers();
    try {
      const root = await makeRoot();
      const sig = fakeSignals();
      const tick = vi.fn(async () => {});
      const res = await startDaemon({ root, version: "1", tick, onSignal: sig.onSignal, platform: "linux", intervalMs: 1000 });
      expect(tick).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(tick).toHaveBeenCalledTimes(4);
      if (res.started) await res.handle.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(tick).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never overlaps ticks", async () => {
    const root = await makeRoot();
    const timers = fakeTimers();
    const sig = fakeSignals();
    const gate = deferred();
    let running = 0;
    let maxRunning = 0;
    const tick = vi.fn(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await gate.promise;
      running--;
    });
    const res = await startDaemon({ root, version: "1", tick, timers, onSignal: sig.onSignal, platform: "linux" });
    timers.fire();
    timers.fire();
    expect(tick).toHaveBeenCalledTimes(1);
    gate.resolve();
    await flush();
    timers.fire();
    expect(tick).toHaveBeenCalledTimes(2);
    expect(maxRunning).toBe(1);
    if (res.started) await res.handle.stop();
  });

  it("keeps running when a tick rejects", async () => {
    const root = await makeRoot();
    const timers = fakeTimers();
    const log = vi.fn();
    const tick = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const res = await startDaemon({ root, version: "1", tick, timers, onSignal: fakeSignals().onSignal, platform: "linux", log });
    await flush();
    timers.fire();
    expect(tick).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));
    if (res.started) await res.handle.stop();
  });

  it.each(["SIGTERM", "SIGINT"])("%s stops the interval, awaits the in-flight tick and releases the lock", async (signal) => {
    const root = await makeRoot();
    const timers = fakeTimers();
    const sig = fakeSignals();
    const gate = deferred();
    const tick = vi.fn(() => gate.promise);
    const res = await startDaemon({ root, version: "1", tick, timers, onSignal: sig.onSignal, platform: "linux" });
    if (!res.started) throw new Error("not started");
    let stopped = false;
    void res.handle.stopped.then(() => (stopped = true));
    sig.emit(signal);
    expect(timers.active()).toBe(false);
    await flush();
    expect(stopped).toBe(false); // tick still in flight
    expect(await exists(daemonLockPath(root))).toBe(true);
    gate.resolve();
    await res.handle.stopped;
    expect(await exists(daemonLockPath(root))).toBe(false);
    expect(sig.handlers.size).toBe(0);
  });

  it("refuses to start when another live daemon holds the lock", async () => {
    const root = await makeRoot();
    const first = await startDaemon({ root, version: "1", tick: async () => {}, timers: fakeTimers(), onSignal: fakeSignals().onSignal, platform: "linux" });
    const tick = vi.fn(async () => {});
    const second = await startDaemon({ root, version: "1", tick, timers: fakeTimers(), onSignal: fakeSignals().onSignal, platform: "linux" });
    expect(second).toEqual({ started: false, holder: expect.objectContaining({ pid: process.pid }) });
    expect(tick).not.toHaveBeenCalled();
    if (first.started) await first.handle.stop();
  });
});

describe("daemon status / stop", () => {
  it("reports running, not running and stale", async () => {
    const root = await makeRoot();
    expect(await getDaemonStatus(root)).toEqual({ state: "not-running" });
    await writeDaemonLock(root, { pid: process.pid, hostname: hostname(), startedAt: "2024-01-01T00:00:00.000Z", version: "1.2.3" });
    expect(await getDaemonStatus(root, { probes: liveProbes })).toMatchObject({
      state: "running",
      record: { pid: process.pid, startedAt: "2024-01-01T00:00:00.000Z", version: "1.2.3" },
    });
    await writeDaemonLock(root, { pid: deadPid(), hostname: hostname() });
    expect((await getDaemonStatus(root)).state).toBe("stale");
  });

  it("POSIX stop sends SIGTERM to the verified pid and waits for release", async () => {
    const root = await makeRoot();
    const path = await writeDaemonLock(root, { pid: 424242, hostname: hostname(), acquiredAt: "x" });
    const kill = vi.fn(() => {
      void rm(path);
    });
    const res = await stopDaemon({ root, probes: liveProbes, platform: "linux", kill, sleep: async () => {}, pollMs: 1 });
    expect(kill).toHaveBeenCalledExactlyOnceWith(424242, "SIGTERM");
    expect(res).toEqual({ outcome: "stopped", pid: 424242 });
  });

  it("does not signal a pid from another host, a dead owner, or when nothing runs", async () => {
    const root = await makeRoot();
    const kill = vi.fn();
    expect(await stopDaemon({ root, platform: "linux", kill })).toEqual({ outcome: "not-running" });
    await writeDaemonLock(root, { pid: 424242, hostname: "elsewhere" });
    expect((await stopDaemon({ root, probes: { ...liveProbes }, platform: "linux", kill })).outcome).toBe("refused");
    const dead = deadPid();
    await writeDaemonLock(root, { pid: dead, hostname: hostname() });
    expect(await stopDaemon({ root, platform: "linux", kill })).toEqual({ outcome: "stale", pid: dead });
    expect(kill).not.toHaveBeenCalled();
  });

  it("times out when the lock is not released", async () => {
    const root = await makeRoot();
    await writeDaemonLock(root, { pid: 424242, hostname: hostname(), acquiredAt: "x" });
    let t = 0;
    const res = await stopDaemon({
      root, probes: liveProbes, platform: "linux", kill: () => {},
      sleep: async (ms) => { t += ms; }, now: () => t, timeoutMs: 10_000, pollMs: 1000,
    });
    expect(res).toEqual({ outcome: "timeout", pid: 424242 });
    expect(t).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// Windows named-pipe channel with an in-memory `net`
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter implements PipeSocket {
  peer?: FakeSocket;
  written: string[] = [];
  write(data: string) {
    this.written.push(data);
    const peer = this.peer;
    queueMicrotask(() => peer?.emit("data", Buffer.from(data)));
    return true;
  }
  end(data?: string) {
    if (data !== undefined) this.write(data);
    const peer = this.peer;
    queueMicrotask(() => peer?.emit("close"));
    return this;
  }
  destroy() {
    return this;
  }
}

function fakeNet() {
  const servers = new Map<string, (s: PipeSocket) => void>();
  const connects: string[] = [];
  const net: PipeNet = {
    createServer(onConnection) {
      let path: string | undefined;
      const server: PipeServer = {
        listen(p, cb) {
          path = p;
          servers.set(p, onConnection);
          cb?.();
          return server;
        },
        on() {
          return server;
        },
        close(cb) {
          if (path) servers.delete(path);
          cb?.();
          return server;
        },
      };
      return server;
    },
    connect(path) {
      connects.push(path);
      const client = new FakeSocket();
      const handler = servers.get(path);
      queueMicrotask(() => {
        if (!handler) {
          client.emit("error", new Error("ENOENT"));
          return;
        }
        const serverSide = new FakeSocket();
        serverSide.peer = client;
        client.peer = serverSide;
        handler(serverSide);
        client.emit("connect");
      });
      return client;
    },
  };
  return { net, servers, connects };
}

describe("Windows named-pipe stop channel", () => {
  it("daemon listens on the pipe; a client stop request shuts it down and releases the lock", async () => {
    const root = await makeRoot();
    const { net, servers, connects } = fakeNet();
    const kill = vi.fn();
    const res = await startDaemon({
      root, version: "1", tick: async () => {}, timers: fakeTimers(), onSignal: fakeSignals().onSignal,
      platform: "win32", net, probes: liveProbes,
    });
    if (!res.started) throw new Error("not started");
    const expectedPipe = daemonPipePath(root);
    expect([...servers.keys()]).toEqual([expectedPipe]);

    // The lock records the pipe name and a random stop token.
    const raw = JSON.parse(await readFile(daemonLockPath(root), "utf8"));
    expect(raw.pipePath).toBe(expectedPipe);
    expect(raw.stopToken).toMatch(/^[0-9a-f]{64}$/);

    const out = await stopDaemon({ root, probes: liveProbes, platform: "win32", net, kill, sleep: () => flush(), pollMs: 1 });
    expect(out).toEqual({ outcome: "stopped", pid: process.pid });
    expect(connects).toEqual([expectedPipe]);
    expect(kill).not.toHaveBeenCalled();
    await res.handle.stopped;
    expect(servers.size).toBe(0);
    expect(await exists(daemonLockPath(root))).toBe(false);
  });

  it("does not record pipe fields or listen on POSIX", async () => {
    const root = await makeRoot();
    const { net, servers } = fakeNet();
    const res = await startDaemon({
      root, version: "1", tick: async () => {}, timers: fakeTimers(), onSignal: fakeSignals().onSignal, platform: "linux", net,
    });
    if (!res.started) throw new Error("not started");
    const raw = JSON.parse(await readFile(daemonLockPath(root), "utf8"));
    expect(raw.pipePath).toBeUndefined();
    expect(raw.stopToken).toBeUndefined();
    expect(servers.size).toBe(0);
    await res.handle.stop();
  });

  it("pipe name is deterministic and differs per storage root and per user", async () => {
    const a = daemonPipePath("C:\\Users\\alice\\.agav", "alice");
    expect(a).toBe(daemonPipePath("C:\\Users\\alice\\.agav", "alice"));
    expect(a).toMatch(/^\\\\\.\\pipe\\agav-job-daemon-alice-[0-9a-f]{12}$/);
    expect(daemonPipePath("C:\\Users\\alice\\.agav", "bob")).not.toBe(a);
    expect(daemonPipePath("C:\\Users\\alice\\other-root", "alice")).not.toBe(a);
    expect(a).not.toBe(DAEMON_PIPE_PATH);
    // Usernames are sanitized into a pipe-safe form.
    expect(daemonPipePath("/r", "DOMAIN\\Some User")).toMatch(/^\\\\\.\\pipe\\agav-job-daemon-domain_some_user-[0-9a-f]{12}$/);
    // Defaults to the current user.
    const root = await makeRoot();
    expect(daemonPipePath(root)).toBe(daemonPipePath(root, userInfo().username));
  });

  it("stop uses the pipe name and token recorded in daemon.lock", async () => {
    const root = await makeRoot();
    const { net, connects } = fakeNet();
    const onStop = vi.fn();
    const recorded = "\\\\.\\pipe\\agav-job-daemon-custom-abcdef012345";
    const close = await startPipeStopServer({ net, path: recorded, pid: 434343, token: "secret-token", onStop });
    const path = await writeDaemonLock(root, {
      pid: 434343, hostname: hostname(), acquiredAt: "w", pipePath: recorded, stopToken: "secret-token",
    });
    onStop.mockImplementation(() => void rm(path));
    const out = await stopDaemon({ root, probes: liveProbes, platform: "win32", net, sleep: () => flush(), pollMs: 1 });
    expect(out).toEqual({ outcome: "stopped", pid: 434343 });
    expect(connects).toEqual([recorded]);
    expect(onStop).toHaveBeenCalledTimes(1);
    await close();
  });

  it("server rejects a wrong token, a bare stop and unknown commands", async () => {
    const { net } = fakeNet();
    const onStop = vi.fn();
    const pipe = "\\\\.\\pipe\\agav-job-daemon-test-000000000000";
    const close = await startPipeStopServer({ net, path: pipe, pid: 1, token: "right", onStop });
    expect(await sendPipeStopRequest(net, pipe, "wrong")).toEqual({ ok: false, error: "invalid stop token" });
    expect(await sendPipeStopRequest(net, pipe, "righ")).toEqual({ ok: false, error: "invalid stop token" });
    expect(await sendPipeStopRequest(net, pipe)).toEqual({ ok: false, error: "invalid stop token" });
    expect(await sendPipeStopRequest(net, pipe, "right extra")).toEqual({ ok: false, error: "unknown command" });
    expect(onStop).not.toHaveBeenCalled();
    expect(await sendPipeStopRequest(net, pipe, "right")).toEqual({ ok: true, pid: 1 });
    expect(onStop).toHaveBeenCalledTimes(1);
    await close();
  });

  it("stop with a wrong token in the lock is refused and the daemon keeps running", async () => {
    const root = await makeRoot();
    const { net } = fakeNet();
    const res = await startDaemon({
      root, version: "1", tick: async () => {}, timers: fakeTimers(), onSignal: fakeSignals().onSignal,
      platform: "win32", net, probes: liveProbes,
    });
    if (!res.started) throw new Error("not started");
    const path = daemonLockPath(root);
    const raw = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...raw, stopToken: "forged" }), "utf8");
    const out = await stopDaemon({ root, probes: liveProbes, platform: "win32", net, sleep: () => flush(), pollMs: 1 });
    expect(out).toEqual({ outcome: "refused", reason: "pipe stop failed: invalid stop token" });
    expect(await exists(path)).toBe(true);
    await writeFile(path, JSON.stringify(raw), "utf8");
    await res.handle.stop();
    expect(await exists(path)).toBe(false);
  });

  it("old lock without pipePath/stopToken falls back to the recomputed pipe name", async () => {
    const root = await makeRoot();
    const { net, connects } = fakeNet();
    // A legacy lock (no fields) whose daemon is not listening: stop targets the
    // recomputed per-user/per-root name and reports the pipe failure.
    await writeDaemonLock(root, { pid: 454545, hostname: hostname(), acquiredAt: "old" });
    const out = await stopDaemon({ root, probes: liveProbes, platform: "win32", net, sleep: () => flush(), pollMs: 1 });
    expect(out).toEqual({ outcome: "refused", reason: "pipe stop failed: ENOENT" });
    expect(connects).toEqual([daemonPipePath(root)]);
    // getDaemonStatus still reads such a lock as running.
    expect(await getDaemonStatus(root, { probes: liveProbes })).toMatchObject({ state: "running", record: { pid: 454545 } });
  });

  it("client reports failure when no daemon is listening", async () => {
    const { net } = fakeNet();
    expect(await sendPipeStopRequest(net)).toEqual({ ok: false, error: "ENOENT" });
  });
});

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

function summary(over: Partial<BackgroundTickSummary> = {}): BackgroundTickSummary {
  return { paused: false, dispatched: 0, skipped: 0, errors: 0, errorMessages: [], results: [], ...over };
}

describe("agav job daemon (CLI)", () => {
  function cliDeps(root: string, configs: Array<Awaited<ReturnType<NonNullable<JobCliDeps["loadConfig"]>>>>) {
    const out: string[] = [];
    const err: string[] = [];
    const timers = fakeTimers();
    const sig = fakeSignals();
    let i = 0;
    const deps = {
      loadConfig: vi.fn(async () => configs[Math.min(i++, configs.length - 1)]!),
      getCoordinator: vi.fn(async () => ({ root } as unknown as Coordinator)),
      reconcile: vi.fn(async () => {}),
      runTick: vi.fn(async () => summary()),
      stdout: (s: string) => { out.push(s); },
      stderr: (s: string) => { err.push(s); },
      daemon: { root, version: "7.7.7", timers, onSignal: sig.onSignal, platform: "linux" as const, probes: liveProbes },
    } satisfies JobCliDeps;
    return { deps, out, err, timers, sig };
  }

  it("start ticks with reloaded config, skips while paused, and exits 0 on SIGTERM", async () => {
    const root = await makeRoot();
    const on = { permissionMode: "ask" as const, backgroundJobsEnabled: true, backgroundAutomation: "on" as const };
    const { deps, out, timers, sig } = cliDeps(root, [on, { ...on, backgroundAutomation: "paused" }, { ...on, permissionMode: "deny-writes" as const }]);
    const exit = runJobCli(["daemon", "start"], deps);
    await vi.waitFor(() => expect(deps.runTick).toHaveBeenCalledTimes(1));
    expect(deps.runTick).toHaveBeenLastCalledWith(expect.objectContaining({ session: { permissionMode: "ask", headlessApprovedActions: [] } }));
    timers.fire(); // paused
    await vi.waitFor(() => expect(deps.loadConfig).toHaveBeenCalledTimes(2));
    await flush();
    expect(deps.runTick).toHaveBeenCalledTimes(1);
    timers.fire();
    await vi.waitFor(() => expect(deps.runTick).toHaveBeenCalledTimes(2));
    expect(deps.runTick).toHaveBeenLastCalledWith(expect.objectContaining({ session: { permissionMode: "deny-writes", headlessApprovedActions: [] } }));
    sig.emit("SIGTERM");
    expect(await exit).toBe(0);
    expect(out.join("")).toContain("daemon started");
    expect(await exists(daemonLockPath(root))).toBe(false);
  });

  it("start exits 1 with 'daemon already running (pid N)' when held", async () => {
    const root = await makeRoot();
    await writeDaemonLock(root, { pid: process.pid, hostname: hostname() });
    const { deps, err } = cliDeps(root, [{ backgroundJobsEnabled: true }]);
    expect(await runJobCli(["daemon", "start"], deps)).toBe(1);
    expect(err.join("")).toContain(`daemon already running (pid ${process.pid})`);
    expect(deps.runTick).not.toHaveBeenCalled();
  });

  it("status prints running / not running / stale with exit 0 / 3 / 3", async () => {
    const root = await makeRoot();
    const { deps, out } = cliDeps(root, [{}]);
    expect(await runJobCli(["daemon", "status"], deps)).toBe(3);
    expect(out.pop()).toBe("not running\n");
    await writeDaemonLock(root, { pid: process.pid, hostname: hostname(), startedAt: "2024-05-01T00:00:00.000Z", version: "7.7.7" });
    expect(await runJobCli(["daemon", "status"], deps)).toBe(0);
    expect(out.pop()).toBe(`running (pid ${process.pid}, since 2024-05-01T00:00:00.000Z, version 7.7.7)\n`);
    const { deps: d2, out: o2 } = cliDeps(root, [{}]);
    d2.daemon.probes = { ...liveProbes, pidExists: async () => false };
    expect(await runJobCli(["daemon", "status"], d2)).toBe(3);
    expect(o2.pop()).toMatch(/^stale lock \(owner dead/);
  });

  it("stop exits 0 after SIGTERM releases the lock, 1 on timeout", async () => {
    const root = await makeRoot();
    const path = await writeDaemonLock(root, { pid: 515151, hostname: hostname(), acquiredAt: "a" });
    const { deps } = cliDeps(root, [{}]);
    const kill = vi.fn(() => void rm(path));
    Object.assign(deps.daemon, { kill, sleep: async () => {} });
    expect(await runJobCli(["daemon", "stop"], deps)).toBe(0);
    expect(kill).toHaveBeenCalledWith(515151, "SIGTERM");

    await writeDaemonLock(root, { pid: 515151, hostname: hostname(), acquiredAt: "a" });
    let t = 0;
    Object.assign(deps.daemon, { kill: () => {}, sleep: async (ms: number) => { t += ms; }, now: () => t, stopTimeoutMs: 1000 });
    expect(await runJobCli(["daemon", "stop"], deps)).toBe(1);
  });

  it("rejects unknown/missing daemon subcommands", async () => {
    const root = await makeRoot();
    const { deps, err } = cliDeps(root, [{}]);
    expect(await runJobCli(["daemon"], deps)).toBe(1);
    expect(await runJobCli(["daemon", "bogus"], deps)).toBe(1);
    expect(err.join("")).toContain("bogus");
  });
});

// ---------------------------------------------------------------------------
// Real-process stop (POSIX): a child that removes the lock on SIGTERM
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === "win32")("real-process stop", () => {
  it("SIGTERMs a real daemon-like child and observes the lock release", async () => {
    const root = await makeRoot();
    const path = daemonLockPath(root);
    await mkdir(join(root, "locks"), { recursive: true });
    const script = `
      const fs = require("node:fs");
      const os = require("node:os");
      const path = ${JSON.stringify(path)};
      fs.writeFileSync(path, JSON.stringify({ pid: process.pid, hostname: os.hostname(), acquiredAt: "real" }));
      const t = setInterval(() => {}, 1000);
      process.on("SIGTERM", () => { clearInterval(t); fs.unlinkSync(path); process.exit(0); });
      process.stdout.write("ready\\n");
    `;
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    cleanups.push(async () => { child.kill("SIGKILL"); });
    await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    expect((await getDaemonStatus(root)).state).toBe("running");
    const res = await stopDaemon({ root, pollMs: 20 });
    expect(res).toEqual({ outcome: "stopped", pid: child.pid });
    expect(await exited).toBe(0);
  }, 15_000);
});
