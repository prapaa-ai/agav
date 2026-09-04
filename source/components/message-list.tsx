import React from "react";
import { Box, Text } from "../ink/index.js";
import { renderMarkdown } from "./markdown-text.js";
import ClickableLine from "./clickable-line.js";
import { getToolLabel, getToolSummary, isBookkeepingTool } from "../utils/tool-labels.js";
import { getTheme } from "../config/theme.js";
import type { DiffLine } from "../utils/diff.js";
import type { InvocationReason } from "../providers/types.js";
import { projectRelativePath, terminalRelativePaths, toolPathValues } from "../utils/display-path.js";
import { visualLen, wrapToWidth } from "../utils/wrap-text.js";
import { VERSION } from "../version.js";
import { useDetectedTargets } from "../hooks/use-detected-targets.js";
import { buildClickableLines } from "../utils/render-clickable.js";
import { targetToRefId, wrapTextToRuns } from "../utils/wrap-runs.js";
import { encodeOpenRef, type OpenRef } from "../utils/open-ref.js";

/** Normalized message shape used for terminal rendering. */
export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool" | "banner";
  content: string;
  sourceText?: string;
  invocationReason?: InvocationReason;
  toolName?: string;
  toolDisplayName?: string;
  toolInput?: Record<string, unknown>;
  isError?: boolean;
  diffLines?: DiffLine[];
}

interface Props {
  messages: DisplayMessage[];
  toolDetailKey: string;
  columns: number;
  /** Opens/previews whatever a clickable run in the transcript resolved to. */
  onOpenRef?: (ref: OpenRef) => void;
}

/**
 * Renders markdown-rendered text as a column of `ClickableLine` rows, making
 * every detected URL/file path in it clickable. Falls back to plain
 * `renderMarkdown` output with no per-run splitting while detection is still
 * pending or found nothing — indistinguishable from today's rendering.
 */
const ClickableMarkdown = React.memo(function ClickableMarkdown({
  rawText, styledText, messageId, columns, indent, onOpenRef, dimColor,
}: { rawText: string; styledText: string; messageId: string; columns: number; indent: string; onOpenRef?: (ref: OpenRef) => void; dimColor?: boolean }) {
  const theme = getTheme();
  const targets = useDetectedTargets(rawText, messageId, Boolean(onOpenRef));

  if (targets.length === 0 || !onOpenRef) {
    return <Text dimColor={dimColor}>{indent}{styledText}</Text>;
  }

  const width = Math.max(10, columns - visualLen(indent));
  const lines = buildClickableLines(styledText, width, targets, (t) => targetToRefId(t, encodeOpenRef), {
    color: theme.linkColor,
    underline: true,
  }, { dimColor });

  const handleOpen = (targetId: string) => {
    const ref = JSON.parse(targetId) as OpenRef;
    onOpenRef(ref);
  };

  return (
    <Box flexDirection="column">
      {lines.map((runs, i) => (
        <ClickableLine
          key={i}
          runs={i === 0 ? [{ text: indent }, ...runs] : [{ text: " ".repeat(visualLen(indent)) }, ...runs]}
          onOpen={handleOpen}
        />
      ))}
    </Box>
  );
});

/**
 * Renders a user message inside its padded background band, making every
 * detected URL/file path in it clickable.
 *
 * The band is painted by writing each line followed by enough spaces to reach
 * the right edge (`wrapToWidth` guarantees each line fits in one row), so a
 * clickable run's padding must land on the SAME row it was measured for — the
 * padding is appended as a final plain run on that row rather than as a
 * separate `<Text>` sibling measured against the whole message.
 */
const UserMessage = React.memo(function UserMessage({ message, columns, onOpenRef }: { message: DisplayMessage; columns: number; onOpenRef?: (ref: OpenRef) => void }) {
  const cols = columns;
  const usable = cols - 2;
  const targets = useDetectedTargets(message.content, message.id, Boolean(onOpenRef));

  const emptyLine = " ".repeat(cols);
  const invocationText = message.invocationReason
    ? `AUTOMATION  /${message.invocationReason.source} · ${message.invocationReason.detail}`
    : undefined;

  const handleOpen = (targetId: string) => {
    const ref = JSON.parse(targetId) as OpenRef;
    onOpenRef?.(ref);
  };

  // Every line is padded out to the full width below, which only paints a
  // clean band while each one fits on a single row — `wrapToWidth` (used both
  // directly here and inside `wrapTextToRuns`) guarantees that.
  const runLines = onOpenRef && targets.length > 0
    ? wrapTextToRuns(message.content, usable, targets, (t) => targetToRefId(t, encodeOpenRef), { color: getTheme().linkColor, underline: true }, { color: "white" })
    : wrapToWidth(message.content, usable).map((line) => [{ text: line, color: "white" }]);

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text backgroundColor="#2d2d2d">{emptyLine}</Text>
      {invocationText ? (
        <Text backgroundColor="#2d2d2d">
          <Text color="yellow" bold>{"  AUTOMATION"}</Text>
          <Text dimColor>{`  /${message.invocationReason!.source} · ${message.invocationReason!.detail}`}</Text>
          {" ".repeat(Math.max(0, cols - visualLen(invocationText) - 2))}
        </Text>
      ) : null}
      {runLines.map((runs, i) => {
        const prefix = i === 0 ? "❯ " : "  ";
        const lineText = runs.map((r) => r.text).join("");
        const pad = Math.max(0, cols - prefix.length - visualLen(lineText));
        const prefixRun = i === 0
          ? { text: prefix, color: "green", bold: true, backgroundColor: "#2d2d2d" }
          : { text: prefix, dimColor: true, backgroundColor: "#2d2d2d" };
        const styledRuns = runs.map((r) => ({ ...r, backgroundColor: "#2d2d2d" }));
        const padRun = { text: " ".repeat(pad), backgroundColor: "#2d2d2d" };
        return <ClickableLine key={i} runs={[prefixRun, ...styledRuns, padRun]} onOpen={handleOpen} />;
      })}
      <Text backgroundColor="#2d2d2d">{emptyLine}</Text>
    </Box>
  );
});

/** Renders a compact preview of diff output. */
const DiffView = React.memo(function DiffView({ diffLines }: { diffLines: DiffLine[] }) {
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
});

/** Renders a single summarized tool result entry. */
const ToolResultLine = React.memo(function ToolResultLine({ message }: { message: DisplayMessage }) {
  const label = message.toolDisplayName ?? (message.toolName ? getToolLabel(message.toolName) : "Tool");
  const summary = message.toolName && message.toolInput ? getToolSummary(message.toolName, message.toolInput) : "";
  const displayContent = terminalRelativePaths(message.content, toolPathValues(message.toolInput));

  // Image reference. Plain text rather than an OSC 8 hyperlink — this
  // renderer corrupts OSC 8 (the URL leaks into visible text) and emitting it
  // on a row we also handle clicks for causes terminals to double-open. The
  // path itself is picked up by the same file-path detection the rest of the
  // transcript uses, so it is still clickable.
  if (message.toolName === "image" && message.content) {
    const filePath = message.content;
    return (
      <Box flexDirection="column">
        <Text>
          <Text dimColor>{"  └─ "}</Text>
          <Text bold color="magenta">Image</Text>
          <Text> {projectRelativePath(filePath)}</Text>
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
          <Text dimColor> {displayContent}</Text>
        </Text>
        <DiffView diffLines={message.diffLines} />
      </Box>
    );
  }

  const lines = displayContent.split("\n");
  const preview = lines[0]?.slice(0, 120) ?? "";
  const lineCount = lines.length;
  const suffix = lineCount > 1 ? ` (${lineCount} lines)` : "";
  // Progress ticks stay in the scrollback for the rest of the session, so this
  // is where they most need to read as notes rather than as work. A failed one
  // still goes red — that one is worth stopping on.
  const muted = !message.isError && !!message.toolName && isBookkeepingTool(message.toolName);

  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>{"  └─ "}</Text>
        <Text bold={!muted} color={message.isError ? "red" : muted ? undefined : "yellow"} dimColor={muted}>{label}</Text>
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
});

/** Renders the appropriate terminal bubble for a message role. */
const MessageBubble = React.memo(function MessageBubble({ message, prevRole, toolDetailKey, columns, onOpenRef }: { message: DisplayMessage; prevRole?: string; toolDetailKey: string; columns: number; onOpenRef?: (ref: OpenRef) => void }) {
  if (message.role === "banner") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="row">
          <Box flexDirection="column" marginLeft={3}>
            <Text bold color="#0891B2">{`
 █████╗   ██████╗   █████╗  ██╗   ██╗      
██╔══██╗ ██╔════╝  ██╔══██╗ ██║   ██║      
███████║ ██║  ███╗ ███████║ ██║   ██║      
██╔══██║ ██║   ██║ ██╔══██║ ╚██╗ ██╔╝      
██║  ██║ ╚██████╔╝ ██║  ██║  ╚████╔╝       
╚═╝  ╚═╝  ╚═════╝  ╚═╝  ╚═╝   ╚═══╝        
`}</Text>
</Box>
          </Box>
<Box flexDirection="row" marginLeft={3}>

        <Text color={"#0891B2"}>{`Stay in the Shell.   `}</Text> 
        <Text dimColor>{`Version: v${VERSION}`}</Text>
</Box>
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
    return (
      <UserMessage
        message={message}
        columns={columns}
        onOpenRef={onOpenRef}
      />
    );
  }

  if (message.role === "tool") {
    return <ToolResultLine message={message} />;
  }

  if (message.role === "assistant") {
    const hadTools = prevRole === "tool";
    const displayContent = terminalRelativePaths(message.content);
    return (
      <Box flexDirection="column" marginBottom={1}>
        {hadTools ? <Text dimColor>  ({toolDetailKey} to expand tools)</Text> : null}
        <ClickableMarkdown
          rawText={displayContent}
          styledText={renderMarkdown(displayContent)}
          messageId={message.id}
          columns={columns}
          indent="  "
          onOpenRef={onOpenRef}
        />
      </Box>
    );
  }

  if (message.role === "system") {
    const isLong = message.content.length > 200;
    const displayContent = terminalRelativePaths(message.content);
    if (message.isError) {
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="red">
            {"  "}{isLong ? renderMarkdown(displayContent) : displayContent}
          </Text>
        </Box>
      );
    }
    return (
      <Box flexDirection="column" marginBottom={1}>
        <ClickableMarkdown
          rawText={displayContent}
          styledText={isLong ? renderMarkdown(displayContent) : displayContent}
          messageId={message.id}
          columns={columns}
          indent="  "
          onOpenRef={onOpenRef}
          dimColor
        />
      </Box>
    );
  }

  return null;
});

/**
 * Renders the conversation transcript at its natural height.
 *
 * There is no viewport here on purpose. The transcript is one section of a
 * single scrolling document owned by `App`; giving it its own would freeze it
 * to a fixed band of the screen while everything below — a streaming reply, a
 * plan, a detail panel — slid around inside bands of their own.
 */
const MessageList = React.memo(function MessageList({ messages, toolDetailKey, columns, onOpenRef }: Props) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {messages.map((message, index) => (
        <MessageBubble key={message.id} message={message} prevRole={index > 0 ? messages[index - 1]?.role : undefined} toolDetailKey={toolDetailKey} columns={columns} onOpenRef={onOpenRef} />
      ))}
    </Box>
  );
});

export default MessageList;
