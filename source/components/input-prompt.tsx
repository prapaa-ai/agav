import React, { useState, useRef, useEffect } from "react";
import { Box, Text, useInput, useStdin, useStdout, type DOMElement, type MouseEventData } from "../ink/index.js";
import { KeybindingResolver, PROMPT_ACTIONS, formatKeybinding, formatUsableKeybinding, normalizeKeyEvent, type Keybindings } from "../config/keybindings.js";
import { loadPromptHistory, savePromptHistory } from "../config/prompt-history.js";
import { readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

/** Metadata for a slash command suggestion. */
export interface CommandInfo {
  name: string;
  description: string;
  category?: "command" | "agent";
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
  /**
   * When true, arrow keys do not cycle through prompt history.
   *
   * `normalizeKeyEvent` drops mouse reports, but terminals in alternate-scroll
   * mode send the wheel as genuine arrow keys, which are indistinguishable from
   * a keypress. Gating history during an agent turn is the only defence left,
   * at the cost of history recall while the agent works.
   */
  suppressHistory?: boolean;
  commands?: CommandInfo[];
  keybindings: Keybindings;
  /** Whether the terminal negotiated an enhanced keyboard protocol (Shift+Enter is legible). */
  enhancedKeyboard?: boolean;
  resumeUserMessages?: string[];
  agentLock?: string;
  /** Available agent names for /agent argument completion. */
  agentNames?: Array<{ name: string; description: string }>;
}

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "build", "dist"]);

/** Default prompt prefix width: `"❯ "` is 2 chars. */
const DEFAULT_PREFIX_WIDTH = 2;

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

/**
 * Residue of an escape sequence neither Ink nor `normalizeKeyEvent` resolved.
 *
 * Ink drops the leading ESC off a chunk it could not parse, so what reaches us
 * is a bare CSI (`[` + parameter + intermediate + final byte, per ECMA-48) or
 * SS3 (`O` + final byte). Both need at least two characters, which keeps a
 * plain `[` or `O` keystroke typeable.
 *
 * The `+` quantifier handles multiple sequences batched in one read — fast
 * scrolling can produce several mouse reports per chunk, all arriving with
 * their ESC prefix already stripped.
 */
const ESCAPE_RESIDUE_RE = /^(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|O[\x40-\x7e])+$/;

/** Whether `input` is terminal noise rather than something the user typed. */
export function isEscapeResidue(input: string): boolean {
  return input.includes("\x1b") || ESCAPE_RESIDUE_RE.test(input);
}

/**
 * Matches an attachment placeholder: the `<<...>>` stand-in the prompt shows
 * for a pasted block or an image.
 *
 * Written once because two things depend on its exact shape — backspace, which
 * takes a whole one out at a stroke, and click, which refuses to put the caret
 * inside one.
 */
const ATTACHMENT_LABEL = String.raw`<<(?:\(.*?\) )?(?:Pasted|Image)(?:\s*#\d+)?:.+?>>`;

/** The same placeholder, immediately before the cursor, with its trailing space. */
const ATTACHMENT_BEFORE_CURSOR_RE = new RegExp(`${ATTACHMENT_LABEL} ?$`);

/** Every character cell the prompt prints before the text: `"❯ "` or `"  "`. */
const PREFIX_WIDTH = 2;

/**
 * Moves an offset that landed inside an attachment placeholder out to its
 * nearer edge.
 *
 * The placeholder stands in for content the buffer does not hold — a pasted
 * block kept aside, an image's bytes — so to the user it is one thing, however
 * many characters it is to us. A caret dropped inside it would let the next
 * keystroke cut it into two strings that match nothing, orphaning the
 * attachment with no sign on screen that anything happened. Both of its edges
 * are positions the user can sensibly mean, so pick the closer one.
 */
export function snapOutOfAttachment(text: string, offset: number): number {
  const pattern = new RegExp(ATTACHMENT_LABEL, "g");

  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const start = match.index;
    const end = start + match[0].length;

    if (offset > start && offset < end) {
      return offset - start <= end - offset ? start : end;
    }

    if (start > offset) break;
  }

  return offset;
}

// ---------------------------------------------------------------------------
// Grapheme-cluster helpers.  All cursor movement and character deletion must
// step by grapheme cluster, not by UTF-16 code unit, so that emoji, flags,
// skin-tone modifiers, and ZWJ sequences are treated as single characters.
// ---------------------------------------------------------------------------

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Return the code-unit offset one grapheme cluster to the left of `pos`.
 * If `pos` is already at 0, returns 0.
 */
function prevGraphemeOffset(text: string, pos: number): number {
  if (pos <= 0) return 0;
  // Segment the text up to `pos` and take the last segment's start.
  const before = text.slice(0, pos);
  let lastStart = 0;
  for (const { index } of segmenter.segment(before)) {
    lastStart = index;
  }
  return lastStart;
}

/**
 * Return the code-unit offset one grapheme cluster to the right of `pos`.
 * If `pos` is at or past the end, returns `text.length`.
 */
function nextGraphemeOffset(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  for (const { segment, index } of segmenter.segment(text)) {
    if (index >= pos) {
      return index + segment.length;
    }
  }
  return text.length;
}

/**
 * Extract the full grapheme cluster at code-unit offset `pos`.
 * Returns the grapheme string and its code-unit length.
 */
function graphemeAt(text: string, pos: number): { grapheme: string; length: number } {
  for (const { segment, index } of segmenter.segment(text)) {
    if (index >= pos) {
      return { grapheme: segment, length: segment.length };
    }
  }
  return { grapheme: " ", length: 1 };
}

/** Checks whether a resolved path stays within the current project root. */
function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

/** Renders the interactive prompt with history, completion, and paste handling. */
export default function InputPrompt({ value, onChange: emitValue, onSubmit, onPaste, onRemoveAttachment, onClearAttachments, onRegisterInsert, disabled, suppressHistory = false, commands = [], keybindings, enhancedKeyboard = false, resumeUserMessages, agentLock, agentNames = [] }: Props) {
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const [, bumpCursor] = useState(0);

  // The live buffer: the text and caret as of the last key we handled.
  //
  // The parent owns `value`, so every edit is a round trip — we call
  // `onChange`, the parent sets state, React re-renders, and only then does the
  // prop catch up. Keystrokes do not wait for that. With a long transcript
  // above us a commit takes longer than a keypress, so a burst of them all read
  // the same pre-burst prop and each computes the same answer from it: four
  // backspaces splice one character off `value` four times over and delete one
  // character between them. That is why this only ever bit on a resumed
  // session — an empty transcript commits faster than anyone can type.
  //
  // So the key handler reads and writes this ref, synchronously, and treats it
  // as the truth. `onChange` still fires, but only to tell the parent; the prop
  // coming back is an echo, not the source.
  const liveRef = useRef({ value, cursor: 0 });
  const lastEmittedRef = useRef(value);

  // The parent also rewrites the buffer on its own — clearing it after a
  // submit, after a `!` shell command, when a wizard exits. A `value` we did
  // not emit is one of those, and the parent wins: adopt it, and put the caret
  // at its end, the only position that is meaningful in text the user did not
  // place it in. A caret left beyond the end would be invisible (no wrapped
  // line claims an out-of-range offset) and would make backspace splice out
  // characters that are not there.
  if (value !== lastEmittedRef.current) {
    liveRef.current = { value, cursor: value.length };
    lastEmittedRef.current = value;
  }

  const text = liveRef.current.value;
  const cursorPos = Math.min(liveRef.current.cursor, text.length);

  /** Replaces the buffer and places the caret, live and for the parent both. */
  const applyEdit = (nextValue: string, nextCursor: number) => {
    liveRef.current = { value: nextValue, cursor: nextCursor };
    lastEmittedRef.current = nextValue;
    emitValue(nextValue);
    bumpCursor((n) => n + 1);
  };

  /** Moves the caret without touching the text. */
  const moveCaret = (nextCursor: number) => {
    liveRef.current.cursor = nextCursor;
    bumpCursor((n) => n + 1);
  };

  const historyRef = useRef<string[]>([]);
  const historyLoadedRef = useRef(false);
  const historyIndexRef = useRef(-1);
  /** Saves the in-progress input when the user first presses Up, so Down can restore it. */
  const draftRef = useRef<string | null>(null);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [fileSuggestions, setFileSuggestions] = useState<FileSuggestion[]>([]);
  const keyResolverRef = useRef(new KeybindingResolver(keybindings, PROMPT_ACTIONS));
  /** The box holding the text rows, for turning a click into a buffer offset. */
  const linesRef = useRef<DOMElement | null>(null);

  useEffect(() => {
    if (historyLoadedRef.current) return;
    historyLoadedRef.current = true;
    loadPromptHistory().then((saved) => {
      const isAutoContinue = (s: string) => s.startsWith("Do Step ");
      const resumed = (resumeUserMessages ?? []).filter((s) => s && !isAutoContinue(s));
      // Resumed session messages go at the end (most recent) so the first
      // Up-arrow recall shows the last message from *this* session, not
      // whatever was typed last in a different session. Remove duplicates
      // from their earlier position so they are not shown twice.
      const resumedSet = new Set(resumed);
      const merged = saved.filter((s) => !isAutoContinue(s) && !resumedSet.has(s));
      merged.push(...resumed);
      historyRef.current = merged;
    });
  }, []);

  // Register insert function so parent can insert text at cursor (e.g. Ctrl+I image)
  useEffect(() => {
    if (onRegisterInsert) {
      onRegisterInsert((label: string) => {
        // Off the live buffer, like every other edit: the parent may fire this
        // between a keystroke and the render that would have reported it.
        const { value: val, cursor: cur } = liveRef.current;
        const before = val.slice(0, cur);
        const after = val.slice(cur);
        applyEdit(before + label + " " + after, cur + label.length + 1);
      });
    }
  }, [onRegisterInsert]);

  const activeFileToken = getActiveFileToken(text, cursorPos);
  const showSuggestions = !activeFileToken && text.startsWith("/") && !text.includes(" ") && text.length >= 1;
  const partial = text.slice(1).toLowerCase();
  const matchingCommands = showSuggestions
    ? commands.filter((c) => c.name.startsWith(partial))
    : [];
  const hasCommandSuggestions = matchingCommands.length > 0;
  const hasFileSuggestions = Boolean(activeFileToken) && fileSuggestions.length > 0;

  // Agent argument suggestions for `/agent <partial>`
  const agentArgMatch = text.match(/^\/agent\s+(\S*)$/i);
  const agentArgPartial = agentArgMatch?.[1]?.toLowerCase() ?? "";
  const matchingAgentArgs = agentArgMatch && agentNames.length > 0
    ? agentNames
        .filter((a) => a.name.toLowerCase().startsWith(agentArgPartial))
        .slice(0, 10)
    : [];
  const hasAgentArgSuggestions = matchingAgentArgs.length > 0;

  /** Applies the selected file suggestion to the current token. */
  const completeFileSuggestion = (selected: FileSuggestion, token: ActiveFileToken) => {
    const completedPath = `${selected.path}${selected.isDirectory ? "/" : ""}`;
    const needsQuotes = completedPath.includes(" ");
    const mention = needsQuotes
      ? `@"${completedPath}${selected.isDirectory ? "" : "\""}`
      : `@${completedPath}`;
    const suffix = selected.isDirectory ? "" : " ";
    const buf = liveRef.current.value;
    const nextValue = buf.slice(0, token.start) + mention + suffix + buf.slice(token.end);
    applyEdit(nextValue, token.start + mention.length + suffix.length);
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
    (rawInput, rawKey) => {
      if (disabled) return;
      // Shadow the render-scope text and caret with the live ones. The render
      // scope is a snapshot from the last commit, and the whole point is that
      // this key may have arrived before that commit caught up.
      const value = liveRef.current.value;
      const cursorPos = Math.min(liveRef.current.cursor, value.length);
      const { input, key } = normalizeKeyEvent(rawInput, rawKey);
      const match = keyResolverRef.current.feed(input, key);
      if (match.pending) return;

      if (match.action === "clearInput") {
        applyEdit("", 0);
        onClearAttachments?.();
        historyIndexRef.current = -1;
        draftRef.current = null;
        return;
      }
      if (match.action === "deleteWordBackward") {
        const before = value.slice(0, cursorPos);
        const wordStart = before.search(/\s*\S+\s*$/);
        const start = wordStart < 0 ? 0 : wordStart;
        applyEdit(value.slice(0, start) + value.slice(cursorPos), start);
        return;
      }
      if (match.action === "editLastPrompt") {
        const previous = historyRef.current.at(-1);
        if (previous) {
          applyEdit(previous, previous.length);
        }
        return;
      }
      if (match.action === "openCommandPalette") {
        applyEdit("/", 1);
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

      // Agent argument suggestions (for `/agent <partial>`)
      if (hasAgentArgSuggestions) {
        if (match.action === "historyDown") {
          setSelectedSuggestion((prev) => Math.min(prev + 1, matchingAgentArgs.length - 1));
          return;
        }
        if (match.action === "historyUp") {
          setSelectedSuggestion((prev) => Math.max(prev - 1, 0));
          return;
        }
        if (key.tab || match.action === "submit") {
          const selected = matchingAgentArgs[selectedSuggestion];
          if (selected) {
            const completed = `/agent ${selected.name} `;
            applyEdit(completed, completed.length);
            setSelectedSuggestion(0);
          }
          return;
        }
        if (match.action === "cancel") {
          applyEdit("", 0);
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
            applyEdit(completed, completed.length);
            setSelectedSuggestion(0);
          }
          return;
        }
        if (match.action === "submit") {
          const selected = matchingCommands[selectedSuggestion];
          if (selected && partial !== selected.name) {
            const completed = `/${selected.name} `;
            applyEdit(completed, completed.length);
            setSelectedSuggestion(0);
            return;
          }
        }
        if (match.action === "cancel") {
          applyEdit("", 0);
          setSelectedSuggestion(0);
          return;
        }
      }

      // Up arrow — message history (suppressed during agent runs to prevent
      // mouse-wheel-as-arrow-key from triggering costly re-renders).
      if (match.action === "historyUp" && !value.includes("\n") && !suppressHistory) {
        const history = historyRef.current;
        if (history.length === 0) return;
        // Save the in-progress input the first time the user enters history,
        // so pressing Down all the way back restores it instead of clearing.
        if (historyIndexRef.current === -1) {
          draftRef.current = value;
        }
        const nextIdx = Math.min(historyIndexRef.current + 1, history.length - 1);
        historyIndexRef.current = nextIdx;
        const msg = history[history.length - 1 - nextIdx]!;
        applyEdit(msg, msg.length);
        return;
      }

      // Down arrow — newer history
      if (match.action === "historyDown" && !value.includes("\n") && !suppressHistory) {
        const history = historyRef.current;
        if (historyIndexRef.current <= 0) {
          historyIndexRef.current = -1;
          // Restore the draft the user was typing before they entered history.
          const draft = draftRef.current ?? "";
          draftRef.current = null;
          applyEdit(draft, draft.length);
          return;
        }
        historyIndexRef.current--;
        const msg = history[history.length - 1 - historyIndexRef.current]!;
        applyEdit(msg, msg.length);
        return;
      }

      if (match.action === "newline" || match.action === "submit") {
        if (match.action === "newline") {
          const before = value.slice(0, cursorPos);
          const after = value.slice(cursorPos);
          applyEdit(before + "\n" + after, cursorPos + 1);
        } else {
          if (value.trim()) {
            const deduped = historyRef.current.filter((h) => h !== value);
            deduped.push(value);
            historyRef.current = deduped;
            historyIndexRef.current = -1;
            draftRef.current = null;
            savePromptHistory(deduped);
            // No caret reset here. The parent clears the buffer only once it
            // has accepted the message, and the clamp above follows it down to
            // zero when it does. Resetting optimistically stranded the caret at
            // the start of text the parent had decided to keep — where
            // backspace has nothing before it and does nothing at all.
            onSubmit(value);
          }
        }
        return;
      }

      // Bound special keys should not become literal input when their defaults are replaced.
      if (key.return || key.escape || key.upArrow || key.downArrow) return;

      if (key.backspace) {
        if (cursorPos > 0) {
          // Check if cursor is right after an attachment label like "<<Pasted #1: ...>>"
          const textBefore = value.slice(0, cursorPos);
          const labelMatch = textBefore.match(ATTACHMENT_BEFORE_CURSOR_RE);
          if (labelMatch && onRemoveAttachment) {
            const labelStart = cursorPos - labelMatch[0].length;
            applyEdit(value.slice(0, labelStart) + value.slice(cursorPos), labelStart);
            onRemoveAttachment();
          } else {
            const prev = prevGraphemeOffset(value, cursorPos);
            applyEdit(value.slice(0, prev) + value.slice(cursorPos), prev);
          }
          setSelectedSuggestion(0);
        }
        return;
      }

      if (key.delete) {
        if (cursorPos < value.length) {
          const next = nextGraphemeOffset(value, cursorPos);
          applyEdit(value.slice(0, cursorPos) + value.slice(next), cursorPos);
          setSelectedSuggestion(0);
        }
        return;
      }

      if (key.leftArrow) {
        moveCaret(prevGraphemeOffset(value, cursorPos));
        return;
      }
      if (key.rightArrow) {
        moveCaret(nextGraphemeOffset(value, cursorPos));
        return;
      }

      if (key.tab) {
        return;
      }

      // Character input — pastes are handled by usePaste in use-paste-handler,
      // except on terminals without bracketed paste, where the whole chunk
      // arrives here and must still be inserted verbatim.
      if (input && !key.ctrl && !key.meta && !isEscapeResidue(input)) {
        const before = value.slice(0, cursorPos);
        const after = value.slice(cursorPos);
        applyEdit(before + input + after, cursorPos + input.length);
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

  // Ink's stdout, not the process's: this is the surface the renderer lays the
  // rows out into, and a click is turned back into a buffer offset through this
  // same wrap table. Measuring against a different width would put the caret
  // somewhere other than where the user aimed.
  const cols = stdout?.columns || 80;
  const lockPrefix = agentLock ? `${agentLock} › ` : "";
  const prefixWidth = agentLock ? lockPrefix.length : DEFAULT_PREFIX_WIDTH;
  const usable = Math.max(1, cols - prefixWidth);

  interface WrappedLine { text: string; offset: number; isFirst: boolean }
  const wrappedLines: WrappedLine[] = [];
  const rawLines = text.split("\n");
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

  /**
   * Puts the caret where the user clicked on one wrapped row.
   *
   * Which row it was comes from the handler being bound to that row, not from
   * the mouse's `y`. The two do not agree: a frame taller than the terminal has
   * scrolled by the time it is on screen, so a row's laid-out `y` is not the
   * terminal row it is printed on, and subtracting one from the other is off by
   * however far the frame scrolled. Nothing scrolls sideways, so `x` is sound.
   *
   * The wrapped line already knows the buffer offset it starts at — the same
   * table the caret is drawn from, so what the user aims at and what they get
   * are the same thing by construction, wrapping and all.
   */
  const handleRowClick = (line: WrappedLine) => (event: MouseEventData) => {
    const rows = linesRef.current;
    if (!rows || rows.internal_x === undefined) return;

    // Past the end of a line means the end of that line, not the next one:
    // clicking into the empty space right of the text is how anyone asks for
    // the caret to go last.
    const column = event.x - rows.internal_x - prefixWidth;
    const offset = line.offset + Math.max(0, Math.min(column, line.text.length));

    moveCaret(snapOutOfAttachment(text, offset));
    event.stopPropagation?.();
  };

  return (
    // `flexGrow` so the rows span the full width they are drawn across rather
    // than shrink-wrapping the text: the blank space to the right of a line is
    // where anyone clicks to put the caret at its end, and a box that stops at
    // the last character is not there to be clicked.
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="column" ref={linesRef}>
      {wrappedLines.map((wl, i) => {
        const prefix = wl.isFirst ? "❯ " : "  ";
        const lineStart = wl.offset;
        const lineEnd = lineStart + wl.text.length;
        const isLastLine = i === wrappedLines.length - 1;
        const cursorInLine = cursorPos >= lineStart && (isLastLine ? cursorPos <= lineEnd : cursorPos < lineEnd);

        const renderPrefix = (isFirst: boolean) => {
          if (!isFirst) return <Text dimColor>{"  "}</Text>;
          if (agentLock) return <Text bold color="magenta">{lockPrefix}</Text>;
          return <Text bold color="green">{"❯ "}</Text>;
        };

        if (!text && wl.isFirst) {
          return (
            <Box key={i} onClick={handleRowClick(wl)}>
              {renderPrefix(true)}
              <Text inverse> </Text>
              <Text dimColor>{agentLock ? `Ask ${agentLock}...` : "Type a message..."}</Text>
            </Box>
          );
        }

        if (cursorInLine) {
          const col = cursorPos - lineStart;
          const before = wl.text.slice(0, col);
          const { grapheme: ch, length: chLen } = col < wl.text.length
            ? graphemeAt(wl.text, col)
            : { grapheme: " ", length: 1 };
          const after = col < wl.text.length ? wl.text.slice(col + chLen) : "";
          return (
            <Box key={i} onClick={handleRowClick(wl)}>
              {renderPrefix(wl.isFirst)}
              <Text>{before}</Text>
              <Text inverse>{ch}</Text>
              <Text>{after}</Text>
            </Box>
          );
        }

        return (
          <Box key={i} onClick={handleRowClick(wl)}>
            {renderPrefix(wl.isFirst)}
            <Text>{wl.text || " "}</Text>
          </Box>
        );
      })}
      </Box>
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
              const isAgent = cmd.category === "agent";
              const selectedColor = isAgent ? "magenta" : "cyan";
              const displayDesc = isAgent ? cmd.description.replace("[agent] ", "") : cmd.description;
              return (
                <Text key={cmd.name}>
                  <Text dimColor={!isSelected}>{"  "}</Text>
                  <Text color={isSelected ? selectedColor : undefined} bold={isSelected} inverse={isSelected}>
                    {` /${cmd.name} `}
                  </Text>
                  {isAgent && <Text dimColor color={isSelected ? "magenta" : undefined}>[agent] </Text>}
                  <Text dimColor={!isSelected} color={isSelected ? "white" : undefined}> {displayDesc}</Text>
                </Text>
              );
            })}
            {total > maxVisible && (
              <Text dimColor>{"  "}{scrollStart + 1}-{Math.min(scrollStart + maxVisible, total)} of {total}</Text>
            )}
          </Box>
        );
      })()}
      {hasAgentArgSuggestions && (
        <Box flexDirection="column">
          {matchingAgentArgs.map((agent, i) => {
            const isSelected = i === selectedSuggestion;
            return (
              <Text key={agent.name}>
                <Text dimColor={!isSelected}>{"  "}</Text>
                <Text color={isSelected ? "magenta" : undefined} bold={isSelected} inverse={isSelected}>
                  {` ${agent.name} `}
                </Text>
                <Text dimColor={!isSelected} color={isSelected ? "white" : undefined}> {agent.description}</Text>
              </Text>
            );
          })}
        </Box>
      )}
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
          <Text dimColor>  {formatKeybinding(keybindings, "submit")} to send · {formatUsableKeybinding(keybindings, "newline", enhancedKeyboard)} for newline</Text>
        </Box>
      )}
    </Box>
  );
}
