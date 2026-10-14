import React from "react";
import { Box, Text, useInput } from "../ink/index.js";
import { getToolLabel, getToolSummary, getMcpServerName } from "../utils/tool-labels.js";
import type { DiffLine } from "../utils/diff.js";
import { getTheme } from "../config/theme.js";
import { KeybindingResolver, normalizeKeyEvent, type Keybindings } from "../config/keybindings.js";
import { terminalToolValue } from "../utils/display-path.js";
import { describeBackgroundConfirmation, parseBackgroundConfirmInput } from "./background-confirmation.js";

/** Represents the user's approval decision for a tool request. */
export type ConfirmChoice = "yes" | "no" | "always";

interface Props {
  toolName: string;
  input: Record<string, unknown>;
  diffLines?: DiffLine[];
  mcpServerName?: string;
  onConfirm: (choice: ConfirmChoice) => void;
  subagentTask?: string;
  keybindings: Keybindings;
}

/** Prompts the user to approve or reject a pending tool action. */
export default function ToolConfirm({ toolName, input, diffLines, mcpServerName, onConfirm, subagentTask, keybindings }: Props) {
  const keyResolver = React.useRef(new KeybindingResolver(keybindings, ["cancel", "submit"]));
  useInput((rawChar, rawKey) => {
    const { input: char, key } = normalizeKeyEvent(rawChar, rawKey);
    const match = keyResolver.current.feed(char, key);
    if (char === "y" || char === "Y" || match.action === "submit") {
      onConfirm("yes");
    } else if (char === "n" || char === "N" || match.action === "cancel") {
      onConfirm("no");
    } else if (char === "a" || char === "A") {
      onConfirm("always");
    }
  });

  // Background jobs run outside the sandbox and approval is reusable, so the
  // nested spec is shown in full rather than as an 80-character argument.
  const background = toolName === "run_background_job" ? parseBackgroundConfirmInput(input) : undefined;
  if (background) {
    const info = describeBackgroundConfirmation(background.action, background.spec);
    return (
      <Box flexDirection="column" paddingX={1}>
        {subagentTask && (
          <Text dimColor>Subagent "{subagentTask}" requests:</Text>
        )}
        <Text bold color="yellow">{info.label}?</Text>
        <Text>  Command: {info.command}</Text>
        <Text>  Directory: {info.cwd}</Text>
        <Text color={info.unrestricted ? "red" : undefined} bold={info.unrestricted}>  Isolation: {info.isolation}</Text>
        {info.schedule ? <Text>  Schedule: {info.schedule}</Text> : null}
        {info.extras.map((line) => <Text key={line}>  {line}</Text>)}
        <Text dimColor>  {info.reuse}</Text>
        <Box marginTop={1}>
          <Text>
            <Text bold color="green">[Y]es</Text>
            <Text> / </Text>
            <Text bold color="red">[N]o</Text>
          </Text>
        </Box>
      </Box>
    );
  }

  const label = getToolLabel(toolName);
  const summary = getToolSummary(toolName, input);
  const mcpServer = mcpServerName ?? getMcpServerName(toolName);
  const theme = getTheme();

  /** Formats non-edit arguments into a compact confirmation preview. */
  const details = Object.entries(input)
    .filter(([k]) => k !== "old_string" && k !== "new_string" && k !== "content")
    .map(([k, v]) => {
      const formatted = terminalToolValue(k, v);
      const val = formatted.length > 80 ? formatted.slice(0, 80) + "..." : formatted;
      return `  ${k}: ${val}`;
    })
    .join("\n");

  // Show max 20 diff lines in preview
  const maxDiffLines = 20;
  const visibleDiff = diffLines?.slice(0, maxDiffLines);
  const diffTruncated = diffLines && diffLines.length > maxDiffLines;

  return (
    <Box flexDirection="column" paddingX={1}>
      {subagentTask && (
        <Text dimColor>Subagent "{subagentTask}" requests:</Text>
      )}
      <Text bold color="yellow">
        Allow {label}?{mcpServer ? <Text dimColor bold={false}>{` (MCP: ${mcpServer})`}</Text> : null}
      </Text>
      {summary ? <Text dimColor>  {summary}</Text> : null}
      {details ? <Text dimColor>{details}</Text> : null}

      {visibleDiff && visibleDiff.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {visibleDiff.map((line, i) => {
            const pad = Math.max(3, String(line.lineNo ?? 0).length);
            const num = line.lineNo != null ? String(line.lineNo).padStart(pad) : " ".repeat(pad);

            if (line.type === "separator") {
              return <Text key={i} dimColor>{" ".repeat(pad)}   ...</Text>;
            }
            if (line.type === "remove") {
              return <Text key={i} backgroundColor={theme.diffRemoveBg} color={theme.diffRemoveFg}>{num} {"- "}{line.text}</Text>;
            }
            if (line.type === "add") {
              return <Text key={i} backgroundColor={theme.diffAddBg} color={theme.diffAddFg}>{num} {"+ "}{line.text}</Text>;
            }
            return <Text key={i} dimColor>{num} {"  "}{line.text}</Text>;
          })}
          {diffTruncated && <Text dimColor>     ... {diffLines!.length - maxDiffLines} more lines</Text>}
        </Box>
      )}

      <Box marginTop={1}>
        <Text>
          <Text bold color="green">[Y]es</Text>
          <Text> / </Text>
          <Text bold color="red">[N]o</Text>
          <Text> / </Text>
          <Text bold color="cyan">[A]lways</Text>
        </Text>
      </Box>
    </Box>
  );
}
