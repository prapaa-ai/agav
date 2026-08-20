import { writeFile, readFile, readdir, stat } from "node:fs/promises";
import { renameSync, statSync } from "node:fs";
import { basename, dirname, join, parse as parsePath } from "node:path";
import { ensureDir } from "../utils/fs.js";

export interface PlanStep {
  id: number;
  title: string;
  description: string;
  status: "pending" | "in_progress" | "done" | "failed";
  verifyCommand?: string;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  createdAt: string;
  currentStep: number;
}

let cachedCwd: string | undefined;
let cachedPlanDir: string | undefined;

/**
 * A plan describes a project, not a directory, so it is anchored at the repo
 * root when there is one. Resolving from `process.cwd()` alone meant launching
 * agav from a subdirectory hid the plan that was created one level up.
 *
 * Synchronous because `planFilePath()`, `adoptPlanScope()`, and the callers
 * that build paths from it are all synchronous. The result is cached by cwd
 * so the filesystem walk only runs once per directory change.
 */
function planDir(): string {
  const cwd = process.cwd();
  if (cachedCwd === cwd && cachedPlanDir) return cachedPlanDir;

  let dir = cwd;
  const { root } = parsePath(cwd);
  let resolved = join(cwd, ".agav");
  while (true) {
    try {
      if (statSync(join(dir, ".git")).isDirectory()) {
        resolved = join(dir, ".agav");
        break;
      }
    } catch {
      // No .git here, keep walking up.
    }
    if (dir === root) break;
    dir = dirname(dir);
  }

  cachedCwd = cwd;
  cachedPlanDir = resolved;
  return resolved;
}

/** Force re-resolution on the next call (e.g. after `git init`). */
export function resetPlanDirCache(): void {
  cachedCwd = undefined;
  cachedPlanDir = undefined;
}

/**
 * A plan belongs to the session that created it, so each session gets its own
 * file. A session has no id until it is first written to history, so plans
 * created on the opening turn land under the draft key and are re-keyed by
 * `adoptPlanScope` once the real id exists.
 */
const DRAFT_SCOPE = "draft";
let planScope: string = DRAFT_SCOPE;

export function setPlanScope(sessionId?: string | null): void {
  planScope = sessionId || DRAFT_SCOPE;
  // Also invalidate the directory cache so the next operation resolves from
  // the current cwd — important when tests change directories between calls.
  cachedCwd = undefined;
  cachedPlanDir = undefined;
}

export function getPlanScope(): string {
  return planScope;
}

/**
 * Move the draft plan onto the session id the session was just assigned.
 *
 * Synchronous on purpose: the rename and the scope change must not be
 * separated by an await, or a concurrent read can land in the gap where the
 * draft file has moved but the scope still points at it.
 */
export function adoptPlanScope(sessionId: string): void {
  if (!sessionId || planScope === sessionId) return;
  if (planScope === DRAFT_SCOPE) {
    try {
      renameSync(planFile(DRAFT_SCOPE), planFile(sessionId));
    } catch {
      // No draft plan to carry over.
    }
  }
  setPlanScope(sessionId);
}

function plansDir(): string {
  return join(planDir(), "plans");
}

function planFile(scope: string = planScope): string {
  return join(plansDir(), `${scope}.json`);
}

export function planFilePath(): string {
  return planFile();
}

export async function savePlan(plan: Plan): Promise<string> {
  const file = planFile();
  await ensureDir(plansDir());
  await writeFile(file, JSON.stringify(plan, null, 2));
  return file;
}

export async function loadPlan(): Promise<Plan | null> {
  try {
    const raw = await readFile(planFile(), "utf-8");
    const parsed = JSON.parse(raw) as Plan;
    if (!parsed || !Array.isArray(parsed.steps)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** True when the plan still has work left — the test for "show this to the user". */
export function isPlanActive(plan: Plan | null): plan is Plan {
  return !!plan && plan.steps.some((s) => s.status !== "done" && s.status !== "failed");
}

export async function clearPlan(scope?: string): Promise<void> {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(planFile(scope ?? planScope));
  } catch {}
}

/**
 * One-time migration: the old single-file scheme stored plans at
 * `.agav/.plan-state.json`. Move it to the new per-session directory so
 * users upgrading with an active plan don't silently lose it.
 */
async function migrateOldPlanFile(): Promise<void> {
  const oldFile = join(planDir(), ".plan-state.json");
  try {
    const content = await readFile(oldFile, "utf-8");
    const plan = JSON.parse(content) as Plan;
    if (plan && Array.isArray(plan.steps) && plan.steps.length > 0) {
      const draftFile = planFile(DRAFT_SCOPE);
      // Only migrate if no draft already exists — don't overwrite a real plan.
      try { await stat(draftFile); } catch {
        await ensureDir(plansDir());
        await writeFile(draftFile, content);
      }
    }
    const { unlink } = await import("node:fs/promises");
    await unlink(oldFile);
  } catch {
    // No old file, or already migrated — nothing to do.
  }
}

/**
 * Make sure the plan directory exists. Deliberately does not create the state
 * file: an absent file is how `loadPlan` reports "no plan", and writing a
 * placeholder into a `.json` path only produced a file that failed to parse.
 */
export async function ensurePlanFile(): Promise<void> {
  await ensureDir(plansDir());
  await migrateOldPlanFile();
}

export interface StoredPlan {
  /** Session id that owns this plan, or "draft" for one not yet written to history. */
  scope: string;
  plan: Plan;
  updatedAt: Date;
}

/**
 * Every plan saved for this project, newest first. A plan outlives the session
 * that made it, so this is how you find one again after moving on.
 */
export async function listPlans(): Promise<StoredPlan[]> {
  let entries: string[];
  try {
    entries = await readdir(plansDir());
  } catch {
    return [];
  }

  const stored: StoredPlan[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = join(plansDir(), entry);
    try {
      const [raw, info] = await Promise.all([readFile(file, "utf-8"), stat(file)]);
      const plan = JSON.parse(raw) as Plan;
      if (!plan || !Array.isArray(plan.steps)) continue;
      stored.push({ scope: basename(entry, ".json"), plan, updatedAt: info.mtime });
    } catch {
      // Unreadable or corrupt plan files are simply not listed.
    }
  }
  return stored.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

const PLAN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Drop plans nobody has touched in a month. Completed plans delete themselves,
 * but abandoned ones would otherwise accumulate one file per session forever.
 */
export async function prunePlans(now: number = Date.now()): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  for (const { scope, updatedAt } of await listPlans()) {
    if (scope === planScope) continue;
    if (now - updatedAt.getTime() < PLAN_MAX_AGE_MS) continue;
    try {
      await unlink(planFile(scope));
    } catch {}
  }
}

export interface PlanStepUpdate {
  plan: Plan;
  step: PlanStep;
  doneCount: number;
  totalCount: number;
  allDone: boolean;
}

/**
 * Apply a status change to one step and move the plan cursor to the next piece
 * of outstanding work. Shared by the `update_plan` tool and the `/plan` command
 * so a hand-edited plan behaves exactly like a model-edited one.
 */
export async function updatePlanStep(
  stepNum: number,
  status: PlanStep["status"],
): Promise<PlanStepUpdate | { error: string }> {
  const plan = await loadPlan();
  if (!plan) return { error: "No active plan found." };

  const step = plan.steps.find((s) => s.id === stepNum);
  if (!step) return { error: `Step ${stepNum} not found. Plan has ${plan.steps.length} steps.` };

  step.status = status;

  const doneCount = plan.steps.filter((s) => s.status === "done").length;
  const totalCount = plan.steps.length;
  const allDone = doneCount === totalCount;
  plan.currentStep = allDone
    ? -1
    : plan.steps.findIndex((s) => s.status === "pending" || s.status === "in_progress");

  await savePlan(plan);
  return { plan, step, doneCount, totalCount, allDone };
}


export function formatPlanForPrompt(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`ACTIVE PLAN: ${plan.goal}`);
  lines.push("");
  for (const step of plan.steps) {
    const status = step.status === "done" ? "[DONE]"
      : step.status === "in_progress" ? "[IN PROGRESS]"
      : step.status === "failed" ? "[FAILED]"
      : "[PENDING]";
    lines.push(`  ${status} Step ${step.id}: ${step.title}`);
    lines.push(`    ${step.description}`);
    if (step.verifyCommand) {
      lines.push(`    Verify: ${step.verifyCommand}`);
    }
  }
  lines.push("");
  lines.push("INSTRUCTIONS:");
  lines.push("- Work on exactly ONE step per turn.");
  lines.push("- A step is NOT done until you have produced real output (written files, made changes, generated content). Analysis alone does not complete a step.");
  lines.push("- Mark the current step in_progress with update_plan before starting work.");
  lines.push("- Only mark a step done AFTER you have completed the actual work — not after merely reading or planning.");
  lines.push("- After marking a step done, end your response immediately. Do NOT announce that you are stopping.");
  lines.push("- Do NOT collapse or skip steps. Do NOT mark multiple steps done in one turn.");
  lines.push("- Do NOT modify the plan to reduce the number of steps.");
  lines.push("- If a step fails, mark it failed and move to the next.");
  return lines.join("\n");
}

export function shouldAutoPlan(input: string): boolean {
  const lower = input.toLowerCase();

  // Explicit opt-out
  if (/\b(no plan|don'?t plan|without a plan|skip plan|do not.*plan)\b/.test(lower)) {
    return false;
  }

  // Explicit opt-in
  if (/^plan[:\-\s]/i.test(lower)) {
    return true;
  }

  // Require at least 2 plan-suggestive signals to trigger
  let score = 0;

  const strongKeywords = [
    "refactor", "migrate", "redesign", "overhaul", "restructure",
    "rewrite", "scaffold", "bootstrap",
  ];
  const mediumKeywords = [
    "implement", "integrate", "convert", "add support for",
    "set up", "upgrade",
  ];

  if (strongKeywords.some((kw) => lower.includes(kw))) score += 2;
  if (mediumKeywords.some((kw) => lower.includes(kw))) score += 1;

  // Multi-step indicators
  if (/\b(step[s ]?\d|phase|then|after that|finally|first.*then)\b/.test(lower)) score += 1;

  // Long prompts with action verbs suggest multi-step work
  if (input.length > 200) score += 1;

  return score >= 2;
}
