import React from "react";
import { Box, Text, Spinner } from "../ink/index.js";
import { getToolLabel, getToolSummary, isBookkeepingTool } from "../utils/tool-labels.js";
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
  // A progress tick carries the same bold yellow as an edit or a shell command,
  // which is what makes it look like the agent doing something to the project.
  const bookkeeping = isBookkeepingTool(toolCall.toolName);

  return (
    <Box>
      <Text dimColor>{"  └─ "}</Text>
      {toolCall.status === "running" ? (
        <Text color="yellow">
          <Spinner />
          {" "}
        </Text>
      ) : toolCall.status === "error" ? (
        <Text color="red">{"✗ "}</Text>
      ) : (
        <Text color="green">{"✓ "}</Text>
      )}
      <Text bold={!bookkeeping} color={bookkeeping ? undefined : "yellow"} dimColor={bookkeeping}>{label}</Text>
      {summary ? <Text dimColor> {summary}</Text> : null}
    </Box>
  );
}
