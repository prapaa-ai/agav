#!/usr/bin/env node
// Launched detached as: node entry.js <jobId> <requestId> <root> <socketPath>
// Orchestration lives in lifecycle.ts.
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

  // The spec must be persisted before launch; a missing one is a caller bug.
  const spec = await repositories.specs.get(requestId);
  if (spec === undefined) {
    fatal(`no LaunchSpec found for requestId "${requestId}" under root "${root}".`);
  }

  // Routine SIGTERM/SIGINT are ignored (the job must outlive normal Agav exit); only an
  // authorized IPC stop request may stop the workload. SIGKILL can't be caught: that
  // case is left to reconciliation. The no-op handlers override Node's default exit.
  process.on("SIGTERM", () => {
    // ignored
  });
  process.on("SIGINT", () => {
    // ignored
  });

  const supervisor = new JobSupervisor({ jobId, requestId, repositories, root, socketPath });

  // The open IPC socket and the workload handle keep the event loop alive; no keep-alive timer.
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
