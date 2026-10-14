import { describe, expect, it, vi } from "vitest";
import { runJobCli, type JobCliDeps } from "../cli/job-cli.js";
import type { BackgroundTickSummary } from "../background-jobs-integration.js";
import type { Coordinator } from "../background-jobs/coordinator/index.js";
import { daemonLockPath, type DaemonTimers, type SignalRegistrar } from "../background-jobs/host/daemon.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

type Cfg = Awaited<ReturnType<NonNullable<JobCliDeps["loadConfig"]>>>;

function summary(over: Partial<BackgroundTickSummary> = {}): BackgroundTickSummary {
  return { paused: false, dispatched: 0, skipped: 0, errors: 0, errorMessages: [], results: [], ...over };
}

function makeDeps(config: Cfg, tick: BackgroundTickSummary = summary()) {
  const out: string[] = [];
  const err: string[] = [];
  const coordinator = { fake: true } as unknown as Coordinator;
  const deps = {
    loadConfig: vi.fn(async () => config),
    getCoordinator: vi.fn(async () => coordinator),
    reconcile: vi.fn(async () => {}),
    runTick: vi.fn(async () => tick),
    stdout: (s: string) => { out.push(s); },
    stderr: (s: string) => { err.push(s); },
  } satisfies JobCliDeps;
  return { deps, out, err, coordinator };
}

const enabled: Cfg = { permissionMode: "ask", backgroundJobsEnabled: true, backgroundAutomation: "on" };

describe("agav job tick", () => {
  it("runs one tick and prints a summary", async () => {
    const { deps, out, coordinator } = makeDeps(enabled, summary({ dispatched: 2, skipped: 1 }));
    expect(await runJobCli(["tick"], deps)).toBe(0);
    expect(deps.reconcile).toHaveBeenCalledWith(coordinator);
    expect(deps.runTick).toHaveBeenCalledWith({
      coordinator,
      session: { permissionMode: "ask", headlessApprovedActions: [] },
      backgroundAutomation: "on",
    });
    expect(out.join("")).toContain("tick: dispatched=2 skipped=1 errors=0");
  });

  it("returns 1 and reports messages when the tick has errors", async () => {
    const { deps, out, err } = makeDeps(enabled, summary({ errors: 1, errorMessages: ["engine exploded"] }));
    expect(await runJobCli(["tick"], deps)).toBe(1);
    expect(out.join("")).toContain("errors=1");
    expect(err.join("")).toContain("engine exploded");
  });

  it("still ticks when reconcile fails", async () => {
    const { deps } = makeDeps(enabled);
    deps.reconcile.mockRejectedValueOnce(new Error("nope"));
    expect(await runJobCli(["tick"], deps)).toBe(0);
    expect(deps.runTick).toHaveBeenCalledOnce();
  });

  it("does nothing when automation is paused", async () => {
    const { deps, out } = makeDeps({ ...enabled, backgroundAutomation: "paused" });
    expect(await runJobCli(["tick"], deps)).toBe(0);
    expect(deps.getCoordinator).not.toHaveBeenCalled();
    expect(deps.runTick).not.toHaveBeenCalled();
    expect(out.join("")).toMatch(/paused/);
  });

  it("does nothing when background jobs are disabled", async () => {
    const { deps, out } = makeDeps({ ...enabled, backgroundJobsEnabled: false });
    expect(await runJobCli(["tick"], deps)).toBe(0);
    expect(deps.getCoordinator).not.toHaveBeenCalled();
    expect(out.join("")).toContain("Background jobs are disabled (backgroundJobsEnabled=false); nothing to do.");
  });

  it("passes the configured permission mode through to the session", async () => {
    const { deps } = makeDeps({ ...enabled, permissionMode: "deny-writes" });
    await runJobCli(["tick"], deps);
    expect(deps.runTick).toHaveBeenCalledWith(
      expect.objectContaining({ session: { permissionMode: "deny-writes", headlessApprovedActions: [] } }),
    );
  });

  it("awaits a slow reconcile before running the tick", async () => {
    const { deps } = makeDeps(enabled);
    const events: string[] = [];
    deps.reconcile.mockImplementationOnce(async () => {
      events.push("reconcile:start");
      await new Promise((r) => setTimeout(r, 20));
      events.push("reconcile:end");
    });
    deps.runTick.mockImplementationOnce(async () => {
      events.push("runTick");
      return summary();
    });
    expect(await runJobCli(["tick"], deps)).toBe(0);
    expect(events).toEqual(["reconcile:start", "reconcile:end", "runTick"]);
  });

  it("rejects unknown tick flags", async () => {
    const { deps, err } = makeDeps(enabled);
    expect(await runJobCli(["tick", "--bogus"], deps)).toBe(1);
    expect(err.join("")).toContain("--bogus");
    expect(deps.loadConfig).not.toHaveBeenCalled();
  });
});

describe("agav job daemon start (V-11 / V-2)", () => {
  async function makeRoot(): Promise<string> {
    return mkdtemp(join(tmpdir(), "agav-job-cli-daemon-"));
  }

  function daemonDeps(root: string, configs: Cfg[]) {
    const out: string[] = [];
    const err: string[] = [];
    const events: string[] = [];
    const handlers = new Map<string, () => void>();
    const timers: DaemonTimers = { setInterval: () => 1, clearInterval: () => {} };
    const onSignal: SignalRegistrar = (signal, handler) => {
      handlers.set(signal, handler);
      return () => { handlers.delete(signal); };
    };
    let i = 0;
    const coordinator = { root } as unknown as Coordinator;
    const deps = {
      loadConfig: vi.fn(async () => configs[Math.min(i++, configs.length - 1)]!),
      getCoordinator: vi.fn(async () => {
        events.push("getCoordinator");
        return coordinator;
      }),
      reconcile: vi.fn(async () => {
        events.push("reconcile:start");
        await new Promise((r) => setTimeout(r, 20));
        events.push("reconcile:end");
      }),
      runTick: vi.fn(async () => {
        events.push("runTick");
        return summary();
      }),
      stdout: (s: string) => { out.push(s); },
      stderr: (s: string) => { err.push(s); },
      daemon: {
        root,
        version: "1.0.0",
        timers,
        onSignal,
        platform: "linux" as const,
        probes: { hostname: () => hostname(), pidExists: async () => true, readStartTime: async () => undefined },
      },
    } satisfies JobCliDeps;
    return { deps, out, err, events, emit: (s: string) => handlers.get(s)?.() };
  }

  it("fails fast on a held lock without constructing the coordinator or reconciling", async () => {
    const root = await makeRoot();
    try {
      await mkdir(join(root, "locks"), { recursive: true });
      await writeFile(daemonLockPath(root), JSON.stringify({ pid: process.pid, hostname: hostname(), acquiredAt: "x" }));
      const { deps, err } = daemonDeps(root, [enabled]);
      expect(await runJobCli(["daemon", "start"], deps)).toBe(1);
      expect(err.join("")).toContain(`daemon already running (pid ${process.pid})`);
      expect(deps.getCoordinator).not.toHaveBeenCalled();
      expect(deps.reconcile).not.toHaveBeenCalled();
      expect(deps.runTick).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("acquires the lock, reconciles fully, then ticks", async () => {
    const root = await makeRoot();
    try {
      const { deps, events, emit } = daemonDeps(root, [enabled]);
      const exit = runJobCli(["daemon", "start"], deps);
      await vi.waitFor(() => expect(deps.runTick).toHaveBeenCalledTimes(1));
      expect(events).toEqual(["getCoordinator", "reconcile:start", "reconcile:end", "runTick"]);
      expect(deps.reconcile).toHaveBeenCalledTimes(1);
      emit("SIGTERM");
      expect(await exit).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prints a one-time notice when background jobs are disabled", async () => {
    const root = await makeRoot();
    try {
      const { deps, out, emit } = daemonDeps(root, [{ ...enabled, backgroundJobsEnabled: false }]);
      const exit = runJobCli(["daemon", "start"], deps);
      await vi.waitFor(() => expect(out.join("")).toContain("daemon started"));
      await vi.waitFor(() => expect(deps.loadConfig).toHaveBeenCalled());
      emit("SIGTERM");
      expect(await exit).toBe(0);
      const notice = "Background jobs are disabled (backgroundJobsEnabled=false); daemon will idle until enabled.";
      expect(out.join("").split(notice).length - 1).toBe(1);
      expect(deps.runTick).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("agav job dispatch", () => {
  it("rejects an unknown subcommand", async () => {
    const { deps, err } = makeDeps(enabled);
    expect(await runJobCli(["frobnicate"], deps)).toBe(1);
    expect(err.join("")).toContain("Usage");
  });

  it.each([[[]], [["help"]], [["--help"]]])("prints usage for %j", async (argv) => {
    const { deps, out } = makeDeps(enabled);
    expect(await runJobCli(argv, deps)).toBe(0);
    expect(out.join("")).toContain("agav job tick");
    expect(deps.loadConfig).not.toHaveBeenCalled();
  });
});
