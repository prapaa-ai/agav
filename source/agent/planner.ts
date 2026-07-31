import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
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

const PLAN_DIR = join(process.cwd(), ".agav");
const PLAN_FILE = join(PLAN_DIR, ".plan-state.json");

export async function savePlan(plan: Plan): Promise<string> {
  await ensureDir(PLAN_DIR);
  await writeFile(PLAN_FILE, JSON.stringify(plan, null, 2));
  return PLAN_FILE;
}

export async function loadPlan(): Promise<Plan | null> {
  try {
    const raw = await readFile(PLAN_FILE, "utf-8");
    return JSON.parse(raw) as Plan;
  } catch {
    return null;
  }
}

export async function clearPlan(): Promise<void> {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(PLAN_FILE);
  } catch {}
}

export async function ensurePlanFile(): Promise<void> {
  await ensureDir(PLAN_DIR);
  try {
    await readFile(PLAN_FILE, "utf-8");
  } catch {
    await writeFile(PLAN_FILE, "# Plan\n\nNo active plan. Use `plan:` prefix or a complex prompt to create one.\n");
  }
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
