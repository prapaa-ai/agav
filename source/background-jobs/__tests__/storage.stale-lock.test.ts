/**
 * WP-02 (plan item 0.1) — verified-gone stale-lock recovery.
 *
 * Uses real temp storage roots and the real platform adapter (this repo's
 * dev/CI sandbox runs on Linux), matching storage.repositories.test.ts.
 * "Dead pid" fixtures come from a child process that has already exited.
 * "Pid reuse" fixtures use this test process's own (alive) pid with a
 * recorded start time that cannot match.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { lockPath, resolveStorageRoot } from "../storage/paths.js";
import {
  isLockOwnerGone,
  readLockHolder,
  tryRecoverStaleLock,
  withJobLock,
  type LockHolder,
} from "../storage/single-writer-lock.js";
import { readProcessStartTimePosix } from "../platform/posix-common.js";
import { platformAdapter as windowsAdapter } from "../platform/windows.js";

async function makeRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "agav-bg-stale-lock-test-"));
  const root = await resolveStorageRoot(base);
  return { root, cleanup: () => rm(base, { recursive: true, force: true }) };
}

/** A pid that belonged to a process which has already exited. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  if (typeof result.pid !== "number" || result.pid <= 0) throw new Error("could not obtain a child pid");
  return result.pid;
}

async function writeLock(root: string, jobId: string, content: string): Promise<string> {
  const path = lockPath(root, `job-${jobId}`);
  await mkdir(join(root, "locks"), { recursive: true });
  await writeFile(path, content, "utf8");
  return path;
}

async function quarantinedLocks(root: string, jobId: string): Promise<string[]> {
  try {
    return (await readdir(join(root, "quarantine"))).filter((f) => f.startsWith(`job-${jobId}.lock.stale-`));
  } catch {
    return [];
  }
}

async function expectRecovered(root: string, jobId: string, path: string): Promise<void> {
  let ran = false;
  await withJobLock(root, jobId, async () => {
    ran = true;
    const holder = await readLockHolder(path);
    expect(holder?.pid).toBe(process.pid);
    expect(holder?.hostname).toBe(hostname());
  });
  expect(ran).toBe(true);
  expect(await quarantinedLocks(root, jobId)).toHaveLength(1);
}

async function expectStillHeld(root: string, jobId: string, path: string, original: string): Promise<void> {
  await expect(withJobLock(root, jobId, async () => {})).rejects.toMatchObject({ code: "lock-held" });
  expect(await readFile(path, "utf8")).toBe(original); // untouched, not stolen
  expect(await quarantinedLocks(root, jobId)).toHaveLength(0);
}

describe("withJobLock stale-lock recovery (verified-gone only)", () => {
  it("writes pid, processStartTime and hostname into the lock file", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const jobId = randomUUID();
      await withJobLock(root, jobId, async () => {
        const holder = await readLockHolder(lockPath(root, `job-${jobId}`));
        expect(holder?.pid).toBe(process.pid);
        expect(holder?.hostname).toBe(hostname());
        expect(holder?.processStartTime).toBe(await readProcessStartTimePosix(process.pid));
        expect(typeof holder?.acquiredAt).toBe("string");
      });
    } finally {
      await cleanup();
    }
  });

  it("live holder: lock-held, not stolen (even with an ancient acquiredAt)", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const jobId = randomUUID();
      const startTime = await readProcessStartTimePosix(process.pid);
      const content = JSON.stringify({
        pid: process.pid,
        acquiredAt: "2000-01-01T00:00:00.000Z",
        ...(startTime !== undefined ? { processStartTime: startTime } : {}),
        hostname: hostname(),
      });
      const path = await writeLock(root, jobId, content);
      await expectStillHeld(root, jobId, path, content);
    } finally {
      await cleanup();
    }
  });

  it("live holder held by another call stack in this process: lock-held (existing behaviour)", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const jobId = randomUUID();
      let releaseFirst: (() => void) | undefined;
      const held = new Promise<void>((resolveHeld) => {
        void withJobLock(root, jobId, () => {
          resolveHeld();
          return new Promise<void>((r) => {
            releaseFirst = r;
          });
        });
      });
      await held;
      await expect(withJobLock(root, jobId, async () => {})).rejects.toMatchObject({ code: "lock-held" });
      expect(await quarantinedLocks(root, jobId)).toHaveLength(0);
      releaseFirst?.();
    } finally {
      await cleanup();
    }
  });

  it("re-entrant acquisition in the same call stack still runs without re-acquiring", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const jobId = randomUUID();
      const result = await withJobLock(root, jobId, () => withJobLock(root, jobId, async () => 42));
      expect(result).toBe(42);
    } finally {
      await cleanup();
    }
  });

  it("dead pid: recovered (stale file quarantined, lock acquired)", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const jobId = randomUUID();
      const path = await writeLock(
        root,
        jobId,
        JSON.stringify({ pid: deadPid(), acquiredAt: new Date().toISOString(), processStartTime: "1", hostname: hostname() }),
      );
      await expectRecovered(root, jobId, path);
    } finally {
      await cleanup();
    }
  });

  it("pid reuse (pid alive, start time differs): recovered", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      // Only meaningful where the start time is readable (Linux /proc or ps).
      if ((await readProcessStartTimePosix(process.pid)) === undefined) return;
      const jobId = randomUUID();
      const path = await writeLock(
        root,
        jobId,
        JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          processStartTime: "not-a-real-start-time",
          hostname: hostname(),
        }),
      );
      await expectRecovered(root, jobId, path);
    } finally {
      await cleanup();
    }
  });

  it("legacy {pid, acquiredAt} file with a dead pid: recovered via the pid check", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const jobId = randomUUID();
      const path = await writeLock(root, jobId, JSON.stringify({ pid: deadPid(), acquiredAt: new Date().toISOString() }));
      await expectRecovered(root, jobId, path);
    } finally {
      await cleanup();
    }
  });

  it("legacy {pid, acquiredAt} file with a live pid: lock-held (reuse undetectable)", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const jobId = randomUUID();
      const content = JSON.stringify({ pid: process.pid, acquiredAt: "2000-01-01T00:00:00.000Z" });
      const path = await writeLock(root, jobId, content);
      await expectStillHeld(root, jobId, path, content);
    } finally {
      await cleanup();
    }
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   \n"],
    ["truncated json", '{"pid": 12'],
    ["non-object", "[1,2,3]"],
    ["missing pid", JSON.stringify({ acquiredAt: "2000-01-01T00:00:00.000Z" })],
    ["string pid", JSON.stringify({ pid: "123" })],
    ["zero pid", JSON.stringify({ pid: 0 })],
    ["negative pid", JSON.stringify({ pid: -1 })],
    ["fractional pid", JSON.stringify({ pid: 1.5 })],
    ["non-string hostname", JSON.stringify({ pid: 999999, hostname: 7 })],
  ])("corrupt/empty holder (%s): lock-held, not stolen", async (_label, content) => {
    const { root, cleanup } = await makeRoot();
    try {
      const jobId = randomUUID();
      const path = await writeLock(root, jobId, content);
      await expectStillHeld(root, jobId, path, content);
    } finally {
      await cleanup();
    }
  });

  it("cross-host lock with a pid that is dead locally: lock-held, not stolen", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const jobId = randomUUID();
      const content = JSON.stringify({
        pid: deadPid(),
        acquiredAt: "2000-01-01T00:00:00.000Z",
        processStartTime: "1",
        hostname: `${hostname()}-some-other-host`,
      });
      const path = await writeLock(root, jobId, content);
      await expectStillHeld(root, jobId, path, content);
    } finally {
      await cleanup();
    }
  });

  it("two concurrent recoverers of the same stale lock: exactly one wins", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const jobId = randomUUID();
      await writeLock(root, jobId, JSON.stringify({ pid: deadPid(), acquiredAt: new Date().toISOString(), hostname: hostname() }));

      let openGate: () => void = () => {};
      const gate = new Promise<void>((r) => {
        openGate = r;
      });
      // Fallback so a regression (both acquire) fails the assertion instead of hanging.
      const fallback = setTimeout(openGate, 3000);
      let inside = 0;
      let maxInside = 0;
      const attempt = () =>
        withJobLock(root, jobId, async () => {
          inside++;
          maxInside = Math.max(maxInside, inside);
          await gate;
          inside--;
        }).catch((error: unknown) => {
          openGate(); // the loser has settled; let the winner finish
          throw error;
        });

      const results = await Promise.allSettled([attempt(), attempt()]);
      clearTimeout(fallback);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({ code: "lock-held" });
      expect(maxInside).toBe(1);
      expect(await quarantinedLocks(root, jobId)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("a held recovery guard makes a recoverer report lock-held without touching the lock", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const jobId = randomUUID();
      const content = JSON.stringify({ pid: deadPid(), acquiredAt: new Date().toISOString(), hostname: hostname() });
      const path = await writeLock(root, jobId, content);
      // A live recoverer (this process) holds the guard.
      await writeFile(`${path}.recovery`, JSON.stringify({ pid: process.pid, hostname: hostname() }), "utf8");
      expect(await tryRecoverStaleLock(root, path)).toBe(false);
      expect(await readFile(path, "utf8")).toBe(content);
    } finally {
      await cleanup();
    }
  });

  it("a guard abandoned by a dead recoverer is moved aside so a later attempt recovers", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const jobId = randomUUID();
      const path = await writeLock(root, jobId, JSON.stringify({ pid: deadPid(), hostname: hostname() }));
      await writeFile(`${path}.recovery`, JSON.stringify({ pid: deadPid(), hostname: hostname() }), "utf8");
      expect(await tryRecoverStaleLock(root, path)).toBe(false); // this attempt only clears the guard
      await expectRecovered(root, jobId, path);
    } finally {
      await cleanup();
    }
  });
});

describe("readLockHolder", () => {
  it("returns undefined for a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-bg-lock-holder-"));
    try {
      expect(await readLockHolder(join(dir, "nope.lock"))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parses current and legacy formats", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-bg-lock-holder-"));
    try {
      const current = join(dir, "a.lock");
      await writeFile(current, JSON.stringify({ pid: 10, acquiredAt: "t", processStartTime: "s", hostname: "h" }));
      expect(await readLockHolder(current)).toEqual({ pid: 10, acquiredAt: "t", processStartTime: "s", hostname: "h" });
      const legacy = join(dir, "b.lock");
      await writeFile(legacy, JSON.stringify({ pid: 11, acquiredAt: "t" }));
      expect(await readLockHolder(legacy)).toEqual({ pid: 11, acquiredAt: "t" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("isLockOwnerGone decision table", () => {
  const HOST = "host-a";
  type Row = {
    name: string;
    holder: LockHolder;
    pidExists: boolean | "throws";
    startTime: string | undefined | "throws";
    gone: boolean;
  };
  const rows: Row[] = [
    { name: "same host, pid dead", holder: { pid: 5, processStartTime: "100", hostname: HOST }, pidExists: false, startTime: undefined, gone: true },
    { name: "same host, pid alive, same start", holder: { pid: 5, processStartTime: "100", hostname: HOST }, pidExists: true, startTime: "100", gone: false },
    { name: "same host, pid alive, start differs (reuse)", holder: { pid: 5, processStartTime: "100", hostname: HOST }, pidExists: true, startTime: "200", gone: true },
    { name: "same host, pid alive, start unreadable", holder: { pid: 5, processStartTime: "100", hostname: HOST }, pidExists: true, startTime: undefined, gone: false },
    { name: "same host, pid alive, no recorded start (Windows)", holder: { pid: 5, hostname: HOST }, pidExists: true, startTime: "200", gone: false },
    { name: "same host, pid dead, no recorded start (Windows)", holder: { pid: 5, hostname: HOST }, pidExists: false, startTime: undefined, gone: true },
    { name: "legacy (no host), pid dead", holder: { pid: 5, acquiredAt: "2000-01-01T00:00:00.000Z" }, pidExists: false, startTime: undefined, gone: true },
    { name: "legacy (no host), pid alive, ancient acquiredAt", holder: { pid: 5, acquiredAt: "2000-01-01T00:00:00.000Z" }, pidExists: true, startTime: "1", gone: false },
    { name: "other host, pid dead", holder: { pid: 5, processStartTime: "100", hostname: "host-b" }, pidExists: false, startTime: undefined, gone: false },
    { name: "other host, start differs", holder: { pid: 5, processStartTime: "100", hostname: "host-b" }, pidExists: true, startTime: "200", gone: false },
    { name: "pid probe throws", holder: { pid: 5, processStartTime: "100", hostname: HOST }, pidExists: "throws", startTime: "200", gone: false },
    { name: "start-time probe throws", holder: { pid: 5, processStartTime: "100", hostname: HOST }, pidExists: true, startTime: "throws", gone: false },
  ];

  it.each(rows)("$name → gone=$gone", async ({ holder, pidExists, startTime, gone }) => {
    const result = await isLockOwnerGone(holder, {
      hostname: () => HOST,
      pidExists: async () => {
        if (pidExists === "throws") throw new Error("probe failed");
        return pidExists;
      },
      readStartTime: async () => {
        if (startTime === "throws") throw new Error("probe failed");
        return startTime;
      },
    });
    expect(result).toBe(gone);
  });

  it("real probes: this live process is not gone; an exited child is gone", async () => {
    expect(await isLockOwnerGone({ pid: process.pid, hostname: hostname() })).toBe(false);
    expect(await isLockOwnerGone({ pid: deadPid(), hostname: hostname() })).toBe(true);
  });
});

describe("windows acquireLock sharing-violation retry (Node-API proxy on Linux)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function sharingViolation(code: string): NodeJS.ErrnoException {
    const error = new Error(`${code}: resource busy or locked`) as NodeJS.ErrnoException;
    error.code = code;
    return error;
  }

  it("retries transient EBUSY/EPERM/EACCES with backoff and then acquires", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-bg-win-lock-retry-"));
    const path = join(dir, "job.lock");
    try {
      const realOpen = fsPromises.open.bind(fsPromises);
      const failures = ["EBUSY", "EPERM", "EACCES"];
      const spy = vi.spyOn(fsPromises, "open").mockImplementation(((...args: Parameters<typeof fsPromises.open>) => {
        const next = failures.shift();
        if (next) return Promise.reject(sharingViolation(next));
        return realOpen(...args);
      }) as typeof fsPromises.open);
      const release = await windowsAdapter.acquireLock(path);
      expect(spy).toHaveBeenCalledTimes(4);
      const holder = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      expect(holder["pid"]).toBe(process.pid);
      expect(holder["hostname"]).toBe(hostname());
      await release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gives up after bounded retries and rethrows the sharing violation (not lock-held)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-bg-win-lock-retry-"));
    const path = join(dir, "job.lock");
    try {
      const spy = vi
        .spyOn(fsPromises, "open")
        .mockImplementation((() => Promise.reject(sharingViolation("EBUSY"))) as typeof fsPromises.open);
      await expect(windowsAdapter.acquireLock(path)).rejects.toMatchObject({ code: "EBUSY" });
      expect(spy.mock.calls.length).toBeGreaterThan(1);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(10);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("EEXIST is not retried and still maps to lock-held", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-bg-win-lock-retry-"));
    const path = join(dir, "job.lock");
    try {
      const release = await windowsAdapter.acquireLock(path);
      const spy = vi.spyOn(fsPromises, "open");
      await expect(windowsAdapter.acquireLock(path)).rejects.toMatchObject({ code: "lock-held" });
      expect(spy).toHaveBeenCalledTimes(1);
      await release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
