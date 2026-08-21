import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { getRandomHint } from "../utils/hints.js";
import { terminalRelativePaths } from "../utils/display-path.js";

/** Props for the status bar footer. */
interface Props {
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
  sandboxBackend?: string;
  branchName?: string;
  turnStartTime?: number | null;
  lastTurnDurationMs?: number | null;
  isLoading?: boolean;
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

/** Renders model, token, and hint status information. */
export default function StatusBar({
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
  sandboxBackend,
  branchName,
  turnStartTime,
  lastTurnDurationMs,
  isLoading,
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

  // Live elapsed timer while the agent is active
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!turnStartTime) {
      setElapsed(0);
      return;
    }
    setElapsed(Date.now() - turnStartTime);
    const timer = setInterval(() => {
      setElapsed(Date.now() - turnStartTime);
    }, 100);
    return () => clearInterval(timer);
  }, [turnStartTime]);

  // Build the turn duration segment
  let durationSegment = "";
  if (isLoading && turnStartTime) {
    durationSegment = ` · ⏱ ${formatDuration(elapsed)}`;
  } else if (lastTurnDurationMs != null) {
    durationSegment = ` · ⏱ ${formatDuration(lastTurnDurationMs)}`;
  }

  const displayHint = hint ?? getRandomHint();

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>
        {provider}/{model} · effort: {effort} · {messageCount} msgs · {parts.join(" ")}{durationSegment}{sandboxBackend ? ` · ${sandboxBackend}` : ""}{branchName ? ` · session: ${branchName}` : ""}
      </Text>
      {loopStatus && (
        <Text color="yellow" dimColor>{loopStatus}</Text>
      )}
      {psLoading ? (
        <Text color="cyan" dimColor><Spinner type="dots" />{" ps: thinking..."}</Text>
      ) : psResponse ? (
        <Text color="cyan" dimColor>{"↪ ps: "}{terminalRelativePaths(psResponse)}</Text>
      ) : (
        <Text dimColor italic>
          {"💡 "}{displayHint}
        </Text>
      )}
    </Box>
  );
}
