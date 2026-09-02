import React from "react";
import { Box, Text } from "../ink/index.js";
import { getToolLabel, getToolSummary } from "../utils/tool-labels.js";
import type { DisplayMessage } from "./message-list.js";
import { terminalRelativePaths, terminalToolValue, toolPathValues } from "../utils/display-path.js";

interface Props {
  tools: DisplayMessage[];
  closeKey: string;
}

/** Builds a compact input summary while omitting large edit payloads already shown elsewhere. */
function formatInput(toolName: string, input?: Record<string, unknown>): string | null {
  if (!input || Object.keys(input).length === 0) return null;

  const summary = getToolSummary(toolName, input);
  if (summary) return summary;

  const parts = Object.entries(input)
    .filter(([k]) => k !== "old_string" && k !== "new_string" && k !== "content")
    .map(([k, v]) => {
      const formatted = terminalToolValue(k, v);
      const val = formatted.length > 80 ? formatted.slice(0, 80) + "..." : formatted;
      return `${k}: ${val}`;
    });
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Shows recent tool outputs in a compact expandable detail panel. */
export default function ToolDetailPanel({ tools, closeKey }: Props) {
  const recent = tools.slice(-5);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginBottom={1}>
      <Text bold dimColor>Tool Output Details <Text>({closeKey} to close)</Text></Text>
      {/*
        Rendered at full height. Five tool outputs at 30 preview lines each is
        ~150 rows, but the panel is one section of the app's single scrolling
        document, so length costs scrolling rather than screen space.
      */}
      {recent.map((tool) => {
        const label = tool.toolDisplayName ?? (tool.toolName ? getToolLabel(tool.toolName) : "Tool");
        const inputSummary = tool.toolName ? formatInput(tool.toolName, tool.toolInput) : null;
        const lines = terminalRelativePaths(tool.content, toolPathValues(tool.toolInput)).split("\n");
        const maxPreview = 30;
        const visible = lines.slice(0, maxPreview);
        const truncated = lines.length > maxPreview;

        return (
          <Box key={tool.id} flexDirection="column" marginTop={1}>
            <Box>
              <Text bold color={tool.isError ? "red" : "yellow"}>{label}</Text>
              {inputSummary && <Text dimColor> {inputSummary}</Text>}
            </Box>
            {visible.map((line, i) => (
              <Text key={i} color={tool.isError ? "red" : undefined} dimColor={!tool.isError}>
                {line}
              </Text>
            ))}
            {truncated && (
              <Text dimColor>... {lines.length - maxPreview} more lines</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
