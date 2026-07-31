import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getAgavDir } from "../config/config.js";
import type { SkillDefinition } from "./types.js";

interface SkillTrace {
  timestamp: string;
  query: string;
  tokensUsed: number;
  success?: boolean;
}

interface TriggerPhrases {
  positive: string[];
  negative: string[];
  filePatterns: string[];
  generatedAt: string;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function getSkillMetaDir(skillName: string): string {
  return join(getAgavDir(), "skills", slugify(skillName), ".agav");
}

function getTracePath(skillName: string): string {
  return join(getSkillMetaDir(skillName), "traces.jsonl");
}

function getTriggersPath(skillName: string): string {
  return join(getSkillMetaDir(skillName), "triggers.json");
}

function getRuntimePromptPath(skillName: string): string {
  return join(getSkillMetaDir(skillName), "runtime.md");
}

function getOptimizationNotesPath(skillName: string): string {
  return join(getSkillMetaDir(skillName), "optimization-notes.md");
}

export async function recordSkillTrace(
  skillName: string,
  query: string,
  tokensUsed: number,
  success = true,
): Promise<void> {
  const dir = getSkillMetaDir(skillName);
  await mkdir(dir, { recursive: true });
  const entry: SkillTrace = {
    timestamp: new Date().toISOString(),
    query: query.slice(0, 200),
    tokensUsed,
    success,
  };
  await appendFile(getTracePath(skillName), JSON.stringify(entry) + "\n");
}

export async function getSkillTraces(skillName: string): Promise<SkillTrace[]> {
  try {
    const raw = await readFile(getTracePath(skillName), "utf-8");
    return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as SkillTrace);
  } catch {
    return [];
  }
}

export function buildTriggerPhrases(skill: SkillDefinition): TriggerPhrases {
  const name = skill.name.toLowerCase();
  const desc = skill.description.toLowerCase();
  const tags = (skill.frontmatter.tags ?? []).map((t) => t.toLowerCase());
  const words = [...name.split("-"), ...desc.split(/\s+/).filter((w) => w.length > 3)];

  const positive = [...new Set([
    ...name.split("-"),
    ...tags,
    ...words.filter((w) => !["this", "that", "with", "from", "code", "for", "the", "and"].includes(w)),
  ])].slice(0, 15);

  const negative: string[] = [];
  if (!desc.includes("test")) negative.push("test");
  if (!desc.includes("debug")) negative.push("debug");
  if (!desc.includes("deploy")) negative.push("deploy");

  const filePatterns: string[] = [];
  if (desc.includes("test")) filePatterns.push("*.test.*", "*.spec.*");
  if (desc.includes("document")) filePatterns.push("*.md", "README*");

  return { positive, negative, filePatterns, generatedAt: new Date().toISOString() };
}

export async function ensureTriggerPhrases(skill: SkillDefinition): Promise<TriggerPhrases> {
  const path = getTriggersPath(skill.name);
  try {
    const existing = JSON.parse(await readFile(path, "utf-8")) as TriggerPhrases;
    if (existing.positive?.length) return existing;
  } catch {}

  const triggers = buildTriggerPhrases(skill);
  const dir = getSkillMetaDir(skill.name);
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(triggers, null, 2));
  return triggers;
}

export function skillTriggerScore(triggers: TriggerPhrases, query: string): number {
  const lower = query.toLowerCase();
  let score = 0;

  for (const phrase of triggers.positive) {
    if (lower.includes(phrase)) {
      score += phrase.includes(" ") ? 0.22 : 0.08;
    }
  }

  for (const phrase of triggers.negative) {
    if (lower.includes(phrase)) {
      score -= 0.15;
    }
  }

  return Math.max(0, Math.min(1, score));
}

export function buildRuntimePrompt(skill: SkillDefinition): string {
  const triggers = buildTriggerPhrases(skill);
  const lines = [
    `# ${skill.name}`,
    "",
    `**Purpose:** ${skill.description}`,
    "",
    "**Trigger when the user mentions:** " + triggers.positive.slice(0, 8).join(", "),
    "",
    "**Do NOT trigger for:** " + (triggers.negative.length > 0 ? triggers.negative.join(", ") : "unrelated topics"),
    "",
    "**Execution rules:**",
    "- Focus exclusively on the skill's task",
    "- Be thorough but concise",
    "- Use only the allowed tools",
    skill.frontmatter["allowed-tools"]
      ? "- Allowed tools: " + skill.frontmatter["allowed-tools"].join(", ")
      : "- All tools available",
    "",
    "**Instructions:**",
    skill.body.slice(0, 2000),
  ];
  return lines.join("\n");
}

export async function ensureRuntimePrompt(skill: SkillDefinition): Promise<string> {
  const path = getRuntimePromptPath(skill.name);
  try {
    const existing = await readFile(path, "utf-8");
    if (existing.trim().length > 0) return existing;
  } catch {}

  const prompt = buildRuntimePrompt(skill);
  const dir = getSkillMetaDir(skill.name);
  await mkdir(dir, { recursive: true });
  await writeFile(path, prompt);
  return prompt;
}

export async function writeOptimizationNotes(skill: SkillDefinition): Promise<void> {
  const traces = await getSkillTraces(skill.name);
  if (traces.length < 3) return;

  const totalTokens = traces.reduce((sum, t) => sum + t.tokensUsed, 0);
  const avgTokens = Math.round(totalTokens / traces.length);
  const successRate = traces.filter((t) => t.success !== false).length / traces.length;
  const recentQueries = traces.slice(-5).map((t) => t.query);

  const notes = [
    `# Optimization Notes for ${skill.name}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Usage Stats",
    `- Total invocations: ${traces.length}`,
    `- Average tokens per run: ${avgTokens}`,
    `- Success rate: ${Math.round(successRate * 100)}%`,
    "",
    "## Recent Queries",
    ...recentQueries.map((q) => `- ${q}`),
    "",
    "## Suggestions",
    avgTokens > 10000 ? "- Consider tightening the skill instructions to reduce token usage" : "- Token usage is reasonable",
    successRate < 0.8 ? "- Low success rate — review the skill instructions for clarity" : "- Success rate is good",
    traces.length > 20 ? "- High usage — this skill is working well, consider adding to project defaults" : "",
  ].filter(Boolean);

  const dir = getSkillMetaDir(skill.name);
  await mkdir(dir, { recursive: true });
  await writeFile(getOptimizationNotesPath(skill.name), notes.join("\n"));
}

let lastImprovementTurn = 0;
const IMPROVEMENT_INTERVAL = 15;

export async function maybeRunBackgroundImprovement(
  turnCount: number,
  skills: SkillDefinition[],
  onLog?: (message: string) => void,
): Promise<void> {
  if (turnCount - lastImprovementTurn < IMPROVEMENT_INTERVAL) return;
  lastImprovementTurn = turnCount;

  setTimeout(async () => {
    let updated = 0;
    for (const skill of skills) {
      try {
        await ensureTriggerPhrases(skill);
        await ensureRuntimePrompt(skill);
        await writeOptimizationNotes(skill);
        updated++;
      } catch {}
    }
    if (updated > 0) {
      onLog?.(`\x1b[2mSkill improvement: updated ${updated} skill(s)\x1b[0m`);
    }
  }, 100);
}
