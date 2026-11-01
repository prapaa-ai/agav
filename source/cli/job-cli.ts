/**
 * `agav job <command>` — headless background-jobs commands.
 *
 * Also the target of the internal tick re-exec flag in cli.tsx, which calls
 * `runJobCli(["tick", ...])`. Must never import Ink / main.tsx.
 */
import type { AgavConfig } from "../config/config.js";
import type { Coordinator } from "../background-jobs/coordinator/index.js";
import type { BackgroundTickOptions, BackgroundTickSummary } from "../background-jobs-integration.js";
import type { SessionPolicySnapshot } from "../background-jobs/types.js";
import type { LockOwnerProbes } from "../background-jobs/storage/single-writer-lock.js";
import type {
  DaemonHandle,
  DaemonTimers,
  PipeNet,
  SignalRegistrar,
} from "../background-jobs/host/daemon.js";
import type { OsSchedulerDeps } from "../background-jobs/host/os-scheduler/index.js";

type TickConfig = Partial<Pick<AgavConfig, "permissionMode" | "backgroundJobsEnabled" | "backgroundAutomation" | "workflowsEnabled" | "maxConcurrentWorkflowRuns">>;

/** Workflow reconcile options for a tick, mirroring the in-app ticker; only when the workflows gate is on. */
function workflowTickOptions(config: TickConfig): Pick<BackgroundTickOptions, "workflows"> {
  return config.workflowsEnabled === true ? { workflows: { maxConcurrentWorkflowRuns: config.maxConcurrentWorkflowRuns } } : {};
}

export interface JobCliDeps {
  loadConfig?: () => Promise<TickConfig>;
  getCoordinator?: () => Promise<Coordinator>;
  reconcile?: (coordinator: Coordinator) => Promise<void>;
  runTick?: (opts: BackgroundTickOptions) => Promise<BackgroundTickSummary>;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Injectable daemon environment (tests). */
  daemon?: JobDaemonDeps;
  /** Injectable OS-scheduler environment (tests). */
  osScheduler?: OsSchedulerDeps;
}

/** Test overrides for `agav job daemon …`; defaults are the real process/OS. */
export interface JobDaemonDeps {
  /** Storage root holding `locks/daemon.lock`. */
  root?: string;
  version?: string;
  intervalMs?: number;
  timers?: DaemonTimers;
  onSignal?: SignalRegistrar;
  platform?: NodeJS.Platform;
  net?: PipeNet;
  pipePath?: string;
  probes?: Partial<LockOwnerProbes>;
  hostname?: () => string;
  pid?: number;
  readStartTime?: (pid: number) => Promise<string | undefined>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  stopTimeoutMs?: number;
  /** Called once the daemon has started (tests use it to obtain the handle). */
  onStarted?: (handle: DaemonHandle) => void;
}

const USAGE = `Usage
  $ agav job tick            Evaluate due background schedules once and exit
  $ agav job tick --install  Register an OS scheduler entry that runs \`agav job tick\` every minute
  $ agav job tick --uninstall  Remove the OS scheduler entry (state on disk is kept)
  $ agav job tick --status   Show the OS scheduler entry (exit 0 installed, 3 not installed)
  $ agav job daemon start    Run the background-jobs daemon in the foreground (ticks every 15s)
  $ agav job daemon stop     Stop the running daemon
  $ agav job daemon status   Show daemon status (exit 0 running, 3 not running)
  $ agav job abandon <full-id> --acknowledge-unverified  Release capacity without claiming stopped
  $ agav job help            Show this help
`;

export async function runJobCli(argv: string[], deps: JobCliDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((s: string) => { process.stdout.write(s); });
  const stderr = deps.stderr ?? ((s: string) => { process.stderr.write(s); });
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case "":
    case "help":
    case "--help":
    case "-h":
      stdout(USAGE);
      return 0;
    case "abandon":
      return runAbandonCommand(rest, deps, stdout, stderr);
    case "tick":
      return runTickCommand(rest, deps, stdout, stderr);
    case "daemon":
      return runDaemonCommand(rest, deps, stdout, stderr);
    default:
      stderr(`error: unknown job command: ${command}\n${USAGE}`);
      return 1;
  }
}

const DAEMON_USAGE = `Usage
  $ agav job daemon start    Run the daemon in the foreground until SIGINT/SIGTERM
  $ agav job daemon stop     Stop the running daemon (waits up to 10s)
  $ agav job daemon status   Exit 0 if running, 3 if not running or stale
`;

async function runDaemonCommand(
  args: string[],
  deps: JobCliDeps,
  stdout: (s: string) => void,
  stderr: (s: string) => void,
): Promise<number> {
  const [sub, ...extra] = args;
  if (sub === undefined) {
    stderr(`error: missing job daemon command\n${DAEMON_USAGE}`);
    return 1;
  }
  if (sub === "help" || sub === "--help" || sub === "-h") {
    stdout(DAEMON_USAGE);
    return 0;
  }
  if (extra.length > 0) {
    stderr(`error: unexpected argument for job daemon ${sub}: ${extra[0]}\n${DAEMON_USAGE}`);
    return 1;
  }
  const d = deps.daemon ?? {};
  const daemon = await import("../background-jobs/host/daemon.js");
  const resolveRoot = async (): Promise<string> =>
    d.root ?? (await import("../background-jobs/storage/paths.js")).resolveStorageRoot();

  switch (sub) {
    case "start":
      return runDaemonStart(deps, d, daemon, stdout, stderr);
    case "status": {
      const status = await daemon.getDaemonStatus(await resolveRoot(), { probes: d.probes });
      switch (status.state) {
        case "running": {
          const r = status.record;
          stdout(
            `running (pid ${r.pid}, since ${r.startedAt ?? r.acquiredAt ?? "unknown"}, version ${r.version ?? "unknown"})\n`,
          );
          return 0;
        }
        case "stale":
          stdout(`stale lock (owner dead, pid ${status.record.pid})\n`);
          return 3;
        case "unknown":
          stdout(`unknown (daemon lock unreadable: ${status.path})\n`);
          return 1;
        default:
          stdout("not running\n");
          return 3;
      }
    }
    case "stop": {
      const result = await daemon.stopDaemon({
        root: await resolveRoot(),
        ...(d.probes ? { probes: d.probes } : {}),
        ...(d.platform ? { platform: d.platform } : {}),
        ...(d.hostname ? { hostname: d.hostname } : {}),
        ...(d.kill ? { kill: d.kill } : {}),
        ...(d.net ? { net: d.net } : {}),
        ...(d.pipePath ? { pipePath: d.pipePath } : {}),
        ...(d.sleep ? { sleep: d.sleep } : {}),
        ...(d.now ? { now: d.now } : {}),
        ...(d.stopTimeoutMs !== undefined ? { timeoutMs: d.stopTimeoutMs } : {}),
      });
      switch (result.outcome) {
        case "stopped":
          stdout(`daemon stopped (pid ${result.pid})\n`);
          return 0;
        case "not-running":
          stdout("daemon not running\n");
          return 0;
        case "stale":
          stdout(`daemon not running (stale lock, owner pid ${result.pid} is dead)\n`);
          return 0;
        case "timeout":
          stderr(`error: daemon (pid ${result.pid}) did not stop within the timeout\n`);
          return 1;
        default:
          stderr(`error: ${result.reason}\n`);
          return 1;
      }
    }
    default:
      stderr(`error: unknown job daemon command: ${sub}\n${DAEMON_USAGE}`);
      return 1;
  }
}

async function runDaemonStart(
  deps: JobCliDeps,
  d: JobDaemonDeps,
  daemon: typeof import("../background-jobs/host/daemon.js"),
  stdout: (s: string) => void,
  stderr: (s: string) => void,
): Promise<number> {
  const loadConfig = deps.loadConfig ?? (async () => (await import("../config/config.js")).loadGlobalConfig());
  const integration = deps.getCoordinator && deps.reconcile && deps.runTick
    ? undefined
    : await import("../background-jobs-integration.js");
  const getCoordinator = deps.getCoordinator ?? integration!.getSharedCoordinator;
  const reconcile = deps.reconcile ?? integration!.reconcileOnStartup;
  const runTick = deps.runTick ?? integration!.runBackgroundTick;

  // Resolve the root without constructing the coordinator so the daemon lock is
  // taken before anything touches the store; a second `daemon start` fails fast.
  const root = d.root ?? (await (await import("../background-jobs/storage/paths.js")).resolveStorageRoot());
  const version = d.version ?? (await import("../version.js")).VERSION;

  // Runs once after the lock is held; ticks await it so none runs before reconcile completes.
  let readyPromise: Promise<Coordinator> | null = null;
  const ready = (): Promise<Coordinator> => {
    readyPromise ??= (async () => {
      const coordinator = await getCoordinator();
      try {
        await reconcile(coordinator);
      } catch {
        // Best effort, as in `job tick`.
      }
      return coordinator;
    })();
    return readyPromise;
  };

  let disabledNoticeShown = false;
  // Each tick re-reads config so enable/pause/permissionMode changes apply live.
  const tick = async (): Promise<void> => {
    let config: TickConfig;
    try {
      config = await loadConfig();
    } catch (err) {
      stderr(`error: failed to load config: ${err instanceof Error ? err.message : String(err)}\n`);
      return;
    }
    if (config.backgroundJobsEnabled !== true) {
      if (!disabledNoticeShown) {
        disabledNoticeShown = true;
        stdout("Background jobs are disabled (backgroundJobsEnabled=false); daemon will idle until enabled.\n");
      }
      return;
    }
    if (config.backgroundAutomation === "paused") return;
    const coordinator = await ready();
    const summary = await runTick({
      coordinator,
      session: { permissionMode: config.permissionMode ?? "ask", headlessApprovedActions: [] },
      backgroundAutomation: config.backgroundAutomation,
      ...workflowTickOptions(config),
    });
    if (summary.dispatched > 0 || summary.errors > 0) {
      stdout(`tick: dispatched=${summary.dispatched} skipped=${summary.skipped} errors=${summary.errors}\n`);
    }
    for (const message of summary.errorMessages) stderr(`error: ${message}\n`);
  };

  const result = await daemon.startDaemon({
    root,
    version,
    tick,
    ...(d.intervalMs !== undefined ? { intervalMs: d.intervalMs } : {}),
    ...(d.timers ? { timers: d.timers } : {}),
    ...(d.onSignal ? { onSignal: d.onSignal } : {}),
    ...(d.platform ? { platform: d.platform } : {}),
    ...(d.net ? { net: d.net } : {}),
    ...(d.pipePath ? { pipePath: d.pipePath } : {}),
    ...(d.probes ? { probes: d.probes } : {}),
    ...(d.hostname ? { hostname: d.hostname } : {}),
    ...(d.pid !== undefined ? { pid: d.pid } : {}),
    ...(d.readStartTime ? { readStartTime: d.readStartTime } : {}),
    log: (m) => stderr(`agav job daemon: ${m}\n`),
  });

  if (!result.started) {
    if (result.holder) stderr(`daemon already running (pid ${result.holder.pid})\n`);
    else stderr(`daemon lock is held but its owner can't be verified: ${daemon.daemonLockPath(root)}\n`);
    return 1;
  }

  stdout(`daemon started (pid ${result.handle.record.pid}), ticking every ${(d.intervalMs ?? daemon.DAEMON_TICK_INTERVAL_MS) / 1000}s\n`);
  try {
    await ready();
  } catch (err) {
    // Coordinator construction failed (reconcile errors are swallowed in ready()).
    stderr(`error: failed to open background-jobs store: ${err instanceof Error ? err.message : String(err)}\n`);
    await result.handle.stop();
    return 1;
  }
  d.onStarted?.(result.handle);
  await result.handle.stopped;
  stdout("daemon stopped\n");
  return 0;
}

async function runTickCommand(
  args: string[],
  deps: JobCliDeps,
  stdout: (s: string) => void,
  stderr: (s: string) => void,
): Promise<number> {
  const schedulerFlags = ["--install", "--uninstall", "--status"];
  let schedulerAction: string | undefined;
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      stdout(USAGE);
      return 0;
    }
    if (schedulerFlags.includes(arg)) {
      if (schedulerAction !== undefined && schedulerAction !== arg) {
        stderr(`error: ${schedulerAction} and ${arg} cannot be combined\n${USAGE}`);
        return 1;
      }
      schedulerAction = arg;
      continue;
    }
    stderr(`error: unknown argument for job tick: ${arg}\n${USAGE}`);
    return 1;
  }
  if (schedulerAction !== undefined) {
    return runTickSchedulerCommand(schedulerAction, deps.osScheduler ?? {}, stdout, stderr);
  }

  const loadConfig = deps.loadConfig ?? (async () => (await import("../config/config.js")).loadGlobalConfig());
  const config = await loadConfig();

  if (config.backgroundJobsEnabled !== true) {
    stdout("Background jobs are disabled (backgroundJobsEnabled=false); nothing to do.\n");
    return 0;
  }
  if (config.backgroundAutomation === "paused") {
    stdout("Background automation is paused (backgroundAutomation=paused); nothing to do.\n");
    return 0;
  }

  const integration = deps.getCoordinator && deps.reconcile && deps.runTick
    ? undefined
    : await import("../background-jobs-integration.js");
  const getCoordinator = deps.getCoordinator ?? integration!.getSharedCoordinator;
  const reconcile = deps.reconcile ?? integration!.reconcileOnStartup;
  const runTick = deps.runTick ?? integration!.runBackgroundTick;

  const coordinator = await getCoordinator();
  try {
    await reconcile(coordinator);
  } catch {
    // Best effort: a failed reconcile must not block schedule evaluation.
  }

  const session: SessionPolicySnapshot = {
    permissionMode: config.permissionMode ?? "ask",
    headlessApprovedActions: [],
  };
  const summary = await runTick({
    coordinator,
    session,
    backgroundAutomation: config.backgroundAutomation,
    ...workflowTickOptions(config),
  });

  stdout(`tick: dispatched=${summary.dispatched} skipped=${summary.skipped} errors=${summary.errors}\n`);
  for (const message of summary.errorMessages) stderr(`error: ${message}\n`);
  return summary.errors > 0 ? 1 : 0;
}

async function runTickSchedulerCommand(
  action: string,
  osDeps: OsSchedulerDeps,
  stdout: (s: string) => void,
  stderr: (s: string) => void,
): Promise<number> {
  const scheduler = await import("../background-jobs/host/os-scheduler/index.js");
  try {
    if (action === "--install") {
      const result = await scheduler.installScheduler(osDeps);
      stdout(`Background scheduler entry installed (${result.backend}): ${scheduler.formatTarget(result.target)}\n`);
      for (const file of result.files) stdout(`  wrote ${file}\n`);
      return 0;
    }
    if (action === "--uninstall") {
      const result = await scheduler.uninstallScheduler(osDeps);
      stdout(result.removed
        ? "Background scheduler entry removed (background-jobs state on disk was left alone).\n"
        : "Background scheduler entry not installed; nothing to remove.\n");
      return 0;
    }
    const status = await scheduler.getSchedulerStatus(osDeps);
    if (!status.installed) {
      stdout("Background scheduler entry: not installed\n");
      return 3;
    }
    stdout(`Background scheduler entry: installed (${status.backend}${status.location ? `, ${status.location}` : ""})\n`);
    stdout(`  command: ${status.target ? scheduler.formatTarget(status.target) : "unknown (entry could not be parsed)"}\n`);
    stdout(`  target executable: ${status.targetExists ? "exists" : "missing"}\n`);
    if (status.stale) stderr(`warning: ${scheduler.STALE_ENTRY_MESSAGE}\n`);
    return 0;
  } catch (err) {
    stderr(`error: job tick ${action} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function runAbandonCommand(
  args: string[], deps: JobCliDeps, stdout: (s: string) => void, stderr: (s: string) => void,
): Promise<number> {
  if (args.length !== 2 || args[1] !== "--acknowledge-unverified") {
    stderr("Usage: agav job abandon <full-id> --acknowledge-unverified\nReleases capacity and fences future startup; does NOT stop processes or verify outcome/descendants. Evidence is retained.\n");
    return 1;
  }
  try {
    const config = await (deps.loadConfig ?? (async () => (await import("../config/config.js")).loadGlobalConfig()))();
    if (config.backgroundJobsEnabled !== true) throw new Error("Background jobs are not enabled.");
    const coordinator = await (deps.getCoordinator ?? (await import("../background-jobs-integration.js")).getSharedCoordinator)();
    const summary = await coordinator.abandonJob(args[0]!, true, {
      permissionMode: config.permissionMode ?? "ask", headlessApprovedActions: [],
    });
    stdout(`Job ${summary.jobId} abandoned at ${summary.abandonment!.abandonedAt}.\nCapacity released; outcome and descendants remain unverified. No processes were stopped and no retry is authorized. Evidence/request tombstone retained.\n`);
    return 0;
  } catch (error) {
    stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
