import type { Message } from "../providers/types.js";

/**
 * Prompts the agent injects into the conversation as user turns to steer
 * itself — verification nudges, test-repair retries, the step-limit wind-down.
 * They have to be user turns for the model to act on them, but the user never
 * typed them, so the visible transcript has to leave them out.
 *
 * They live here rather than at their call sites so the legacy matcher below
 * cannot drift out of sync with the text actually being written.
 */
export const NEEDS_VERIFY_PROMPT =
  "You made changes but did not verify they work. Run the program to check your changes produce the correct output. " +
  "If there are expected output files, compare your output against them. If the task requires compilation, compile and check for errors/warnings. " +
  "Do not stop until you have verified your solution.";

export const VERIFY_FAILED_PROMPT =
  "Your last verification command failed or produced errors/warnings. Read the output carefully, identify the specific issue, fix it, and verify again. " +
  "Do not stop until verification passes cleanly.";

export const MAX_STEPS_PROMPT =
  "You have reached the maximum number of steps. Summarize what you have accomplished, " +
  "list any remaining work, and stop. Do not call any more tools.";

// Prepended to /steer directives injected into the conversation mid-turn, so
// the model can tell them apart from ordinary user turns and knows they apply
// to the work already in progress.
export const STEER_DIRECTIVE_PREFIX =
  "[STEER — mid-turn directive from the user. Apply this to the work in progress.]\n";

// Extracted as a constant so LEGACY_PREFIXES (below) can match this dynamic
// prompt by its fixed opening — the full string varies per attempt number.
export const TESTS_FAILED_PREFIX = "Tests failed (attempt ";

export function testsFailedPrompt(attempt: number, maxAttempts: number): string {
  return (
    `${TESTS_FAILED_PREFIX}${attempt}/${maxAttempts}). ` +
    "Analyze the test failures above carefully. Fix the code and run tests again. " +
    (attempt > 1 ? "Try a different approach — your previous fix didn't work." : "")
  );
}

export const NO_EDITS_PROMPT =
  "You analyzed the code but did not make any changes. Now write the actual fix. Use edit_file or write_file to modify the source code. Do not just explain — implement the fix.";

// Same as TESTS_FAILED_PREFIX — the full prompt is dynamic (includes error
// details), so only the fixed opening is extracted for legacy prefix matching.
export const SCHEMA_RETRY_PREFIX = "Your previous response was invalid.";

export function schemaRetryPrompt(details: string): string {
  return `${SCHEMA_RETRY_PREFIX} ${details}\nCorrect it and return ONLY valid JSON matching the required schema, with no markdown fences or commentary.`;
}

// The placeholder compaction falls back to when no summary could be produced.
// Needed in LEGACY_PREFIXES so resumed sessions that went through compaction
// don't display "[Earlier conversation was compacted...]" as a user message.
export const COMPACTION_PLACEHOLDER_PREFIX = "[Earlier conversation";

/**
 * Openings of every injected prompt. Sessions saved before `internal` existed
 * carry no marker, so resuming one would still print these as if the user had
 * typed them; matching the text is the only way to recognise them. New
 * sessions never reach this — the flag settles it first.
 */
const LEGACY_PREFIXES = [
  NEEDS_VERIFY_PROMPT,
  VERIFY_FAILED_PROMPT,
  MAX_STEPS_PROMPT,
  NO_EDITS_PROMPT,
  TESTS_FAILED_PREFIX,
  SCHEMA_RETRY_PREFIX,
  COMPACTION_PLACEHOLDER_PREFIX,
];

/**
 * Whether a message is the agent talking to itself. Anything the user actually
 * sent carries `displayText` or `sourceText`, so a message with either is left
 * alone no matter what it starts with — a user is free to paste one of these
 * strings back in.
 */
export function isInternalUserMessage(msg: Message): boolean {
  if (msg.role !== "user") return false;
  if (msg.internal) return true;
  if (msg.displayText || msg.sourceText) return false;
  const text = msg.content.find((block) => block.type === "text")?.text;
  return !!text && LEGACY_PREFIXES.some((prefix) => text.startsWith(prefix));
}
