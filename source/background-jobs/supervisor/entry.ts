#!/usr/bin/env node
/**
 * T11 — Supervisor process entry point.
 *
 * Invoked by `PlatformAdapter.launchDetachedSupervisor` (see
 * `platform/linux.ts#launchDetachedSupervisor` and
 * `packaging/locator.ts#resolveSupervisorEntryPath`) as:
 *
 *   node <compiled-entry.js> <jobId> <requestId> <root> <socketPath>
 *
 * This file intentionally does the bare minimum: parse argv, construct
 * storage, load the already-persisted `LaunchSpec`, and hand off to
 * `JobSupervisor`. All orchestration logic lives in `lifecycle.ts` so it can
 * be unit tested without going through a real detached process.
 *
 * IMPORTANT — signal handling: per solution.md "Remove termination on
 * normal Agav exit; it contradicts the feature's durable lifetime", this
 * process intentionally ignores routine termination signals aimed at
 * itself (SIGTERM/SIGINT). Only an explicit, authorized stop request
 * delivered over IPC (`{type: 'stop'}`) is allowed to stop the owned
 * workload. SIGKILL still terminates this process (it cannot be caught),
 * which is an accepted, documented limitation — a future reconciliation
 * pass (T12) is what detects and recovers from that case, not this file.
 */
import { createFileRepositories } from "../storage/repositories.js";
import { JobSupervisor } from "./lifecycle.js";

function fatal(message: string): never {
  process.stderr.write(`[background-jobs supervisor] fatal: ${message}\n`);
  process.exit(1);
}

export async function runSupervisor(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [jobId, requestId, root, socketPath] = argv;

  if (!jobId || !requestId || !root || !socketPath) {
    fatal(
      "usage: entry.js <jobId> <requestId> <root> <socketPath> " +
        `(received: ${JSON.stringify(argv)})`,
    );
  }

  const repositories = createFileRepositories(root);

  // The spec must already be persisted before the supervisor starts
  // (solution.md §6: "Launch first reserves capacity and persists an
  // authorized intent; then starts the pinned supervisor"). A missing spec
  // here is a genuine caller bug, not a recoverable supervisor state.
  const spec = await repositories.specs.get(requestId);
  if (spec === undefined) {
    fatal(`no LaunchSpec found for requestId "${requestId}" under root "${root}".`);
  }

  // Routine signals aimed at this process must never stop the owned
  // workload or exit this process early — see module doc above. We
  // deliberately install handlers that do nothing (rather than leaving no
  // handler at all) so the default Node behavior of exiting on SIGINT/SIGTERM
  // is explicitly overridden, not merely absent.
  process.on("SIGTERM", () => {
    // Intentionally ignored: only an authorized IPC stop request may stop
    // the owned workload. See module-level doc.
  });
  process.on("SIGINT", () => {
    // Intentionally ignored: see SIGTERM handler above.
  });

  const supervisor = new JobSupervisor({ jobId, requestId, repositories, root, socketPath });

  // Once started, this process keeps running indefinitely: the open
  // IpcServer socket and (while running) the workload's child process
  // handle both keep the event loop alive naturally, so no explicit
  // keep-alive timer is needed here. If future testing on a given platform
  // shows otherwise, a documented `setInterval` keep-alive should be added
  // at this point.
  await supervisor.start(spec);
}

// Importing this bundled entry must not consume the CLI argv or auto-start it.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { isStandaloneBinary } from "../packaging/manifest.js";
if (!isStandaloneBinary() && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSupervisor().catch((error: unknown) => {
    fatal(error instanceof Error ? (error.stack ?? error.message) : String(error));
  });
}
