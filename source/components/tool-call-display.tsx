import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { getToolLabel, getToolSummary } from "../utils/tool-labels.js";
import type { DiffLine } from "../utils/diff.js";

/** Describes a tool invocation shown in the UI. */
export interface ToolCallInfo {
  toolName: string;
  toolCallId?: string;
  input: Record<string, unknown>;
  argsJson?: string;
  status: "running" | "done" | "error";
  result?: string;
  diffLines?: DiffLine[];
}

interface Props {
  toolCall: ToolCallInfo;
}

/** Renders a single tool call with status, label, and summary. */
export default function ToolCallDisplay({ toolCall }: Props) {
  const label = getToolLabel(toolCall.toolName);
  const summary = getToolSummary(toolCall.toolName, toolCall.input);

  return (
    <Box>
      <Text dimColor>{"  └─ "}</Text>
      {toolCall.status === "running" ? (
        <Text color="yellow">
          <Spinner type="dots" />
          {" "}
        </Text>
      ) : toolCall.status === "error" ? (
        <Text color="red">{"✗ "}</Text>
      ) : (
        <Text color="green">{"✓ "}</Text>
      )}
      <Text bold color="yellow">{label}</Text>
      {summary ? <Text dimColor> {summary}</Text> : null}
    </Box>
  );
}
