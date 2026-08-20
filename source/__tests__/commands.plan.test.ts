import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planCommand } from "../commands/plan.js";
import type { CommandContext } from "../commands/types.js";
import { savePlan, loadPlan, setPlanScope, type Plan } from "../agent/planner.js";

const createContext = (): CommandContext => ({
  conversation: {} as any,
  config: {} as any,
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
});

function makePlan(): Plan {
  return {
    goal: "Ship the feature",
    createdAt: "2026-01-01T00:00:00.000Z",
    currentStep: 0,
    steps: [
      { id: 1, title: "Design", description: "Sketch it", status: "pending" },
      { id: 2, title: "Build", description: "Write it", status: "pending" },
    ],
  };
}

describe("commands/plan", () => {
  let originalCwd: string;
  let root: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    root = await realpath(await mkdtemp(join(tmpdir(), "agav-plan-cmd-")));
    process.chdir(root);
    setPlanScope(null);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });

  // The plan panel renders from hook state, so deleting the file is only half
  // the job — without the refresh the cleared plan stays on screen.
  it("refreshes the panel after clearing the plan", async () => {
    await savePlan(makePlan());
    const context = createContext();

    const result = await planCommand.execute("clear", context);

    expect(result).toEqual({ type: "message", text: "Plan cleared." });
    expect(await loadPlan()).toBeNull();
    expect(context.refreshPlan).toHaveBeenCalledTimes(1);
  });

  it("refreshes the panel after a step status change", async () => {
    await savePlan(makePlan());
    const context = createContext();

    const result = await planCommand.execute("1 done", context);

    expect(result).toMatchObject({ text: expect.stringContaining("1/2 steps done") });
    expect((await loadPlan())?.steps[0]?.status).toBe("done");
    expect(context.refreshPlan).toHaveBeenCalledTimes(1);
  });

  it("leaves the panel alone for read-only actions", async () => {
    await savePlan(makePlan());
    const context = createContext();

    await planCommand.execute("", context);
    await planCommand.execute("list", context);

    expect(context.refreshPlan).not.toHaveBeenCalled();
  });

  it("does not refresh when the step update fails", async () => {
    await savePlan(makePlan());
    const context = createContext();

    const result = await planCommand.execute("9 done", context);

    expect(result).toEqual({ type: "message", text: "Step 9 not found. Plan has 2 steps." });
    expect(context.refreshPlan).not.toHaveBeenCalled();
  });
});
