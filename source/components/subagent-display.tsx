import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { SubagentProgress } from "../agent/subagent-types.js";
import { getToolLabel, getToolSummary } from "../utils/tool-labels.js";
import { terminalRelativePaths, terminalToolValue } from "../utils/display-path.js";
import type { DiffLine } from "../utils/diff.js";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Props for rendering subagent execution progress. */
interface Props {
  progress: SubagentProgress;
  mode?: "compact" | "detail";
  index?: number;
}

/** Displays subagent progress in compact or detailed form. */
export default function SubagentDisplay({ progress, mode = "compact", index }: Props) {
  const elapsed = Math.round((Date.now() - progress.startedAt) / 1000);
  const totalTools = progress.totalToolCalls;
  const prefix = index != null ? `[${index + 1}] ` : "";

  if (mode === "compact") {
    return <CompactView progress={progress} elapsed={elapsed} totalTools={totalTools} prefix={prefix} />;
  }

  return <DetailView progress={progress} elapsed={elapsed} />;
}

/** Renders a one-line summary of subagent progress. */
function CompactView({ progress, elapsed, totalTools, prefix }: {
  progress: SubagentProgress;
  elapsed: number;
  totalTools: number;
  prefix: string;
}) {
  const { inputTokens, outputTokens, cacheReadTokens } = progress.tokenUsage;
  const hasTokens = inputTokens > 0 || outputTokens > 0;
  const tokenSummary = hasTokens
    ? ` · ${formatTokens(inputTokens)} ↑ ${formatTokens(outputTokens)} ↓${cacheReadTokens > 0 ? ` ${formatTokens(cacheReadTokens)} ⇢` : ""}`
    : "";

  if (progress.status === "done") {
    return (
      <Box>
        <Text dimColor>{"  "}{prefix}</Text>
        <Text color="green">{"✓ "}</Text>
        <Text bold color="cyan">{progress.title}</Text>
        <Text dimColor> ({totalTools} tool{totalTools !== 1 ? "s" : ""}, {elapsed}s{tokenSummary})</Text>
      </Box>
    );
  }

  if (progress.status === "error") {
    return (
      <Box>
        <Text dimColor>{"  "}{prefix}</Text>
        <Text color="red">{"✗ "}</Text>
        <Text bold color="cyan">{progress.title}</Text>
        <Text dimColor> — {terminalRelativePaths(progress.error ?? "error")}</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text dimColor>{"  "}{prefix}</Text>
      <Text color="cyan"><Spinner type="dots" />{" "}</Text>
      <Text bold color="cyan">{progress.title}</Text>
      <Text dimColor> ({elapsed}s{totalTools > 0 ? ` · ${totalTools} tool${totalTools !== 1 ? "s" : ""}` : ""}{tokenSummary})</Text>
    </Box>
  );
}

/** Renders detailed subagent progress with tool activity and output. */
function DetailView({ progress, elapsed }: {
  progress: SubagentProgress;
  elapsed: number;
}) {
  const recentTools = progress.toolCalls;

  return (
    <Box flexDirection="column">
      <Box>
        {progress.status === "running" ? (
          <Text color="cyan"><Spinner type="dots" />{" "}</Text>
        ) : progress.status === "done" ? (
          <Text color="green">{"✓ "}</Text>
        ) : (
          <Text color="red">{"✗ "}</Text>
        )}
        <Text bold color="cyan">{progress.title}</Text>
        <Text dimColor> ({elapsed}s)</Text>
      </Box>

      <Box flexDirection="column" paddingLeft={2} marginTop={1}>
        <Text dimColor>Task</Text>
        <Text>{terminalRelativePaths(progress.task)}</Text>
      </Box>

      {progress.thinkingText ? (
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          <Text dimColor>Reasoning summary</Text>
          <Text dimColor>{terminalRelativePaths(progress.thinkingText.length > 200
            ? progress.thinkingText.slice(-200).trimStart()
            : progress.thinkingText)}</Text>
        </Box>
      ) : recentTools.length === 0 && progress.status === "running" ? (
        <Text dimColor>{"  Waiting for model activity..."}</Text>
      ) : null}

      {recentTools.length > 0 && (
        <Text dimColor>  Recent actions (up to 10)</Text>
      )}

      {recentTools.map((tc, i) => {
        const isLast = i === recentTools.length - 1 && !progress.streamingText;
        const branch = isLast ? "└─" : "├─";
        const label = getToolLabel(tc.toolName);
        const summary = getToolSummary(tc.toolName, tc.input);

        return (
          <Box key={`${tc.toolName}-${i}`} flexDirection="column">
            <Box>
              <Text dimColor>{"  "}{branch} </Text>
              {tc.status === "running" ? (
                <Text color="cyan"><Spinner type="dots" />{" "}</Text>
              ) : tc.status === "error" ? (
                <Text color="red">{"✗ "}</Text>
              ) : (
                <Text color="green">{"✓ "}</Text>
              )}
              <Text bold color="yellow">{label}</Text>
              {summary ? <Text dimColor> {summary}</Text> : null}
            </Box>
            <ToolInput input={tc.input} argsJson={tc.argsJson} />
            {tc.diffLines && tc.diffLines.length > 0 ? <ToolDiff diffLines={tc.diffLines} /> : null}
          </Box>
        );
      })}

      {progress.streamingText && (
        <Box flexDirection="column" marginTop={recentTools.length > 0 ? 1 : 0} paddingLeft={2}>
          <Text>
            {terminalRelativePaths(progress.streamingText.length > 500
              ? progress.streamingText.slice(-500).trimStart()
              : progress.streamingText)}
            <Text dimColor>{"▊"}</Text>
          </Text>
        </Box>
      )}

      {progress.error && (
        <Box paddingLeft={2} marginTop={1}>
          <Text color="red">{terminalRelativePaths(progress.error)}</Text>
        </Box>
      )}
    </Box>
  );
}

function ToolInput({ input, argsJson }: { input: Record<string, unknown>; argsJson?: string }) {
  const entries = Object.entries(input);
  const content = entries.length > 0
    ? entries.map(([key, value]) => `${key}: ${terminalToolValue(key, value)}`).join(" · ")
    : argsJson || "waiting for input...";

  return (
    <Text dimColor>{"     input: "}{terminalRelativePaths(content.length > 400 ? `${content.slice(0, 400)}...` : content)}</Text>
  );
}

function ToolDiff({ diffLines }: { diffLines: DiffLine[] }) {
  const visible = diffLines.slice(0, 40);
  return (
    <Box flexDirection="column" paddingLeft={5}>
      {visible.map((line, index) => (
        <Text key={index} color={line.type === "add" ? "green" : line.type === "remove" ? "red" : undefined} dimColor={line.type === "context"}>
          {line.type === "add" ? "+ " : line.type === "remove" ? "- " : "  "}{line.text}
        </Text>
      ))}
      {diffLines.length > visible.length && <Text dimColor>{`... ${diffLines.length - visible.length} more diff lines`}</Text>}
    </Box>
  );
}
