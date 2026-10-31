import React, { useState, useEffect } from "react";
import { Box, Text, Spinner } from "../ink/index.js";
import { getRandomHint } from "../utils/hints.js";
import { terminalRelativePaths } from "../utils/display-path.js";
import type { ClipboardNotice } from "../ink/termio/clipboard.js";
import {
  defaultStatusBarLayout,
  enabledStatusBarItems,
  isStatusBarItemEnabled,
  normalizeStatusBarLayout,
  INLINE_STATUS_BAR_ITEMS,
  type StatusBarItemId,
  type StatusBarLayout,
} from "../config/status-bar-layout.js";

/** Props for the status bar footer. */
interface Props {
  copyNotice?: ClipboardNotice | null;
  model: string;
  provider: string;
  effort: string;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  hint?: string;
  psResponse?: string;
  psLoading?: boolean;
  loopStatus?: string;
  /** Background workflow activity, e.g. "workflows: 1 running · 2 need approval" (omitted when idle). */
  workflowStatus?: string;
  sandboxBackend?: string;
  branchName?: string;
  turnStartTime?: number | null;
  lastTurnDurationMs?: number | null;
  isLoading?: boolean;
  isPaused?: boolean;
  agentLock?: { name: string; full: boolean };
  /** Customized footer layout; omitted/invalid falls back to the default. */
  layout?: StatusBarLayout;
}

/** Formats token counts into a compact display string. */
function fmt(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  return `${(n / 1_000_000_000).toFixed(1)}b`;
}

/** Format milliseconds into a human-readable duration (e.g. "1.2s", "2m 15s"). */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    const tenths = Math.floor((ms % 1000) / 100);
    return `${totalSeconds}.${tenths}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/**
 * The already-formatted text for each footer segment. The renderer and the
 * `/customize` preview both turn this into a single line via the shared layout,
 * so the preview is always faithful to the real footer.
 */
export type StatusBarSegments = Partial<Record<StatusBarItemId, string>>;

/**
 * Join the enabled segments in the layout's order with the footer's separator,
 * skipping any segment that has no text for the current session (e.g. no
 * sandbox or no session name). Exported so the customization preview reuses the
 * exact rendering the footer uses.
 */
export function buildStatusBarText(segments: StatusBarSegments, layout?: StatusBarLayout): string {
  const resolved = normalizeStatusBarLayout(layout ?? defaultStatusBarLayout());
  const inline = new Set<StatusBarItemId>(INLINE_STATUS_BAR_ITEMS);
  const pieces: string[] = [];
  for (const id of enabledStatusBarItems(resolved)) {
    // The hint is a separate line, never an inline segment, so it can never
    // join the comma-separated list even if its text is supplied.
    if (!inline.has(id)) continue;
    const text = segments[id];
    if (text) pieces.push(text);
  }
  return pieces.join(" · ");
}

/** Renders model, token, and hint status information. */
export default function StatusBar({
  copyNotice,
  model,
  provider,
  effort,
  messageCount,
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  hint,
  psResponse,
  psLoading,
  loopStatus,
  workflowStatus,
  sandboxBackend,
  branchName,
  turnStartTime,
  lastTurnDurationMs,
  isLoading,
  isPaused,
  agentLock,
  layout,
}: Props) {
  const total = inputTokens + outputTokens;
  const parts = [];
  if (total > 0) {
    parts.push(`${fmt(inputTokens)} ↑ ${fmt(outputTokens)} ↓ ${fmt(cacheReadTokens)} ⇢`);
    if (cacheWriteTokens > 0) {
      parts.push(`${fmt(cacheWriteTokens)} ⇠`);
    }
  } else {
    parts.push("0 tokens");
  }

  // Live elapsed timer while the agent is active.
  // Freezes when paused (HITL confirmation pending) and resumes when the user
  // responds — at which point turnStartTime is reset so the timer restarts.
  const [elapsed, setElapsed] = useState(0);
  const frozenElapsedRef = React.useRef(0);
  useEffect(() => {
    if (!turnStartTime) {
      setElapsed(0);
      frozenElapsedRef.current = 0;
      return;
    }
    if (isPaused) {
      // Freeze: capture the current value and stop ticking.
      frozenElapsedRef.current = Date.now() - turnStartTime;
      setElapsed(frozenElapsedRef.current);
      return;
    }
    setElapsed(Date.now() - turnStartTime);
    const timer = setInterval(() => {
      setElapsed(Date.now() - turnStartTime);
    }, 100);
    return () => clearInterval(timer);
  }, [turnStartTime, isPaused]);

  // Build the turn duration segment (without a leading separator; the layout
  // joiner inserts separators between enabled segments).
  let durationText = "";
  if (isLoading && turnStartTime) {
    durationText = `⏱ ${formatDuration(elapsed)}`;
  } else if (lastTurnDurationMs != null) {
    durationText = `⏱ ${formatDuration(lastTurnDurationMs)}`;
  }

  const displayHint = hint ?? getRandomHint();
  const hintEnabled = isStatusBarItemEnabled(normalizeStatusBarLayout(layout ?? defaultStatusBarLayout()), "hint");

  // Each segment's formatted text, keyed by its layout id. Empty strings are
  // skipped by buildStatusBarText, so an absent sandbox/session/duration leaves
  // no dangling separator — identical to the historical footer.
  const statusText = buildStatusBarText({
    model: `${provider}/${model}`,
    effort: `effort: ${effort}`,
    messages: `${messageCount} msgs`,
    usage: parts.join(" "),
    duration: durationText,
    sandbox: sandboxBackend || "",
    session: branchName ? `session: ${branchName}` : "",
  }, layout);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{statusText}</Text>
      {agentLock && (
        <Text color={agentLock.full ? "red" : "yellow"} dimColor>
          {"🔒 agent: "}{agentLock.name}{agentLock.full ? " (full)" : " (read-only)"}
        </Text>
      )}
      {loopStatus && (
        <Text color="yellow" dimColor>{loopStatus}</Text>
      )}
      {workflowStatus && (
        <Text color="yellow" dimColor>{workflowStatus}</Text>
      )}
      {psLoading ? (
        <Text color="cyan" dimColor><Spinner />{" ps: thinking..."}</Text>
      ) : psResponse ? (
        <Text color="cyan" dimColor>{"↪ ps: "}{terminalRelativePaths(psResponse)}</Text>
      ) : copyNotice ? (
        <Text color={copyNotice === "Copied to clipboard" ? "green" : "cyan"}>
          {copyNotice === "Copied to clipboard" ? "✓ " : ""}{copyNotice}
        </Text>
      ) : hintEnabled ? (
        <Text dimColor italic>
          {"💡 "}{displayHint}
        </Text>
      ) : (
        // Reserve this row even when nothing fills it. The copy notice, ps
        // response and hint all share this single slot; letting it collapse to
        // zero rows would change the dynamic frame's height the moment a copy
        // notice appears, shifting every content row by one. The global
        // selection highlight is keyed by absolute frame-row index, so that
        // shift leaves the top selected line rendered unhighlighted until the
        // notice clears and the frame height returns. Keeping the row present
        // makes the notice replace content on a stable row instead of adding
        // one, so the selection stays correct throughout.
        <Text> </Text>
      )}
    </Box>
  );
}
