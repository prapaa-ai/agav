/**
 * V-10 — real multi-process schedule race.
 *
 * Forks 4 `node --import tsx` children, each building its own schedule engine
 * over the SAME temp storage root and evaluating one schedule due at a fixed
 * instant. Children start the evaluation together (stdin "go" barrier). The
 * recorder coordinator in each child appends a line per start() to a shared
 * marker file and never launches a supervisor. Exactly one dispatch must
 * happen across all processes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_RESOURCE_LIMITS, type CoordinatorClient, type SessionPolicySnapshot } from "../types.js";
import { createFileRepositories } from "../storage/repositories.js";
import { createAuthorizationService } from "../authorization/service.js";
import { createScheduleEngine } from "../schedule/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const fixture = join(here, "fixtures", "multiprocess-evaluate.ts");
const tsxAvailable = existsSync(join(repoRoot, "node_modules", "tsx", "package.json"));

const CHILDREN = 4;
const CRON = "0 3 * * *";
const DUE = new Date("2024-03-10T03:00:00Z");
const autoAcceptSession: SessionPolicySnapshot = { permissionMode: "auto-accept", headlessApprovedActions: [] };

interface ChildRun {
  child: ChildProcess;
  ready: Promise<void>;
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

function forkChild(root: string, marker: string): ChildRun {
  const child = spawn(process.execPath, ["--import", "tsx", fixture, root, marker, DUE.toISOString()], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  let stdout = "";
  let stderr = "";
  let markReady: () => void = () => {};
  let failReady: (e: Error) => void = () => {};
  const ready = new Promise<void>((res, rej) => {
    markReady = res;
    failReady = rej;
  });
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.includes("ready\n")) markReady();
  });
  child.stderr!.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((res) => {
    child.on("close", (code) => {
      failReady(new Error(`child exited before ready (code ${code}): ${stderr}`));
      res({ code, stdout, stderr });
    });
  });
  return { child, ready, done };
}

describe.skipIf(!tsxAvailable)("multi-process schedule race (V-10)", () => {
  let root: string;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agav-host-multiprocess-"));
  });

  afterEach(async () => {
    for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });

  it(
    `${CHILDREN} processes evaluating the same due occurrence dispatch exactly once`,
    async () => {
      const repositories = createFileRepositories(root);
      const neverStart = {
        async start(): Promise<never> {
          throw new Error("parent engine must not dispatch");
        },
      };
      const engine = createScheduleEngine({
        repositories,
        coordinator: neverStart as unknown as CoordinatorClient,
        authorizationService: createAuthorizationService(root),
        root,
      });
      const schedule = await engine.createSchedule({
        cron: CRON,
        timezone: "UTC",
        launchSpecTemplate: {
          invocation: { mode: "direct", executable: "/bin/echo", args: ["hi"] },
          cwd: "/tmp",
          env: {},
          credentialRefs: [],
          isolation: { backend: "none", required: false },
          ownershipScope: "process-group",
          limits: DEFAULT_RESOURCE_LIMITS,
          headless: false,
        },
        session: autoAcceptSession,
      });

      const marker = join(root, "dispatch-marker.log");
      const runs = Array.from({ length: CHILDREN }, () => forkChild(root, marker));
      children.push(...runs.map((r) => r.child));

      await Promise.all(runs.map((r) => r.ready));
      for (const r of runs) r.child.stdin!.end("go\n");
      const exits = await Promise.all(runs.map((r) => r.done));

      for (const e of exits) expect(e.code, e.stderr).toBe(0);

      const outcomes = exits.flatMap((e) => {
        const line = e.stdout.split("\n").find((l) => l.startsWith("result "));
        expect(line, e.stdout + e.stderr).toBeDefined();
        const results = JSON.parse(line!.slice("result ".length)) as Array<{ scheduleId: string; outcome: string }>;
        return results.filter((r) => r.scheduleId === schedule.scheduleId).map((r) => r.outcome);
      });
      expect(outcomes).toHaveLength(CHILDREN);
      expect(outcomes.filter((o) => o === "dispatched")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "skipped-overlap")).toHaveLength(CHILDREN - 1);

      const lines = (await readFile(marker, "utf8")).split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);

      const occurrences = await repositories.occurrences.listForSchedule(schedule.scheduleId);
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0]?.status).toBe("dispatched");
      expect(lines[0]!.split(" ")[1]).toBe(occurrences[0]?.requestId);
    },
    120_000,
  );
});
