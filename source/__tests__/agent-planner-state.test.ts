import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  savePlan,
  loadPlan,
  clearPlan,
  ensurePlanFile,
  isPlanActive,
  updatePlanStep,
  planFilePath,
  setPlanScope,
  getPlanScope,
  adoptPlanScope,
  listPlans,
  prunePlans,
  type Plan,
} from "../agent/planner.js";

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    goal: "Ship the feature",
    createdAt: "2026-01-01T00:00:00.000Z",
    currentStep: 0,
    steps: [
      { id: 1, title: "Design", description: "Sketch it", status: "pending" },
      { id: 2, title: "Build", description: "Write it", status: "pending" },
    ],
    ...overrides,
  };
}

describe("plan state", () => {
  let originalCwd: string;
  let root: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    // Resolve symlinks (macOS maps /var to /private/var) so the paths the
    // planner derives from process.cwd() compare equal to the ones built here.
    root = await realpath(await mkdtemp(join(tmpdir(), "agav-plan-state-")));
    await mkdir(join(root, ".git"));
    process.chdir(root);
    setPlanScope(null);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips a plan through disk", async () => {
    const plan = makePlan();
    await savePlan(plan);
    expect(await loadPlan()).toEqual(plan);
  });

  it("survives a simulated restart", async () => {
    await savePlan(makePlan());
    // A fresh process would call ensurePlanFile before reading.
    await ensurePlanFile();
    expect((await loadPlan())?.goal).toBe("Ship the feature");
  });

  it("ensurePlanFile creates the directory but no unparseable state file", async () => {
    await ensurePlanFile();
    expect(await readdir(join(root, ".agav", "plans"))).toEqual([]);
    expect(await loadPlan()).toBeNull();
  });

  it("resolves the plan file from the repo root, not the launch directory", async () => {
    await mkdir(join(root, ".git"), { recursive: true });
    await savePlan(makePlan());

    const nested = join(root, "packages", "api");
    await mkdir(nested, { recursive: true });
    process.chdir(nested);

    expect(planFilePath()).toBe(join(root, ".agav", "plans", "draft.json"));
    expect((await loadPlan())?.goal).toBe("Ship the feature");
  });

  it("treats a corrupt state file as no plan", async () => {
    await ensurePlanFile();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(planFilePath(), "# Plan\n\nNot JSON at all.\n");
    expect(await loadPlan()).toBeNull();
  });

  it("reports a plan as active only while work remains", () => {
    expect(isPlanActive(null)).toBe(false);
    expect(isPlanActive(makePlan())).toBe(true);
    expect(
      isPlanActive(
        makePlan({
          steps: [
            { id: 1, title: "a", description: "a", status: "done" },
            { id: 2, title: "b", description: "b", status: "failed" },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("updatePlanStep persists the status and advances the cursor", async () => {
    await savePlan(makePlan());

    const first = await updatePlanStep(1, "done");
    expect("error" in first).toBe(false);
    expect(await readFile(planFilePath(), "utf-8")).toContain('"done"');
    expect((await loadPlan())?.currentStep).toBe(1);

    const second = await updatePlanStep(2, "done");
    expect(second).toMatchObject({ allDone: true, doneCount: 2, totalCount: 2 });
    expect((await loadPlan())?.currentStep).toBe(-1);
  });

  it("updatePlanStep reports missing plans and steps", async () => {
    expect(await updatePlanStep(1, "done")).toEqual({ error: "No active plan found." });
    await savePlan(makePlan());
    expect(await updatePlanStep(9, "done")).toEqual({
      error: "Step 9 not found. Plan has 2 steps.",
    });
  });

  it("clearPlan removes the state file", async () => {
    await savePlan(makePlan());
    await clearPlan();
    expect(await loadPlan()).toBeNull();
    await expect(clearPlan()).resolves.toBeUndefined();
  });

  it("keeps each session's plan separate", async () => {
    setPlanScope("session-a");
    await savePlan(makePlan({ goal: "Plan A" }));

    setPlanScope("session-b");
    expect(await loadPlan()).toBeNull();
    await savePlan(makePlan({ goal: "Plan B" }));

    // Switching back shows A again, and B was not overwritten.
    setPlanScope("session-a");
    expect((await loadPlan())?.goal).toBe("Plan A");
    setPlanScope("session-b");
    expect((await loadPlan())?.goal).toBe("Plan B");
  });

  it("clearing one session's plan leaves the others alone", async () => {
    setPlanScope("session-a");
    await savePlan(makePlan({ goal: "Plan A" }));
    setPlanScope("session-b");
    await savePlan(makePlan({ goal: "Plan B" }));

    await clearPlan();
    expect(await loadPlan()).toBeNull();
    setPlanScope("session-a");
    expect((await loadPlan())?.goal).toBe("Plan A");
  });

  it("adopts a draft plan onto the session id once one is assigned", async () => {
    await savePlan(makePlan({ goal: "Drafted" }));
    expect(getPlanScope()).toBe("draft");

    adoptPlanScope("session-a");

    expect(getPlanScope()).toBe("session-a");
    expect((await loadPlan())?.goal).toBe("Drafted");
    expect(await readdir(join(root, ".agav", "plans"))).toEqual(["session-a.json"]);
  });

  it("adoption never steals a plan from an established session", async () => {
    setPlanScope("session-a");
    await savePlan(makePlan({ goal: "Plan A" }));

    adoptPlanScope("session-b");

    expect(getPlanScope()).toBe("session-b");
    expect(await loadPlan()).toBeNull();
    setPlanScope("session-a");
    expect((await loadPlan())?.goal).toBe("Plan A");
  });

  it("lists every saved plan, newest first", async () => {
    setPlanScope("session-a");
    await savePlan(makePlan({ goal: "Plan A" }));
    setPlanScope("session-b");
    await savePlan(makePlan({ goal: "Plan B" }));

    const listed = await listPlans();
    expect(listed.map((p) => p.scope).sort()).toEqual(["session-a", "session-b"]);
    expect(listed[0]!.updatedAt.getTime()).toBeGreaterThanOrEqual(listed[1]!.updatedAt.getTime());
  });

  it("listPlans skips corrupt files and returns empty when there are none", async () => {
    expect(await listPlans()).toEqual([]);
    await ensurePlanFile();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, ".agav", "plans", "broken.json"), "{oops");
    expect(await listPlans()).toEqual([]);
  });

  it("prunes stale plans but never the current session's", async () => {
    setPlanScope("session-old");
    await savePlan(makePlan({ goal: "Ancient" }));
    setPlanScope("session-now");
    await savePlan(makePlan({ goal: "Current" }));

    // Pretend we are two months on; only the other session's plan should go.
    await prunePlans(Date.now() + 60 * 24 * 60 * 60 * 1000);

    expect((await listPlans()).map((p) => p.scope)).toEqual(["session-now"]);
  });
});
