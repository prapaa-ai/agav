import React from "react";
import { Box, Static, Text } from "ink";
import { renderMarkdown } from "./markdown-text.js";
import { getToolLabel, getToolSummary } from "../utils/tool-labels.js";
import { getTheme } from "../config/theme.js";
import { fileLink } from "../utils/hyperlink.js";
import type { DiffLine } from "../utils/diff.js";
import { VERSION } from "../version.js";

/** Normalized message shape used for terminal rendering. */
export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool" | "banner";
  content: string;
  sourceText?: string;
  toolName?: string;
  toolDisplayName?: string;
  toolInput?: Record<string, unknown>;
  isError?: boolean;
  diffLines?: DiffLine[];
}

interface Props {
  messages: DisplayMessage[];
  toolDetailKey: string;
}

/** Renders a compact preview of diff output. */
function DiffView({ diffLines }: { diffLines: DiffLine[] }) {
  const theme = getTheme();
  const maxLines = 40;
  const truncated = diffLines.length > maxLines;
  const visible = truncated ? diffLines.slice(0, maxLines) : diffLines;

  const maxNum = visible.reduce(
    (max, l) => (l.lineNo != null && l.lineNo > max ? l.lineNo : max),
    0,
  );
  const pad = Math.max(3, String(maxNum).length);

  return (
    <Box flexDirection="column">
      {visible.map((line, i) => {
        if (line.type === "separator") {
          return <Text key={i} dimColor>{" ".repeat(pad)}   ...</Text>;
        }

        const num = line.lineNo != null
          ? String(line.lineNo).padStart(pad)
          : " ".repeat(pad);

        if (line.type === "remove") {
          return (
            <Text key={i} backgroundColor={theme.diffRemoveBg} color={theme.diffRemoveFg}>
              {num} {"- "}{line.text}
            </Text>
          );
        }

        if (line.type === "add") {
          return (
            <Text key={i} backgroundColor={theme.diffAddBg} color={theme.diffAddFg}>
              {num} {"+ "}{line.text}
            </Text>
          );
        }

        return (
          <Text key={i} dimColor>
            {num} {"  "}{line.text}
          </Text>
        );
      })}
      {truncated && (
        <Text dimColor>{"     ... "}{diffLines.length - maxLines} more lines</Text>
      )}
    </Box>
  );
}

/** Renders a single summarized tool result entry. */
function ToolResultLine({ message }: { message: DisplayMessage }) {
  const label = message.toolDisplayName ?? (message.toolName ? getToolLabel(message.toolName) : "Tool");
  const summary = message.toolName && message.toolInput ? getToolSummary(message.toolName, message.toolInput) : "";

  // Image reference with hyperlink
  if (message.toolName === "image" && message.content) {
    const filePath = message.content;
    const fileName = filePath.split("/").pop() ?? filePath;
    const linked = fileLink(fileName, filePath);
    return (
      <Box flexDirection="column">
        <Text>
          <Text dimColor>{"  └─ "}</Text>
          <Text bold color="magenta">Image</Text>
          <Text> {linked}</Text>
        </Text>
      </Box>
    );
  }

  if (message.diffLines && message.diffLines.length > 0) {
    return (
      <Box flexDirection="column">
        <Text>
          <Text dimColor>{"  └─ "}</Text>
          <Text bold color="yellow">{label}</Text>
          {summary ? <Text dimColor> {summary}</Text> : null}
          <Text dimColor> {message.content}</Text>
        </Text>
        <DiffView diffLines={message.diffLines} />
      </Box>
    );
  }

  const lines = message.content.split("\n");
  const preview = lines[0]?.slice(0, 120) ?? "";
  const lineCount = lines.length;
  const suffix = lineCount > 1 ? ` (${lineCount} lines)` : "";

  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>{"  └─ "}</Text>
        <Text bold color={message.isError ? "red" : "yellow"}>{label}</Text>
        {summary ? <Text dimColor> {summary}</Text> : null}
        <Text dimColor>{suffix}</Text>
      </Text>
      {preview ? (
        <Text>
          <Text dimColor>{"     "}</Text>
          <Text dimColor={!message.isError} color={message.isError ? "red" : undefined}>
            {preview}{lines.length > 1 || preview.length >= 120 ? "..." : ""}
          </Text>
        </Text>
      ) : null}
    </Box>
  );
}

/** Renders the appropriate terminal bubble for a message role. */
function MessageBubble({ message, prevRole, toolDetailKey }: { message: DisplayMessage; prevRole?: string; toolDetailKey: string }) {
  if (message.role === "banner") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">{`   █████╗  ██████╗  █████╗ ██╗   ██╗
  ██╔══██╗██╔════╝ ██╔══██╗██║   ██║
  ███████║██║  ███╗███████║██║   ██║
  ██╔══██║██║   ██║██╔══██║╚██╗ ██╔╝
  ██║  ██║╚██████╔╝██║  ██║ ╚████╔╝
  ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝  ╚═══╝`}</Text>
        <Text dimColor>{`  terminal-native AI agent · v${VERSION}`}</Text>
      </Box>
    );
  }

  if (message.role === "user" && message.content.startsWith("▸ Plan step")) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>{"  "}{message.content}</Text>
      </Box>
    );
  }

  if (message.role === "user") {
    const cols = process.stdout.columns || 80;
    const usable = cols - 2;
    // Strip ANSI escape codes for visual width measurement
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\]8;[^]*?\x1b\\/g, "");
    const visualLen = (s: string) => stripAnsi(s).length;

    const words = message.content.split(" ");
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (visualLen(test) > usable && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);

    const emptyLine = " ".repeat(cols);
    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        <Text backgroundColor="#2d2d2d">{emptyLine}</Text>
        {lines.map((line, i) => {
          const prefix = i === 0 ? "❯ " : "  ";
          const pad = Math.max(0, cols - prefix.length - visualLen(line));
          return (
            <Text key={i} backgroundColor="#2d2d2d">
              {i === 0 ? <Text color="green" bold>{prefix}</Text> : <Text dimColor>{prefix}</Text>}
              <Text color="white">{line}</Text>
              {" ".repeat(pad)}
            </Text>
          );
        })}
        <Text backgroundColor="#2d2d2d">{emptyLine}</Text>
      </Box>
    );
  }

  if (message.role === "tool") {
    return <ToolResultLine message={message} />;
  }

  if (message.role === "assistant") {
    const hadTools = prevRole === "tool";
    return (
      <Box flexDirection="column" marginBottom={1}>
        {hadTools ? <Text dimColor>  ({toolDetailKey} to expand tools)</Text> : null}
        <Text>{"  "}{renderMarkdown(message.content)}</Text>
      </Box>
    );
  }

  if (message.role === "system") {
    const isLong = message.content.length > 200;
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={message.isError ? "red" : undefined} dimColor={!message.isError}>
          {"  "}{isLong ? renderMarkdown(message.content) : message.content}
        </Text>
      </Box>
    );
  }

  return null;
}

/** Renders the scrolling list of conversation messages. */
export default function MessageList({ messages, toolDetailKey }: Props) {
  return (
    <Static items={messages}>
      {(message, index) => (
        <Box key={message.id} flexDirection="column">
          <MessageBubble message={message} prevRole={index > 0 ? messages[index - 1]?.role : undefined} toolDetailKey={toolDetailKey} />
        </Box>
      )}
    </Static>
  );
}
