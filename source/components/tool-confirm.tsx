import React from "react";
import { Box, Text, ScrollBox, useInput, useStdout } from "../ink/index.js";
import type { ScrollBoxControls } from "../ink/index.js";
import { getToolLabel, getToolSummary, getMcpServerName } from "../utils/tool-labels.js";
import type { DiffLine } from "../utils/diff.js";
import { getTheme } from "../config/theme.js";
import { KeybindingResolver, normalizeKeyEvent, type Keybindings } from "../config/keybindings.js";
import { terminalToolValue } from "../utils/display-path.js";
import { describeBackgroundConfirmation, detailViewport, parseBackgroundConfirmInput } from "./background-confirmation.js";

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
  const { stdout } = useStdout();
  const [rows, setRows] = React.useState(stdout.rows || 24);
  const detailScroll = React.useRef<ScrollBoxControls | null>(null);
  const [detailOffset, setDetailOffset] = React.useState(Number.POSITIVE_INFINITY);
  React.useEffect(() => {
    const resize = () => setRows(stdout.rows || 24);
    stdout.on("resize", resize);
    return () => { stdout.off("resize", resize); };
  }, [stdout]);
  // Background approval is reusable and runs unsandboxed, so show the spec in full.
  const background = toolName === "run_background_job" ? parseBackgroundConfirmInput(input) : undefined;
  useInput((rawChar, rawKey) => {
    if (background && (rawKey.upArrow || rawKey.downArrow)) {
      detailScroll.current?.scrollBy(rawKey.upArrow ? 1 : -1);
      return;
    }
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

  if (background) {
    const info = describeBackgroundConfirmation(background.action, background.spec, background.subject);
    const lines: { text: string; color?: string; bold?: boolean; dim?: boolean }[] = info.job ? [
      { text: `  Job: ${info.command}` },
      { text: `  ID: ${info.job.id}` },
      { text: `  Parent: ${info.job.parent}` },
    ] : [
      { text: `  Command: ${info.command}` },
      { text: `  Directory: ${info.cwd}` },
      { text: `  Isolation: ${info.isolation}`, color: info.unrestricted ? "red" : undefined, bold: info.unrestricted },
      ...(info.schedule ? [{ text: `  Schedule: ${info.schedule}` }] : []),
      ...info.extras.map((text) => ({ text: `  ${text}` })),
      { text: `  ${info.reuse}`, dim: true },
    ];
    const view = detailViewport(lines.map((line) => line.text), (stdout.columns || 80) - 2, Math.max(3, Math.floor((rows - 6) / 2)));
    return (
      <Box flexDirection="column" paddingX={1}>
        {subagentTask && (
          <Text dimColor>Subagent "{subagentTask}" requests:</Text>
        )}
        <Text bold color="yellow">{info.label}?</Text>
        <ScrollBox height={view.rows} controls={detailScroll} scrollOffset={detailOffset} onScrollChange={(offset) => {
          if (Number.isFinite(detailOffset) || offset > 0) setDetailOffset(offset);
        }}>
          {lines.map((line, i) => <Text key={i} color={line.color} bold={line.bold} dimColor={line.dim}>{line.text}</Text>)}
        </ScrollBox>
        {view.overflows && <Text dimColor>  ↑↓: Scroll details</Text>}
        <Box marginTop={view.overflows ? 0 : 1}>
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
