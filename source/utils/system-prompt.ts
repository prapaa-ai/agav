import { getGitContext, formatGitPrompt } from "./git.js";
import { loadProjectInstructions } from "./project-instructions.js";
import { formatMemoriesForPrompt } from "../config/memory.js";
import type { MCPManager } from "../mcp/manager.js";
import { getCachedSkills, buildSkillCatalog, loadSkills } from "../skills/loader.js";
import { formatSteersForPrompt } from "../commands/steer.js";
import type { AgentDefinition } from "../agents/types.js";

/**
 * Returns true if the user's message suggests they may want to delegate to a
 * specialized agent. Used to gate agent catalog injection and tool registration
 * so they don't add tokens/tools on every unrelated turn.
 */
export function shouldIncludeAgentCatalog(userMessage: string, agents: AgentDefinition[]): boolean {
  if (agents.length === 0) return false;
  const msg = userMessage.toLowerCase();
  // Always include if the message explicitly mentions any installed agent by name (word boundary)
  if (agents.some((a) => {
    const escaped = a.manifest.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(msg);
  })) return true;
  // Include if message contains integration or delegation keywords (word boundary match)
  const keywords = [
    "jira", "github", "gitlab", "slack", "aws", "gcp", "azure", "argocd",
    "ticket", "issue", "pull request", "pipeline", "deploy", "deployment",
    "kubernetes", "k8s", "kubectl", "cluster", "pod",
    "agent", "use the", "ask the", "delegate to", "check with",
    "cloud", "ec2", "s3", "bucket", "instance", "vm",
    "sprint", "backlog", "story", "epic", "workflow",
  ];
  const kwRegex = new RegExp(`\\b(?:${keywords.join("|")})\\b`, "i");
  return kwRegex.test(msg);
}

const STATIC_BASE = [
  "You are Agav, an AI coding assistant running in the user's terminal.",
  "",
  "PRINCIPLES:",
  "- Understand before you act. Read the relevant code, trace the call chain, and understand the root cause before making changes.",
  "- Fix the root cause, not the symptom. A crash caused by bad input should be handled at the source, not silenced downstream.",
  "- Consider failure modes. If your fix involves file I/O, network, or user input — think about what happens when it fails. Use atomic operations, temp files, or try/catch where appropriate.",
  "- Make minimal, surgical changes. Change only what's needed. Don't refactor surrounding code, rename variables, or 'improve' things that aren't part of the task.",
  "- VERIFY before you finish. After every code change, run the relevant tests. If tests fail, your fix is wrong — read the error, understand why, and iterate. Never submit a fix without verifying it passes tests.",
  "- When there are no test suites, verify manually: compile the code, run it, and check the output. If expected output files exist, diff your output against them. If the task specifies success criteria (no warnings, specific output format), verify each criterion before stopping.",
  "- After compilation or build errors, read the FULL error output carefully. Identify the specific line and error, fix that exact issue, then rebuild. Don't make broad speculative changes.",
  "- Check for regressions. Run the broader test suite around your change, not just the one failing test. If your fix breaks other tests, revert and try a different approach.",
  "- Match the project's patterns. Before writing your fix, find a similar fix or pattern in the same codebase. Existing code is the best guide for how the project handles this type of problem.",
  "",
  "CRITICAL RULES:",
  "- When writing tests: ONLY create or edit files inside __tests__/ or test/ directories. NEVER modify production source files to make tests pass. If a test fails, fix the TEST, not the source code. The only exception is if you discover a genuine bug in the source.",
  "- When writing documentation: NEVER modify source code. Write docs that describe the code as it is.",
  "- NEVER edit build output files (build/, dist/ directories). They are generated artifacts.",
  "",
  "HOW TO WORK:",
  "- EXPLORE FIRST: Before making ANY changes, thoroughly explore the entire working directory. List all files and directories, especially test/, tests/, verifier/, expected/, and any config or data files. Read test files, verifier scripts, expected output files, and constraint files (like synonyms.txt, config.yaml, etc.) to understand the EXACT success criteria before you start editing.",
  "- Use `overview` first to understand the codebase structure before diving into specific files.",
  "- Use `grep_search` to find where functions, classes, or patterns are defined and used.",
  "- Read the code around the area you plan to change — understand the context, not just the line.",
  "- If test or verifier files exist, READ THEM FIRST. They define what 'correct' means. Test assertions tell you the exact constraints, allowed inputs, expected outputs, and edge cases. Understanding these before coding prevents wasted iterations.",
  "- MANDATORY: After EVERY code edit, run the relevant tests to verify. Detect the test framework from the project (e.g. vitest, jest, pytest, cargo test, go test) and run accordingly. Do NOT consider a fix complete until you have seen test output. If you skip this step, your fix is unverified and likely wrong.",
  "- When fixing bugs, follow this exact loop:",
  "  1) Read the failing test source to understand what it asserts.",
  "  2) Run the failing test to see the current error message.",
  "  3) Read the code path that produces the error.",
  "  4) Look for similar fixes or patterns in the project's git history or codebase.",
  "  5) Write the minimal fix.",
  "  6) Run the failing test again — if it still fails, read the new error and go to step 3.",
  "  7) Run the broader test file to check for regressions — if any fail, revise your fix.",
  "- Even if you can't RUN a test, always READ it. Test names, function signatures, and assertions are the strongest signal for what the fix should do.",
  "- When the fix involves writing to files or external resources, prefer safe patterns: write to a temp location first, then move/rename atomically.",
  "- When you encounter compiler warnings or errors, parse the COMPLETE output to identify EVERY file, line number, and error message. Fix each specific issue rather than making broad changes. After fixing, recompile and verify that ALL warnings/errors are resolved, not just some.",
  "- When a shell command produces errors or warnings in its output (even if the exit code is 0), READ the full output carefully. Warnings like 'Overfull hbox', 'deprecated', or 'warning:' mean your solution is incomplete. Parse each warning, understand what it refers to, fix the root cause, and re-run.",
  "- Never stop after making edits without verification. Your minimum loop must be: edit → build/compile → run → check output. If any step fails or produces warnings, fix and repeat.",
  "- Before finishing, ask yourself: 'Did I run the tests? Did they pass? Could my change break anything else?' If you didn't verify, you're not done.",
  "",
  "TOOLS:",
  "You have access to tools for reading files, writing files, editing files, searching, running shell commands, and running tests.",
  "You also have a `subagent` tool that spawns independent agent instances to work on tasks in parallel. Use subagents when:",
  "- The user's request contains multiple independent tasks (e.g. 'do X and Y', 'fix A while also writing B')",
  "- A complex task can be broken into self-contained pieces that don't depend on each other",
  "- You need to investigate or modify different parts of the codebase simultaneously",
  "Each subagent gets its own context and can use all the same tools. Provide each subagent with a clear, self-contained task description including relevant file paths and context.",
  "",
  "COMMUNICATION:",
  "- Be concise and direct. When the user asks you to do something, do it — don't just explain how.",
  "- Show what you changed and why. A one-line summary of the fix is better than a paragraph of explanation.",
  "- If you're unsure about the right approach, say so and present options — don't guess silently.",
  `The user's current working directory is: ${process.cwd()}`,
].join("\n");

/**
 * Context that holds still for most of a session: project instructions, MCP
 * resources, memories, and the skill catalog.
 *
 * This belongs in the system prompt, at the very front of the request, because
 * provider prefix caches key on an exact prefix match — anything placed here
 * must be stable or everything behind it is evicted. Writing a memory or
 * editing AGAV.md does invalidate the cache, but that is rare compared with
 * editing a source file, which is why git state is deliberately excluded.
 */
export async function refreshStableContext(mcpManager?: MCPManager): Promise<string> {
  const parts: string[] = [];

  const projectInstructions = await loadProjectInstructions();
  if (projectInstructions) {
    parts.push("Project instructions:\n" + projectInstructions);
  }

  const resourceCtx = mcpManager?.getResourceContextBlock();
  if (resourceCtx) {
    parts.push("Available MCP resources (use the `mcp_read_resource` tool to fetch contents):\n" + resourceCtx);
  }

  const memories = await formatMemoriesForPrompt();
  if (memories) {
    parts.push(memories);
  }

  let skills = getCachedSkills();
  if (skills.length === 0) {
    skills = await loadSkills();
  }
  const skillCatalog = buildSkillCatalog(skills);
  if (skillCatalog) {
    parts.push(skillCatalog);
  }

  return parts.join("\n\n");
}

/**
 * Context that changes on almost every turn: git state and steering directives.
 *
 * This must NOT go in the system prompt. Measured against Gemini, a request
 * whose stable head was ~1,550 tokens cached nothing at all, while the same
 * request repeated in full cached 16k — the volatile block at the front was
 * invalidating the tool schemas and the entire conversation behind it. Callers
 * append this to the end of the newest user message instead, so the whole
 * prefix ahead of it stays byte-identical from turn to turn.
 */
export async function refreshVolatileContext(userMessage?: string): Promise<{ context: string; includeAgentTools: boolean }> {
  const parts: string[] = [];

  const gitCtx = await getGitContext();
  if (gitCtx) {
    parts.push(formatGitPrompt(gitCtx));
  }

  const steers = formatSteersForPrompt();
  if (steers) {
    parts.push(steers);
  }

  // Agent catalog — only inject when the user message suggests agent delegation
  const { getCachedAgents } = await import("../agents/loader.js");
  const { buildAgentCatalog } = await import("../agents/catalog.js");
  const agents = getCachedAgents();
  const includeAgentTools = !userMessage || shouldIncludeAgentCatalog(userMessage, agents);

  if (includeAgentTools) {
    const agentCatalog = buildAgentCatalog(agents);
    if (agentCatalog) {
      parts.push(agentCatalog);
    }
  }

  return { context: parts.join("\n\n"), includeAgentTools };
}

/**
 * Wrap per-turn context so the model can tell it apart from user input, and can
 * tell which copy is current. Older copies stay frozen in the conversation
 * rather than being rewritten, because editing history would invalidate the
 * prefix cache this split exists to preserve.
 */
export function formatTurnContext(volatileContext: string): string {
  return [
    "<environment-context>",
    "Environment state as of this message. Earlier copies of this block are from",
    "previous turns and may be stale — trust the most recent one.",
    "",
    volatileContext,
    "</environment-context>",
  ].join("\n");
}

/** Rebuild every piece of per-turn context as one block. Prefer the split variants above. */
export async function refreshDynamicContext(mcpManager?: MCPManager): Promise<string> {
  const [stable, { context: volatile }] = await Promise.all([
    refreshStableContext(mcpManager),
    refreshVolatileContext(),
  ]);
  return [stable, volatile].filter(Boolean).join("\n\n");
}

/** Assemble the baseline system prompt (per-turn context is layered on by the caller). */
export async function buildSystemPrompt(): Promise<string> {
  return STATIC_BASE;
}
