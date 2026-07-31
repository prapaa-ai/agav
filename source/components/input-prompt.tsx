import React, { useState, useRef, useEffect } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import { KeybindingResolver, formatKeybinding, type Keybindings } from "../config/keybindings.js";
import { loadPromptHistory, savePromptHistory } from "../config/prompt-history.js";
import { readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

/** Metadata for a slash command suggestion. */
export interface CommandInfo {
  name: string;
  description: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onPaste?: (text: string, insertLabel: (label: string) => void) => void;
  onRemoveAttachment?: () => void;
  onClearAttachments?: () => void;
  onRegisterInsert?: (fn: (label: string) => void) => void;
  disabled?: boolean;
  commands?: CommandInfo[];
  keybindings: Keybindings;
  resumeUserMessages?: string[];
}

/** Returns the line and column for a cursor index in multiline input. */
function getCursorPosition(value: string, cursorPos: number): { line: number; col: number } {
  let pos = 0;
  const lines = value.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i]!.length;
    if (pos + lineLen >= cursorPos) {
      return { line: i, col: cursorPos - pos };
    }
    pos += lineLen + 1;
  }
  return { line: lines.length - 1, col: lines[lines.length - 1]!.length };
}

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "build", "dist"]);

/** Describes the active @file token under the cursor. */
interface ActiveFileToken {
  start: number;
  end: number;
  query: string;
  quoted: boolean;
}

/** Represents a file or directory completion candidate. */
interface FileSuggestion {
  name: string;
  path: string;
  isDirectory: boolean;
}

/** Finds the current @file token being edited, if any. */
function getActiveFileToken(value: string, cursorPos: number): ActiveFileToken | null {
  const before = value.slice(0, cursorPos);
  const match = before.match(/(^|[\s([{])@(?:(?:"([^"]*))|([^\s)\]}>,;]*))$/);
  if (!match || match[0].includes("@@")) return null;
  const prefixLength = (match[1] ?? "").length;
  const start = before.length - match[0].length + prefixLength;
  return { start, end: cursorPos, query: match[2] ?? match[3] ?? "", quoted: match[2] !== undefined };
}

/** Checks whether a resolved path stays within the current project root. */
function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

/** Renders the interactive prompt with history, completion, and paste handling. */
export default function InputPrompt({ value, onChange, onSubmit, onPaste, onRemoveAttachment, onClearAttachments, onRegisterInsert, disabled, commands = [], keybindings, resumeUserMessages }: Props) {
  const { isRawModeSupported } = useStdin();
  const [cursorPos, setCursorPos] = useState(0);
  const historyRef = useRef<string[]>([]);
  const historyLoadedRef = useRef(false);
  const historyIndexRef = useRef(-1);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [fileSuggestions, setFileSuggestions] = useState<FileSuggestion[]>([]);
  const valueRef = useRef(value);
  const cursorPosRef = useRef(cursorPos);
  const keyResolverRef = useRef(new KeybindingResolver(keybindings, [
    "cancel", "newline", "submit", "historyUp", "historyDown", "clearInput",
    "deleteWordBackward", "editLastPrompt", "openCommandPalette",
  ]));
  valueRef.current = value;
  cursorPosRef.current = cursorPos;

  useEffect(() => {
    if (historyLoadedRef.current) return;
    historyLoadedRef.current = true;
    loadPromptHistory().then((saved) => {
      const isAutoContinue = (s: string) => s.startsWith("Do Step ");
      const resumed = resumeUserMessages ?? [];
      const merged = saved.filter((s) => !isAutoContinue(s));
      for (const msg of resumed) {
        if (msg && !isAutoContinue(msg) && !merged.includes(msg)) merged.push(msg);
      }
      historyRef.current = merged;
    });
  }, []);

  // Register insert function so parent can insert text at cursor (e.g. Ctrl+I image)
  useEffect(() => {
    if (onRegisterInsert) {
      onRegisterInsert((label: string) => {
        const cur = cursorPosRef.current;
        const val = valueRef.current;
        const before = val.slice(0, cur);
        const after = val.slice(cur);
        onChange(before + label + " " + after);
        setCursorPos(cur + label.length + 1);
      });
    }
  }, [onRegisterInsert, onChange]);

  const activeFileToken = getActiveFileToken(value, cursorPos);
  const showSuggestions = !activeFileToken && value.startsWith("/") && !value.includes(" ") && value.length >= 1;
  const partial = value.slice(1).toLowerCase();
  const matchingCommands = showSuggestions
    ? commands.filter((c) => c.name.startsWith(partial))
    : [];
  const hasCommandSuggestions = matchingCommands.length > 0;
  const hasFileSuggestions = Boolean(activeFileToken) && fileSuggestions.length > 0;

  /** Applies the selected file suggestion to the current token. */
  const completeFileSuggestion = (selected: FileSuggestion, token: ActiveFileToken) => {
    const completedPath = `${selected.path}${selected.isDirectory ? "/" : ""}`;
    const needsQuotes = completedPath.includes(" ");
    const mention = needsQuotes
      ? `@"${completedPath}${selected.isDirectory ? "" : "\""}`
      : `@${completedPath}`;
    const suffix = selected.isDirectory ? "" : " ";
    const nextValue = value.slice(0, token.start) + mention + suffix + value.slice(token.end);
    onChange(nextValue);
    setCursorPos(token.start + mention.length + suffix.length);
    setSelectedSuggestion(0);
  };

  useEffect(() => {
    let cancelled = false;
    if (!activeFileToken) {
      setFileSuggestions([]);
      return;
    }
    const query = activeFileToken.query;
    const slash = query.lastIndexOf("/");
    const directoryPart = slash >= 0 ? query.slice(0, slash + 1) : "";
    const leaf = slash >= 0 ? query.slice(slash + 1) : query;
    if (directoryPart.split("/").some((segment) => EXCLUDED_DIRECTORIES.has(segment))) {
      setFileSuggestions([]);
      return;
    }
    const directory = resolve(process.cwd(), ...directoryPart.split("/").filter(Boolean));

    (async () => {
      try {
        const [root, realDirectory] = await Promise.all([realpath(process.cwd()), realpath(directory)]);
        if (!isWithinRoot(root, realDirectory)) throw new Error("outside cwd");
        const entries = await readdir(realDirectory, { withFileTypes: true });
        const suggestions = entries
          .filter((entry) => !EXCLUDED_DIRECTORIES.has(entry.name))
          .filter((entry) => leaf.startsWith(".") || !entry.name.startsWith("."))
          .filter((entry) => entry.name.toLowerCase().startsWith(leaf.toLowerCase()))
          .map((entry) => ({ name: entry.name, path: `${directoryPart}${entry.name}`, isDirectory: entry.isDirectory() }))
          .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
          .slice(0, 10);
        if (!cancelled) {
          setFileSuggestions(suggestions);
          setSelectedSuggestion(0);
        }
      } catch {
        if (!cancelled) setFileSuggestions([]);
      }
    })();
    return () => { cancelled = true; };
  }, [activeFileToken?.query]);

  useInput(
    (input, key) => {
      if (disabled) return;
      const match = keyResolverRef.current.feed(input, key);
      if (match.pending) return;

      if (match.action === "clearInput") {
        onChange("");
        onClearAttachments?.();
        setCursorPos(0);
        historyIndexRef.current = -1;
        return;
      }
      if (match.action === "deleteWordBackward") {
        const before = value.slice(0, cursorPos);
        const wordStart = before.search(/\s*\S+\s*$/);
        const start = wordStart < 0 ? 0 : wordStart;
        onChange(value.slice(0, start) + value.slice(cursorPos));
        setCursorPos(start);
        return;
      }
      if (match.action === "editLastPrompt") {
        const previous = historyRef.current.at(-1);
        if (previous) {
          onChange(previous);
          setCursorPos(previous.length);
        }
        return;
      }
      if (match.action === "openCommandPalette") {
        onChange("/");
        setCursorPos(1);
        setSelectedSuggestion(0);
        return;
      }

      // File path suggestions take precedence while the cursor is in an @ token.
      if (hasFileSuggestions && activeFileToken) {
        if (match.action === "historyDown") {
          setSelectedSuggestion((prev) => Math.min(prev + 1, fileSuggestions.length - 1));
          return;
        }
        if (match.action === "historyUp") {
          setSelectedSuggestion((prev) => Math.max(prev - 1, 0));
          return;
        }
        if (key.tab || match.action === "submit") {
          const selected = fileSuggestions[selectedSuggestion];
          if (selected) completeFileSuggestion(selected, activeFileToken);
          return;
        }
        if (match.action === "cancel") {
          setFileSuggestions([]);
          setSelectedSuggestion(0);
          return;
        }
      }

      // Command suggestions navigation
      if (hasCommandSuggestions) {
        if (match.action === "historyDown") {
          setSelectedSuggestion((prev) => Math.min(prev + 1, matchingCommands.length - 1));
          return;
        }
        if (match.action === "historyUp") {
          setSelectedSuggestion((prev) => Math.max(prev - 1, 0));
          return;
        }
        if (key.tab) {
          const selected = matchingCommands[selectedSuggestion];
          if (selected) {
            const completed = `/${selected.name} `;
            onChange(completed);
            setCursorPos(completed.length);
            setSelectedSuggestion(0);
          }
          return;
        }
        if (match.action === "submit") {
          const selected = matchingCommands[selectedSuggestion];
          if (selected && partial !== selected.name) {
            const completed = `/${selected.name} `;
            onChange(completed);
            setCursorPos(completed.length);
            setSelectedSuggestion(0);
            return;
          }
        }
        if (match.action === "cancel") {
          onChange("");
          setCursorPos(0);
          setSelectedSuggestion(0);
          return;
        }
      }

      // Up arrow — message history
      if (match.action === "historyUp" && !value.includes("\n")) {
        const history = historyRef.current;
        if (history.length === 0) return;
        const nextIdx = Math.min(historyIndexRef.current + 1, history.length - 1);
        historyIndexRef.current = nextIdx;
        const msg = history[history.length - 1 - nextIdx]!;
        onChange(msg);
        setCursorPos(msg.length);
        return;
      }

      // Down arrow — newer history
      if (match.action === "historyDown" && !value.includes("\n")) {
        const history = historyRef.current;
        if (historyIndexRef.current <= 0) {
          historyIndexRef.current = -1;
          onChange("");
          setCursorPos(0);
          return;
        }
        historyIndexRef.current--;
        const msg = history[history.length - 1 - historyIndexRef.current]!;
        onChange(msg);
        setCursorPos(msg.length);
        return;
      }

      if (match.action === "newline" || match.action === "submit") {
        if (match.action === "newline") {
          const before = value.slice(0, cursorPos);
          const after = value.slice(cursorPos);
          onChange(before + "\n" + after);
          setCursorPos(cursorPos + 1);
        } else {
          if (value.trim()) {
            const deduped = historyRef.current.filter((h) => h !== value);
            deduped.push(value);
            historyRef.current = deduped;
            historyIndexRef.current = -1;
            savePromptHistory(deduped);
            onSubmit(value);
            setCursorPos(0);
          }
        }
        return;
      }

      // Bound special keys should not become literal input when their defaults are replaced.
      if (key.return || key.escape || key.upArrow || key.downArrow) return;

      if (key.backspace || key.delete) {
        if (cursorPos > 0) {
          // Check if cursor is right after an attachment label like "<<Pasted #1: ...>>"
          const textBefore = value.slice(0, cursorPos);
          const labelMatch = textBefore.match(/<<(?:\(.*?\) )?(?:Pasted|Image)(?:\s*#\d+)?:.+?>> ?$/);
          if (labelMatch && onRemoveAttachment) {
            const labelStart = cursorPos - labelMatch[0].length;
            onChange(value.slice(0, labelStart) + value.slice(cursorPos));
            setCursorPos(labelStart);
            onRemoveAttachment();
          } else {
            onChange(value.slice(0, cursorPos - 1) + value.slice(cursorPos));
            setCursorPos(cursorPos - 1);
          }
          setSelectedSuggestion(0);
        }
        return;
      }

      if (key.leftArrow) {
        setCursorPos(Math.max(0, cursorPos - 1));
        return;
      }
      if (key.rightArrow) {
        setCursorPos(Math.min(value.length, cursorPos + 1));
        return;
      }

      if (key.tab) {
        return;
      }

      // Character input — pastes are handled by usePaste in use-paste-handler
      if (input && !key.ctrl && !key.meta) {
        const before = value.slice(0, cursorPos);
        const after = value.slice(cursorPos);
        onChange(before + input + after);
        setCursorPos(cursorPos + input.length);
        setSelectedSuggestion(0);
      }
    },
    { isActive: !disabled },
  );

  if (disabled) return null;

  if (!isRawModeSupported) {
    return (
      <Box>
        <Text dimColor>Interactive input not supported in this terminal.</Text>
      </Box>
    );
  }

  const cols = process.stdout.columns || 80;
  const usable = cols - 2;

  interface WrappedLine { text: string; offset: number; isFirst: boolean }
  const wrappedLines: WrappedLine[] = [];
  const rawLines = value.split("\n");
  let globalOffset = 0;
  for (let li = 0; li < rawLines.length; li++) {
    const raw = rawLines[li]!;
    if (raw.length <= usable) {
      wrappedLines.push({ text: raw, offset: globalOffset, isFirst: li === 0 && wrappedLines.length === 0 });
      globalOffset += raw.length + 1;
    } else {
      let pos = 0;
      while (pos < raw.length) {
        const chunk = raw.slice(pos, pos + usable);
        wrappedLines.push({ text: chunk, offset: globalOffset + pos, isFirst: li === 0 && pos === 0 });
        pos += usable;
      }
      globalOffset += raw.length + 1;
    }
  }
  if (wrappedLines.length === 0) wrappedLines.push({ text: "", offset: 0, isFirst: true });

  const isMultiline = rawLines.length > 1 || wrappedLines.length > 1;

  return (
    <Box flexDirection="column">
      {wrappedLines.map((wl, i) => {
        const prefix = wl.isFirst ? "❯ " : "  ";
        const lineStart = wl.offset;
        const lineEnd = lineStart + wl.text.length;
        const cursorInLine = cursorPos >= lineStart && cursorPos <= lineEnd;

        if (!value && wl.isFirst) {
          return (
            <Box key={i}>
              <Text bold color="green">{prefix}</Text>
              <Text inverse> </Text>
              <Text dimColor>Type a message...</Text>
            </Box>
          );
        }

        if (cursorInLine) {
          const col = cursorPos - lineStart;
          const before = wl.text.slice(0, col);
          const ch = col < wl.text.length ? wl.text[col]! : " ";
          const after = col < wl.text.length ? wl.text.slice(col + 1) : "";
          return (
            <Box key={i}>
              {wl.isFirst ? <Text bold color="green">{prefix}</Text> : <Text dimColor>{prefix}</Text>}
              <Text>{before}</Text>
              <Text inverse>{ch}</Text>
              <Text>{after}</Text>
            </Box>
          );
        }

        return (
          <Box key={i}>
            {wl.isFirst ? <Text bold color="green">{prefix}</Text> : <Text dimColor>{prefix}</Text>}
            <Text>{wl.text || " "}</Text>
          </Box>
        );
      })}
      {hasCommandSuggestions && (() => {
        const maxVisible = 8;
        const total = matchingCommands.length;
        const scrollStart = Math.max(0, Math.min(selectedSuggestion - Math.floor(maxVisible / 2), total - maxVisible));
        const visible = matchingCommands.slice(scrollStart, scrollStart + maxVisible);
        return (
          <Box flexDirection="column">
            {visible.map((cmd, vi) => {
              const i = scrollStart + vi;
              const isSelected = i === selectedSuggestion;
              return (
                <Text key={cmd.name}>
                  <Text dimColor={!isSelected}>{"  "}</Text>
                  <Text color={isSelected ? "cyan" : undefined} bold={isSelected} inverse={isSelected}>
                    {` /${cmd.name} `}
                  </Text>
                  <Text dimColor={!isSelected} color={isSelected ? "white" : undefined}> {cmd.description}</Text>
                </Text>
              );
            })}
            {total > maxVisible && (
              <Text dimColor>{"  "}{scrollStart + 1}-{Math.min(scrollStart + maxVisible, total)} of {total}</Text>
            )}
          </Box>
        );
      })()}
      {hasFileSuggestions && (
        <Box flexDirection="column">
          {fileSuggestions.map((suggestion, i) => {
            const isSelected = i === selectedSuggestion;
            return (
              <Text key={suggestion.path}>
                <Text dimColor>{"  "}</Text>
                <Text color={isSelected ? "cyan" : undefined} bold={isSelected} inverse={isSelected}>
                  {` @${suggestion.path}${suggestion.isDirectory ? "/" : ""} `}
                </Text>
                <Text dimColor>{suggestion.isDirectory ? " directory" : " file"}</Text>
              </Text>
            );
          })}
        </Box>
      )}
      {isMultiline && (
        <Box marginTop={1}>
          <Text dimColor>  {formatKeybinding(keybindings, "submit")} to send · {formatKeybinding(keybindings, "newline")} for newline</Text>
        </Box>
      )}
    </Box>
  );
}
