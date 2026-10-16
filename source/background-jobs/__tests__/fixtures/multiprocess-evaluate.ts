/**
 * Child-process fixture for host.multiprocess.test.ts (V-10).
 *
 * argv: <storageRoot> <markerFile> <nowIso>
 *
 * Builds its own repositories / authorization service / schedule engine over
 * the shared storage root, with a recorder coordinator that appends one line
 * per start() call to <markerFile> (never launches a supervisor). Prints
 * "ready" once set up, waits for "go" on stdin (a barrier so all children
 * race the same evaluation), runs one evaluateOnce, and prints the results as
 * a single JSON line prefixed with "result ".
 */
import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import type { CoordinatorClient, JobSummary, SessionPolicySnapshot, StartJobRequest } from "../../types.js";
import { createFileRepositories } from "../../storage/repositories.js";
import { createAuthorizationService } from "../../authorization/service.js";
import { createScheduleEngine } from "../../schedule/engine.js";

const [root, markerFile, nowIso] = process.argv.slice(2);
if (!root || !markerFile || !nowIso) {
  process.stderr.write("usage: multiprocess-evaluate <root> <markerFile> <nowIso>\n");
  process.exit(2);
}

const autoAcceptSession: SessionPolicySnapshot = { permissionMode: "auto-accept", headlessApprovedActions: [] };

const recorder = {
  async start(request: StartJobRequest, _session: SessionPolicySnapshot): Promise<JobSummary> {
    // Small O_APPEND write: atomic per line across processes.
    await appendFile(markerFile, `${process.pid} ${request.requestId}\n`, "utf8");
    // Widen the window between reserve and the occurrence status update.
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 21)));
    return { jobId: randomUUID(), requestId: request.requestId, state: "running", stopState: "none" };
  },
};

const repositories = createFileRepositories(root);
const engine = createScheduleEngine({
  repositories,
  coordinator: recorder as unknown as CoordinatorClient,
  authorizationService: createAuthorizationService(root),
  root,
});

function waitForGo(): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.includes("go")) {
        process.stdin.pause();
        resolve();
      }
    });
    process.stdin.on("end", () => reject(new Error("stdin closed before go")));
  });
}

async function main(): Promise<void> {
  process.stdout.write("ready\n");
  await waitForGo();
  const results = await engine.evaluateOnce({ nowUtc: new Date(nowIso!), connectedSessions: [autoAcceptSession] });
  process.stdout.write(`result ${JSON.stringify(results)}\n`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`fixture error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
