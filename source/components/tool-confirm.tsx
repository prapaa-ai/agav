import React from "react";
import { Box, Text, ScrollBox, useInput, usePaste, useStdout, type DOMElement, type MouseEventData } from "../ink/index.js";
import type { ScrollBoxControls } from "../ink/index.js";
import { getToolLabel, getToolSummary, getMcpServerName } from "../utils/tool-labels.js";
import type { DiffLine } from "../utils/diff.js";
import { getTheme } from "../config/theme.js";
import { KeybindingResolver, normalizeKeyEvent, type Keybindings } from "../config/keybindings.js";
import { terminalToolValue } from "../utils/display-path.js";
import { describeBackgroundConfirmation, detailViewport, parseBackgroundConfirmInput } from "./background-confirmation.js";
import { type ConfirmResult, MAX_FEEDBACK_LENGTH, countGraphemes, truncateGraphemes } from "../agent/loop.js";
import { isEscapeResidue } from "./input-prompt.js";
import { writeClipboard } from "../ink/termio/clipboard.js";
import stringWidth from "string-width";

/** Represents the user's approval decision for a tool request. */
export type ConfirmChoice = ConfirmResult;

interface Props {
  toolName: string;
  input: Record<string, unknown>;
  diffLines?: DiffLine[];
  mcpServerName?: string;
  onConfirm: (choice: ConfirmChoice) => void;
  subagentTask?: string;
  explicitApprovalOnly?: boolean;
  keybindings: Keybindings;
}

// ---------------------------------------------------------------------------
// Grapheme-cluster helpers for caret movement, selection, and editing.
// ---------------------------------------------------------------------------

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function prevGraphemeOffset(text: string, pos: number): number {
  if (pos <= 0) return 0;
  const before = text.slice(0, pos);
  let lastStart = 0;
  for (const { index } of segmenter.segment(before)) {
    lastStart = index;
  }
  return lastStart;
}

function nextGraphemeOffset(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  for (const { segment, index } of segmenter.segment(text)) {
    if (index >= pos) {
      return index + segment.length;
    }
  }
  return text.length;
}

function graphemeAt(text: string, pos: number): { grapheme: string; length: number } {
  for (const { segment, index } of segmenter.segment(text)) {
    if (index >= pos) {
      return { grapheme: segment, length: segment.length };
    }
  }
  return { grapheme: " ", length: 1 };
}

function wordBoundsAt(text: string, offset: number): [number, number] {
  if (offset < 0 || offset >= text.length || !/\w/.test(text[offset]!)) return [offset, offset];
  let start = offset;
  while (start > 0 && /\w/.test(text[start - 1]!)) start--;
  let end = offset;
  while (end < text.length && /\w/.test(text[end]!)) end++;
  return [start, end];
}

/** Prompts the user to approve or reject a pending tool action. */
export default function ToolConfirm({ toolName, input, diffLines, mcpServerName, onConfirm, subagentTask, explicitApprovalOnly, keybindings }: Props) {
  const keyResolver = React.useRef(new KeybindingResolver(keybindings, ["cancel", "submit", "clearInput", "deleteWordBackward"]));
  const { stdout } = useStdout();
  const [rows, setRows] = React.useState(stdout.rows || 24);
  const detailScroll = React.useRef<ScrollBoxControls | null>(null);
  const [detailOffset, setDetailOffset] = React.useState(Number.POSITIVE_INFINITY);
  const [isFeedbackMode, setIsFeedbackMode] = React.useState(false);
  const feedbackModeRef = React.useRef(false);
  const [, bumpCursor] = React.useState(0);

  const liveRef = React.useRef({ value: "", cursor: 0 });
  const selAnchorRef = React.useRef<number | null>(null);
  const selFocusRef = React.useRef<number | null>(null);
  const lineRef = React.useRef<DOMElement | null>(null);
  const draggingRef = React.useRef(false);
  const clickCountRef = React.useRef(0);
  const lastClickTimeRef = React.useRef(0);

  const getSelectionRange = (): [number, number] | null => {
    const a = selAnchorRef.current;
    const f = selFocusRef.current;
    if (a === null || f === null || a === f) return null;
    return a < f ? [a, f] : [f, a];
  };

  const clearSelection = () => {
    selAnchorRef.current = null;
    selFocusRef.current = null;
    draggingRef.current = false;
  };

  const applyEdit = (nextValue: string, nextCursor: number) => {
    liveRef.current = { value: nextValue, cursor: nextCursor };
    bumpCursor((n) => n + 1);
  };

  const moveCaret = (nextCursor: number) => {
    liveRef.current.cursor = nextCursor;
    bumpCursor((n) => n + 1);
  };

  const deleteSelection = (): boolean => {
    const range = getSelectionRange();
    if (!range) return false;
    const [start, end] = range;
    const val = liveRef.current.value;
    applyEdit(val.slice(0, start) + val.slice(end), start);
    clearSelection();
    return true;
  };

  const copySelectionToClipboard = () => {
    const range = getSelectionRange();
    if (!range) return;
    const [start, end] = range;
    const selected = liveRef.current.value.slice(start, end);
    if (selected && stdout) {
      try {
        writeClipboard(stdout, selected);
      } catch {}
    }
  };

  React.useEffect(() => {
    const resize = () => setRows(stdout.rows || 24);
    stdout.on("resize", resize);
    return () => { stdout.off("resize", resize); };
  }, [stdout]);

  usePaste((text) => {
    if (feedbackModeRef.current && text) {
      const normalized = text.replace(/[\r\n]+/g, " ");
      const range = getSelectionRange();
      const val = liveRef.current.value;
      const cur = Math.min(liveRef.current.cursor, val.length);
      const selStart = range ? range[0] : cur;
      const selEnd = range ? range[1] : cur;

      const before = val.slice(0, selStart);
      const after = val.slice(selEnd);
      const retainedGraphemes = countGraphemes(before) + countGraphemes(after);
      const availableGraphemes = Math.max(0, MAX_FEEDBACK_LENGTH - retainedGraphemes);
      if (availableGraphemes > 0) {
        const toInsert = truncateGraphemes(normalized, availableGraphemes);
        if (toInsert.length > 0) {
          clearSelection();
          applyEdit(before + toInsert + after, selStart + toInsert.length);
        }
      }
    }
  });

  // Background approval is reusable and runs unsandboxed, so show the spec in full.
  const background = toolName === "run_background_job" ? parseBackgroundConfirmInput(input) : undefined;

  useInput((rawChar, rawKey) => {
    const { input: char, key } = normalizeKeyEvent(rawChar, rawKey);

    if (feedbackModeRef.current) {
      const match = keyResolver.current.feed(char, key);
      if (match.pending) return;

      const val = liveRef.current.value;
      const cursorPos = Math.min(liveRef.current.cursor, val.length);

      // Shift+Arrow: extend or create selection
      if (key.shift && (key.leftArrow || key.rightArrow)) {
        if (selAnchorRef.current === null) {
          selAnchorRef.current = cursorPos;
          selFocusRef.current = cursorPos;
        }
        const next = key.leftArrow
          ? prevGraphemeOffset(val, cursorPos)
          : nextGraphemeOffset(val, cursorPos);
        selFocusRef.current = next;
        moveCaret(next);
        if (selAnchorRef.current === next) clearSelection();
        return;
      }

      // Shift+Home / Shift+End
      if (key.shift && key.home) {
        if (selAnchorRef.current === null) {
          selAnchorRef.current = cursorPos;
        }
        selFocusRef.current = 0;
        moveCaret(0);
        if (selAnchorRef.current === 0) clearSelection();
        return;
      }
      if (key.shift && key.end) {
        if (selAnchorRef.current === null) {
          selAnchorRef.current = cursorPos;
        }
        selFocusRef.current = val.length;
        moveCaret(val.length);
        if (selAnchorRef.current === val.length) clearSelection();
        return;
      }

      // Ctrl+A: Select All
      if (key.ctrl && (char === "a" || char === "A")) {
        if (val.length > 0) {
          selAnchorRef.current = 0;
          selFocusRef.current = val.length;
          moveCaret(val.length);
        }
        return;
      }

      // Ctrl+C: Copy selection if any, else cancel feedback mode
      if (key.ctrl && (char === "c" || char === "C")) {
        const range = getSelectionRange();
        if (range) {
          copySelectionToClipboard();
          return;
        }
        clearSelection();
        applyEdit("", 0);
        feedbackModeRef.current = false;
        setIsFeedbackMode(false);
        return;
      }

      // Ctrl+X: Cut selection to clipboard
      if (key.ctrl && (char === "x" || char === "X")) {
        const range = getSelectionRange();
        if (range) {
          copySelectionToClipboard();
          deleteSelection();
          return;
        }
      }

      // Cancel: Escape
      if (match.action === "cancel" || key.escape) {
        clearSelection();
        applyEdit("", 0);
        feedbackModeRef.current = false;
        setIsFeedbackMode(false);
        return;
      }

      // Submit: Enter
      if (match.action === "submit" || key.return) {
        const trimmed = liveRef.current.value.trim();
        onConfirm(trimmed ? { choice: "no", feedback: trimmed } : "no");
        return;
      }

      // Clear input: Ctrl+U
      if (match.action === "clearInput") {
        clearSelection();
        applyEdit("", 0);
        return;
      }

      // Delete word backward: Ctrl+W
      if (match.action === "deleteWordBackward") {
        if (deleteSelection()) return;
        const before = val.slice(0, cursorPos);
        const wordStart = before.search(/\s*\S+\s*$/);
        const start = wordStart < 0 ? 0 : wordStart;
        applyEdit(val.slice(0, start) + val.slice(cursorPos), start);
        return;
      }

      // Backspace
      if (key.backspace) {
        if (deleteSelection()) return;
        if (cursorPos > 0) {
          const prev = prevGraphemeOffset(val, cursorPos);
          applyEdit(val.slice(0, prev) + val.slice(cursorPos), prev);
        }
        return;
      }

      // Delete
      if (key.delete) {
        if (deleteSelection()) return;
        if (cursorPos < val.length) {
          const next = nextGraphemeOffset(val, cursorPos);
          applyEdit(val.slice(0, cursorPos) + val.slice(next), cursorPos);
        }
        return;
      }

      // Left / Right arrows
      if (key.leftArrow) {
        clearSelection();
        moveCaret(prevGraphemeOffset(val, cursorPos));
        return;
      }
      if (key.rightArrow) {
        clearSelection();
        moveCaret(nextGraphemeOffset(val, cursorPos));
        return;
      }

      // Home / End
      if (key.home) {
        clearSelection();
        moveCaret(0);
        return;
      }
      if (key.end || (key.ctrl && (char === "e" || char === "E"))) {
        clearSelection();
        moveCaret(val.length);
        return;
      }

      // Bound special keys to ignore
      if (key.upArrow || key.downArrow || key.tab) {
        return;
      }

      // Character typing
      if (char && !key.ctrl && !key.meta && !key.super && !isEscapeResidue(char)) {
        const range = getSelectionRange();
        const selStart = range ? range[0] : cursorPos;
        const selEnd = range ? range[1] : cursorPos;

        const before = val.slice(0, selStart);
        const after = val.slice(selEnd);
        const retainedGraphemes = countGraphemes(before) + countGraphemes(after);
        const availableGraphemes = Math.max(0, MAX_FEEDBACK_LENGTH - retainedGraphemes);
        if (availableGraphemes > 0) {
          const toInsert = truncateGraphemes(char, availableGraphemes);
          if (toInsert.length > 0) {
            clearSelection();
            applyEdit(before + toInsert + after, selStart + toInsert.length);
          }
        }
        return;
      }
      return;
    }

    if (background && (key.upArrow || key.downArrow)) {
      detailScroll.current?.scrollBy(key.upArrow ? 1 : -1);
      return;
    }
    const match = keyResolver.current.feed(char, key);
    if (char === "y" || char === "Y" || match.action === "submit") {
      onConfirm("yes");
    } else if (char === "n" || char === "N" || match.action === "cancel") {
      onConfirm("no");
    } else if ((char === "d" || char === "D") && !background) {
      clearSelection();
      applyEdit("", 0);
      feedbackModeRef.current = true;
      setIsFeedbackMode(true);
    } else if ((char === "a" || char === "A") && !explicitApprovalOnly) {
      onConfirm("always");
    }
  });

  const prefixWidth = stringWidth("Feedback for agent: ");

  const eventToOffset = (event: MouseEventData): number => {
    const row = lineRef.current;
    if (!row || row.internal_x === undefined) return liveRef.current.value.length;
    const text = liveRef.current.value;
    const colX = Math.max(0, event.x - row.internal_x - prefixWidth);
    let offset = 0;
    let width = 0;
    for (const { segment, index } of segmenter.segment(text)) {
      const segWidth = stringWidth(segment);
      if (width + segWidth > colX) {
        return colX - width < segWidth - (colX - width) ? index : index + segment.length;
      }
      width += segWidth;
      offset = index + segment.length;
    }
    return offset;
  };

  const handleMouseDown = (event: MouseEventData) => {
    const offset = eventToOffset(event);
    const now = Date.now();
    const isMultiClick = now - lastClickTimeRef.current < 400;
    lastClickTimeRef.current = now;
    clickCountRef.current = isMultiClick ? (clickCountRef.current % 3) + 1 : 1;

    if (clickCountRef.current === 2) {
      const text = liveRef.current.value;
      const [start, end] = wordBoundsAt(text, offset);
      if (start !== end) {
        selAnchorRef.current = start;
        selFocusRef.current = end;
        moveCaret(end);
      }
      event.stopPropagation?.();
      return;
    }

    if (clickCountRef.current === 3) {
      const text = liveRef.current.value;
      selAnchorRef.current = 0;
      selFocusRef.current = text.length;
      moveCaret(text.length);
      event.stopPropagation?.();
      return;
    }

    selAnchorRef.current = offset;
    selFocusRef.current = offset;
    draggingRef.current = false;
    moveCaret(offset);
    event.stopPropagation?.();
  };

  const handleMouseMove = (event: MouseEventData) => {
    if (selAnchorRef.current === null) return;
    const offset = eventToOffset(event);
    draggingRef.current = true;
    selFocusRef.current = offset;
    moveCaret(offset);
    event.stopPropagation?.();
  };

  const handleMouseUp = (event: MouseEventData) => {
    if (draggingRef.current || clickCountRef.current >= 2) {
      copySelectionToClipboard();
      draggingRef.current = false;
    }
    event.stopPropagation?.();
  };

  const handleClick = (event: MouseEventData) => {
    if (!draggingRef.current && clickCountRef.current <= 1) {
      const offset = eventToOffset(event);
      clearSelection();
      moveCaret(offset);
    }
    event.stopPropagation?.();
  };

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
        {explicitApprovalOnly ? "Explicit approval required: " : "Allow "}{label}?{mcpServer ? <Text dimColor bold={false}>{` (MCP: ${mcpServer})`}</Text> : null}
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
        {isFeedbackMode ? (
          <Box flexDirection="column">
            <Box
              ref={lineRef}
              onClick={handleClick}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
            >
              <Text bold color="yellow">Feedback for agent: </Text>
              {(() => {
                const text = liveRef.current.value;
                const cursorPos = Math.min(liveRef.current.cursor, text.length);
                const sel = getSelectionRange();
                if (sel) {
                  const [start, end] = sel;
                  const before = text.slice(0, start);
                  const selected = text.slice(start, end);
                  const after = text.slice(end);
                  return (
                    <Text>
                      <Text color="cyan">{before}</Text>
                      <Text inverse color="cyan">{selected}</Text>
                      <Text color="cyan">{after}</Text>
                    </Text>
                  );
                }
                const before = text.slice(0, cursorPos);
                const { grapheme: ch, length: chLen } = cursorPos < text.length
                  ? graphemeAt(text, cursorPos)
                  : { grapheme: " ", length: 1 };
                const after = cursorPos < text.length ? text.slice(cursorPos + chLen) : "";
                return (
                  <Text>
                    <Text color="cyan">{before}</Text>
                    <Text inverse color="cyan">{ch}</Text>
                    <Text color="cyan">{after}</Text>
                  </Text>
                );
              })()}
            </Box>
            <Text dimColor>Enter to submit denial · Esc to cancel · max {MAX_FEEDBACK_LENGTH} characters</Text>
          </Box>
        ) : (
          <Text>
            <Text bold color="green">[Y]es</Text>
            <Text> / </Text>
            <Text bold color="red">[N]o</Text>
            <Text> / </Text>
            <Text bold color="yellow">[D]eny with feedback</Text>
            {!explicitApprovalOnly && <>
              <Text> / </Text>
              <Text bold color="cyan">[A]lways</Text>
            </>}
          </Text>
        )}
      </Box>
    </Box>
  );
}
