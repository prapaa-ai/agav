import type { EffortLevel } from "../config/config.js";
import type { Message } from "../providers/types.js";

/**
 * Output-token reduction helpers. Output tokens cost several times input, so
 * trimming ceremony and lowering reasoning effort on routine turns is real
 * money. Both levers here are **cache-safe**: verbosity steering only appends to
 * the end of the system prompt (the cached prefix is unchanged), and effort
 * routing changes a request parameter, not prompt content.
 */

/** Terse steering note appended to the END of the system prompt. */
export const VERBOSITY_STEER_NOTE =
  "\n\nResponse style: be concise. Do not restate the user's request or the " +
  "context back to them, skip preambles like \"Great, let me…\", and do not " +
  "re-print file contents or tool output that is already visible. Lead with the " +
  "result or the change; add only the explanation that is needed.";

/**
 * Append the verbosity note to a system prompt. Appending (not prepending or
 * rewriting) keeps the cached prefix byte-stable, so a provider prompt cache
 * still hits. Idempotent — never appends twice.
 */
export function applyVerbositySteering(systemPrompt: string | undefined): string {
  const base = systemPrompt ?? "";
  if (base.includes(VERBOSITY_STEER_NOTE.trim().slice(0, 24))) return base;
  return base + VERBOSITY_STEER_NOTE;
}

/** Effort ordering, lowest to highest. */
const EFFORT_ORDER: EffortLevel[] = ["low", "medium", "high", "max"];

/**
 * Decide the effort for a turn. On a "resume" turn — the model continuing after
 * tool output that contained no errors (a file read, a passing test) — routine
 * next-step reasoning rarely needs full effort, so we clamp DOWN one notch
 * (never below `low`, never UP). A fresh user turn, or any turn whose latest
 * tool output contains an error, keeps the configured effort so hard reasoning
 * is never starved.
 */
export function resolveTurnEffort(
  configuredEffort: EffortLevel | undefined,
  opts: { isResumeTurn: boolean; lastToolOutputHadError: boolean },
): EffortLevel | undefined {
  const effort = configuredEffort;
  if (effort === undefined) return undefined;
  if (!opts.isResumeTurn || opts.lastToolOutputHadError) return effort;

  const idx = EFFORT_ORDER.indexOf(effort);
  if (idx <= 0) return effort; // already lowest, or unknown value — leave as-is
  return EFFORT_ORDER[idx - 1];
}

/**
 * True when the most recent message is a set of tool results (i.e. the next
 * model turn is a resume-after-tools), and whether any of those results were
 * errors. Used to drive effort routing.
 */
export function inspectLastToolResults(messages: Message[]): {
  isResumeTurn: boolean;
  hadError: boolean;
} {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return { isResumeTurn: false, hadError: false };
  const toolResults = last.content.filter((b) => b.type === "tool_result");
  if (toolResults.length === 0) return { isResumeTurn: false, hadError: false };
  const hadError = toolResults.some((b) => b.isError === true);
  return { isResumeTurn: true, hadError };
}
