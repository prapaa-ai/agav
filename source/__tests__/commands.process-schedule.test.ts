/**
 * T16 — Tests for the `/process schedule` sub-command
 * (`schedule list` / `schedule create` / `schedule revoke`).
 *
 * Same real-coordinator approach as `commands.process.test.ts`: import the
 * coordinator from compiled `build/` output so the real schedule engine
 * (built on top of it) is exercised for real. Run `npx tsc -p tsconfig.json`
 * first.
 *
 * Note: creating a schedule in this delivery never dispatches a job (no
 * evaluation timer exists yet), so there is no `startedJobIds` array or
 * supervisor-process cleanup loop needed here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandContext } from "../commands/types.js";

const { processCommand } = await import("../commands/process.js");
const { __setSharedCoordinatorForTests } = await import("../background-jobs-integration.js");

async function importBuiltCoordinatorModule(): Promise<typeof import("../background-jobs/coordinator/service.js")> {
  const url = new URL("../../build/background-jobs/coordinator/service.js", import.meta.url).href;
  return import(/* @vite-ignore */ url);
}

function createContext(configOverrides: Record<string, unknown> = {}): CommandContext {
  return {
    conversation: {} as any,
    config: { permissionMode: "auto-accept", backgroundJobsEnabled: true, ...configOverrides } as any,
    setModel: vi.fn(),
    setProvider: vi.fn(),
    setEffort: vi.fn(),
    clearMessages: vi.fn(),
    refreshPlan: vi.fn(),
    showStatus: vi.fn(),
    saveSession: vi.fn(),
    refreshDisplay: vi.fn(),
    loadSession: vi.fn(),
    activateSession: vi.fn(),
    renameSession: vi.fn(),
    exit: vi.fn(),
    getDebugState: vi.fn(),
    submit: vi.fn(),
    handleSubmit: vi.fn(),
    toolRegistry: {} as any,
    addTokenUsage: vi.fn(),
    setRunningSkill: vi.fn(),
    setPickerActive: vi.fn(),
    suspendTerminal: vi.fn(() => vi.fn()),
    showAgentsTUI: vi.fn(),
    showSkillsTUI: vi.fn(),
  };
}

function messageText(result: Awaited<ReturnType<typeof processCommand.execute>>): string {
  expect(result.type).toBe("message");
  return result.type === "message" ? result.text : "";
}

let root: string;
let coordinator: Awaited<ReturnType<typeof import("../background-jobs/coordinator/service.js").createCoordinator>>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-bg-cmd-schedule-test-"));
  const { createCoordinator } = await importBuiltCoordinatorModule();
  coordinator = await createCoordinator({ root });
  __setSharedCoordinatorForTests(coordinator as any);
});

afterEach(async () => {
  __setSharedCoordinatorForTests(null);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}, 20000);

describe("/process schedule — opt-in gate", () => {
  it("blocks when backgroundJobsEnabled is false", async () => {
    const context = createContext({ backgroundJobsEnabled: false });
    const result = await processCommand.execute("schedule list", context);
    expect(messageText(result)).toContain("not enabled");
  });
});

describe("/process schedule list", () => {
  it("reports plainly when there are no schedules", async () => {
    const result = await processCommand.execute("schedule list", createContext());
    expect(messageText(result)).toBe("No schedules found.");
  });

  it("defaults to list when no sub-action is given after 'schedule'", async () => {
    const result = await processCommand.execute("schedule", createContext());
    expect(messageText(result)).toBe("No schedules found.");
  });
});

describe("/process schedule create", () => {
  it("creates a schedule from a quoted cron, timezone, and command", async () => {
    const result = await processCommand.execute('schedule create "0 9 * * *" UTC echo hello-scheduled', createContext());
    expect(messageText(result)).toContain("Created schedule");

    const listResult = await processCommand.execute("schedule list", createContext());
    expect(messageText(listResult)).toContain('cron: "0 9 * * *"');
    expect(messageText(listResult)).toContain("timezone: UTC");
  });

  it("shows usage when the arguments are malformed", async () => {
    const result = await processCommand.execute("schedule create not-quoted-cron", createContext());
    expect(messageText(result)).toContain("Usage: /process schedule create");
  });
});

describe("/process schedule revoke", () => {
  it("revokes an existing schedule by exact id", async () => {
    const createResult = await processCommand.execute('schedule create "0 9 * * *" UTC echo hi', createContext());
    const idMatch = /Created schedule (\S+) /.exec(messageText(createResult));
    expect(idMatch).not.toBeNull();
    const scheduleId = idMatch![1]!;

    const revokeResult = await processCommand.execute(`schedule revoke ${scheduleId}`, createContext());
    expect(messageText(revokeResult)).toContain("Revoked schedule");

    const listResult = await processCommand.execute("schedule list", createContext());
    expect(messageText(listResult)).toContain("[disabled]");
  });

  it("returns a clear message for an unknown scheduleId", async () => {
    const result = await processCommand.execute("schedule revoke does-not-exist", createContext());
    expect(messageText(result)).toContain("No schedule found");
  });

  it("shows usage when scheduleId is missing", async () => {
    const result = await processCommand.execute("schedule revoke", createContext());
    expect(messageText(result)).toContain("Usage: /process schedule revoke");
  });
});
