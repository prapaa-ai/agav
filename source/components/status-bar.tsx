import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { getRandomHint } from "../utils/hints.js";

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
}

/** Formats token counts into a compact display string. */
function fmt(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  return `${(n / 1_000_000_000).toFixed(1)}b`;
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

  const displayHint = hint ?? getRandomHint();

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>
        {provider}/{model} · effort: {effort} · {messageCount} msgs · {parts.join(" ")}{sandboxBackend ? ` · ${sandboxBackend}` : ""}{branchName ? ` · session: ${branchName}` : ""}
      </Text>
      {loopStatus && (
        <Text color="yellow" dimColor>{loopStatus}</Text>
      )}
      {psLoading ? (
        <Text color="cyan" dimColor><Spinner type="dots" />{" ps: thinking..."}</Text>
      ) : psResponse ? (
        <Text color="cyan" dimColor>{"↪ ps: "}{psResponse}</Text>
      ) : (
        <Text dimColor italic>
          {"💡 "}{displayHint}
        </Text>
      )}
    </Box>
  );
}
