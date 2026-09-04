import React, { useState, useRef, useEffect } from "react";
import stringWidth from "string-width";
import { Box, Text, useInput, useStdin, useStdout, type DOMElement, type MouseEventData } from "../ink/index.js";
import { KeybindingResolver, PROMPT_ACTIONS, formatKeybinding, formatUsableKeybinding, normalizeKeyEvent, type Keybindings } from "../config/keybindings.js";
import { loadPromptHistory, savePromptHistory } from "../config/prompt-history.js";
import { writeClipboard } from "../ink/termio/clipboard.js";
import { readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { ATTACHMENT_TILE_RE, attachmentTileScanner, attachmentTileForId } from "../utils/attachments.js";

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
  /**
   * Registers a function that replaces an existing attachment tile (matched
   * by id) in the buffer with literal text — the "paste the same thing again
   * to expand it" gesture. Returns whether a matching tile was found and
   * replaced; the caller falls back to creating a fresh attachment when it
   * returns `false` (the tile was edited away, or never existed here).
   */
  onRegisterExpand?: (fn: (id: number, fullText: string) => boolean) => void;
  /** Opens/previews the attachment a tile click resolved to, instead of moving the caret. */
  onOpenAttachment?: (id: number) => void;
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
 * The attachment tile grammar, immediately before the cursor, with its
 * trailing space. Shared with `ATTACHMENT_TILE_RE` from `utils/attachments.ts`
 * so backspace (which removes a whole tile at a stroke) and click (which
 * refuses to put the caret inside one) never disagree with how a tile was
 * actually built.
 */
const ATTACHMENT_BEFORE_CURSOR_RE = new RegExp(ATTACHMENT_TILE_RE.source + " ?$");


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
  const pattern = attachmentTileScanner();

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

/**
 * Returns the attachment id of the tile that spans `offset`, or `null` if
 * `offset` does not land inside one. A click landing anywhere within a
 * tile — including on its edges — resolves to it; the click handler checks
 * this before falling back to `snapOutOfAttachment`, so opening a tile never
 * also moves the caret.
 */
export function attachmentTileAt(text: string, offset: number): number | null {
  const pattern = attachmentTileScanner();

  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const start = match.index;
    const end = start + match[0].length;
    if (offset >= start && offset < end) {
      const id = Number(match[1]);
      return Number.isFinite(id) ? id : null;
    }
    if (start > offset) break;
  }

  return null;
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
export default function InputPrompt({ value, onChange: emitValue, onSubmit, onPaste, onRemoveAttachment, onClearAttachments, onRegisterInsert, onRegisterExpand, onOpenAttachment, disabled, suppressHistory = false, commands = [], keybindings, enhancedKeyboard = false, resumeUserMessages, agentLock, agentNames = [] }: Props) {
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
  /** Current wrapped lines, kept in a ref so container-level mouse handlers don't need new closures each render. */
  const wrappedLinesRef = useRef<{ text: string; offset: number; isFirst: boolean }[]>([]);

  // ---------------------------------------------------------------------------
  // Text selection state.  Selection is tracked as a pair of buffer offsets
  // (anchor and focus).  When they differ, the range between them is rendered
  // with an inverse highlight and copied to the clipboard on mouse-up.
  // ---------------------------------------------------------------------------

  /** The buffer offset where the selection started (mouse-down or Shift+Arrow origin). */
  const selAnchorRef = useRef<number | null>(null);
  /** The moving end of the selection (where the drag / Shift+Arrow currently is). */
  const selFocusRef = useRef<number | null>(null);
  /** Timestamp of the last mouse-down, for double/triple-click detection. */
  const lastClickTimeRef = useRef(0);
  /** Click count for multi-click detection (1 = single, 2 = double, 3 = triple). */
  const clickCountRef = useRef(0);
  /** Whether a drag is currently in progress (mouse is down and has moved). */
  const draggingRef = useRef(false);

  /** Ordered [start, end) of the current selection, or null if none. */
  const getSelectionRange = (): [number, number] | null => {
    const a = selAnchorRef.current;
    const f = selFocusRef.current;
    if (a === null || f === null || a === f) return null;
    return a < f ? [a, f] : [f, a];
  };

  /** Clear any active selection. */
  const clearSelection = () => {
    selAnchorRef.current = null;
    selFocusRef.current = null;
    draggingRef.current = false;
  };

  /** If there is a selection, delete it, update the buffer, and return true. */
  const deleteSelection = (): boolean => {
    const range = getSelectionRange();
    if (!range) return false;
    const [start, end] = range;
    const val = liveRef.current.value;
    applyEdit(val.slice(0, start) + val.slice(end), start);
    clearSelection();
    return true;
  };

  /**
   * Convert a mouse event's x coordinate into a buffer offset for the given
   * wrapped line.
   */
  const eventToOffset = (event: MouseEventData, wl: { offset: number; text: string }): number => {
    const rows = linesRef.current;
    if (!rows || rows.internal_x === undefined) return wl.offset;
    const column = Math.max(0, event.x - rows.internal_x - prefixWidth);
    let offset = 0;
    let width = 0;
    for (const { segment, index } of segmenter.segment(wl.text)) {
      const nextWidth = width + stringWidth(segment);
      if (column < nextWidth) {
        return wl.offset + (column - width < nextWidth - column ? index : index + segment.length);
      }
      width = nextWidth;
      offset = index + segment.length;
    }
    return wl.offset + offset;
  };

  /**
   * Convert a mouse event into a buffer offset by finding the correct wrapped
   * line from the event's y coordinate.  Used by the container-level
   * onMouseMove and onMouseUp handlers so that drags crossing row boundaries
   * still resolve to the right buffer position.
   */
  const eventToOffsetAuto = (event: MouseEventData, lines: WrappedLine[]): number => {
    const container = linesRef.current;
    if (!container || container.internal_y === undefined) return 0;
    // Each wrapped line is one row tall, starting at container.internal_y.
    const relRow = event.y - container.internal_y;
    const idx = Math.max(0, Math.min(relRow, lines.length - 1));
    const wl = lines[idx]!;
    return eventToOffset(event, wl);
  };

  /**
   * Extract the selected text from the live buffer and copy it to the system
   * clipboard.
   */
  const copySelectionToClipboard = () => {
    const range = getSelectionRange();
    if (!range) return;
    const [start, end] = range;
    const selected = liveRef.current.value.slice(start, end);
    if (selected && stdout) writeClipboard(stdout, selected);
  };

  /**
   * Find the word boundaries around `offset` in the buffer.
   * Returns [start, end) offsets.
   */
  const wordBoundsAt = (offset: number): [number, number] => {
    const val = liveRef.current.value;
    if (offset < 0 || offset >= val.length || !/\w/.test(val[offset]!)) return [offset, offset];
    let start = offset;
    while (start > 0 && /\w/.test(val[start - 1]!)) start--;
    let end = offset;
    while (end < val.length && /\w/.test(val[end]!)) end++;
    return [start, end];
  };

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

  // Register expand function so the parent can turn a pasted-block tile back
  // into its full literal text — the "paste the same thing again" gesture.
  useEffect(() => {
    if (onRegisterExpand) {
      onRegisterExpand((id: number, fullText: string) => {
        const val = liveRef.current.value;
        const match = val.match(attachmentTileForId(id));
        if (!match || match.index === undefined) return false;
        const start = match.index;
        const end = start + match[0].length;
        const cur = liveRef.current.cursor;
        // A caret sitting inside the tile being replaced (or anywhere after
        // it) must shift by the length delta so it lands in the same
        // *logical* spot in the expanded text rather than snapping to
        // wherever the old offset now falls.
        const delta = fullText.length - match[0].length;
        const nextCursor = cur <= start ? cur : cur >= end ? cur + delta : end + delta;
        applyEdit(val.slice(0, start) + fullText + val.slice(end), nextCursor);
        return true;
      });
    }
  }, [onRegisterExpand]);

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

      // Shift+Arrow: extend or create a selection.
      if (key.shift && (key.leftArrow || key.rightArrow)) {
        if (selAnchorRef.current === null) {
          selAnchorRef.current = cursorPos;
          selFocusRef.current = cursorPos;
        }
        const next = key.leftArrow
          ? prevGraphemeOffset(value, cursorPos)
          : nextGraphemeOffset(value, cursorPos);
        selFocusRef.current = next;
        moveCaret(next);
        // If anchor === focus the selection collapsed — clean it up.
        if (selAnchorRef.current === next) clearSelection();
        return;
      }

      if (match.action === "clearInput") {
        clearSelection();
        applyEdit("", 0);
        onClearAttachments?.();
        historyIndexRef.current = -1;
        draftRef.current = null;
        return;
      }
      if (match.action === "deleteWordBackward") {
        if (deleteSelection()) return;
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
        if (key.downArrow || match.action === "historyDown") {
          setSelectedSuggestion((prev) => Math.min(prev + 1, fileSuggestions.length - 1));
          return;
        }
        if (key.upArrow || match.action === "historyUp") {
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
        if (key.tab) {
          const selected = matchingAgentArgs[selectedSuggestion];
          if (selected) {
            const completed = `/agent ${selected.name} `;
            applyEdit(completed, completed.length);
            setSelectedSuggestion(0);
          }
          return;
        }
        if (match.action === "submit") {
          const selected = matchingAgentArgs[selectedSuggestion];
          if (selected && selected.name.toLowerCase() !== agentArgPartial) {
            const completed = `/agent ${selected.name} `;
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

      // Command suggestions navigation
      if (hasCommandSuggestions) {
        if (key.downArrow || match.action === "historyDown") {
          setSelectedSuggestion((prev) => Math.min(prev + 1, matchingCommands.length - 1));
          return;
        }
        if (key.upArrow || match.action === "historyUp") {
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

      // Down arrow — newer history. Only enters when the user is actually
      // browsing history (historyIndexRef >= 0). Without this guard, pressing
      // Down while typing (historyIndexRef === -1) would wipe the input
      // because draftRef is null and the fallback is an empty string.
      if (match.action === "historyDown" && historyIndexRef.current >= 0 && !value.includes("\n") && !suppressHistory) {
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
          // Replace selected text with the newline.
          deleteSelection();
          const v = liveRef.current.value;
          const c = liveRef.current.cursor;
          const before = v.slice(0, c);
          const after = v.slice(c);
          applyEdit(before + "\n" + after, c + 1);
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
      if (key.return || key.escape || key.upArrow || key.downArrow) {
        clearSelection();
        return;
      }

      if (key.backspace) {
        if (deleteSelection()) {
          setSelectedSuggestion(0);
          return;
        }
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
        if (deleteSelection()) {
          setSelectedSuggestion(0);
          return;
        }
        if (cursorPos < value.length) {
          const next = nextGraphemeOffset(value, cursorPos);
          applyEdit(value.slice(0, cursorPos) + value.slice(next), cursorPos);
          setSelectedSuggestion(0);
        }
        return;
      }

      if (key.leftArrow) {
        clearSelection();
        moveCaret(prevGraphemeOffset(value, cursorPos));
        return;
      }
      if (key.rightArrow) {
        clearSelection();
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
        // If text is selected, replace it with the typed character.
        deleteSelection();
        const v = liveRef.current.value;
        const c = liveRef.current.cursor;
        const before = v.slice(0, c);
        const after = v.slice(c);
        applyEdit(before + input + after, c + input.length);
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
  const prefixWidth = agentLock ? stringWidth(lockPrefix) : DEFAULT_PREFIX_WIDTH;
  const usable = Math.max(1, cols - prefixWidth);

  interface WrappedLine { text: string; offset: number; isFirst: boolean }
  const wrappedLines: WrappedLine[] = [];
  const rawLines = text.split("\n");
  let globalOffset = 0;
  for (let li = 0; li < rawLines.length; li++) {
    const raw = rawLines[li]!;
    let chunkStart = 0;
    let chunkWidth = 0;
    let hasChunk = false;
    for (const { segment, index } of segmenter.segment(raw)) {
      const segmentWidth = stringWidth(segment);
      if (hasChunk && chunkWidth + segmentWidth > usable) {
        wrappedLines.push({ text: raw.slice(chunkStart, index), offset: globalOffset + chunkStart, isFirst: li === 0 && chunkStart === 0 });
        chunkStart = index;
        chunkWidth = 0;
        hasChunk = false;
      }
      chunkWidth += segmentWidth;
      hasChunk = true;
    }
    if (hasChunk || raw === "") {
      wrappedLines.push({ text: raw.slice(chunkStart), offset: globalOffset + chunkStart, isFirst: li === 0 && chunkStart === 0 });
    }
    globalOffset += raw.length + 1;
  }
  if (wrappedLines.length === 0) wrappedLines.push({ text: "", offset: 0, isFirst: true });
  wrappedLinesRef.current = wrappedLines;

  const isMultiline = rawLines.length > 1 || wrappedLines.length > 1;

  // ---------------------------------------------------------------------------
  // Mouse handlers for caret placement and drag-to-select.
  //
  // Which row was hit comes from the handler being bound to that row, not from
  // the mouse's `y`. The two do not agree: a frame taller than the terminal has
  // scrolled by the time it is on screen, so a row's laid-out `y` is not the
  // terminal row it is printed on, and subtracting one from the other is off by
  // however far the frame scrolled. Nothing scrolls sideways, so `x` is sound.
  //
  // The wrapped line already knows the buffer offset it starts at — the same
  // table the caret is drawn from, so what the user aims at and what they get
  // are the same thing by construction, wrapping and all.
  // ---------------------------------------------------------------------------

  /** Mouse-down: start a potential selection. */
  const handleRowMouseDown = (line: WrappedLine) => (event: MouseEventData) => {
    const offset = snapOutOfAttachment(text, eventToOffset(event, line));
    const now = Date.now();
    const MULTI_CLICK_MS = 400;

    if (now - lastClickTimeRef.current < MULTI_CLICK_MS) {
      clickCountRef.current = (clickCountRef.current % 3) + 1;
    } else {
      clickCountRef.current = 1;
    }
    lastClickTimeRef.current = now;

    if (clickCountRef.current === 2) {
      // Double-click: select the word under the cursor.
      const [start, end] = wordBoundsAt(offset);
      if (start !== end) {
        selAnchorRef.current = start;
        selFocusRef.current = end;
        moveCaret(end);
      }
    } else if (clickCountRef.current === 3) {
      // Triple-click: select the entire buffer (like a single "line" for the prompt).
      selAnchorRef.current = 0;
      selFocusRef.current = text.length;
      moveCaret(text.length);
    } else {
      // Single click: begin a potential drag selection.
      selAnchorRef.current = offset;
      selFocusRef.current = offset;
      draggingRef.current = false;
    }

    event.stopPropagation?.();
  };

  /**
   * Mouse-move (drag) on the container: extend the selection from the anchor.
   * This handler lives on the parent `<Box>` wrapping all rows so that a drag
   * that crosses wrapped-line boundaries still resolves correctly.
   */
  const handleContainerMouseMove = (event: MouseEventData) => {
    if (selAnchorRef.current === null) return;
    const offset = snapOutOfAttachment(liveRef.current.value, eventToOffsetAuto(event, wrappedLinesRef.current));
    draggingRef.current = true;
    selFocusRef.current = offset;
    moveCaret(offset);
    event.stopPropagation?.();
  };

  /**
   * Mouse-up on the container: copy any active selection to the clipboard.
   * Unlike `onClick` (which requires press and release on the same node),
   * `onMouseUp` fires on every release regardless of where the press started,
   * so cross-row drag selections are properly handled.
   */
  const handleContainerMouseUp = (event: MouseEventData) => {
    if (draggingRef.current) {
      copySelectionToClipboard();
      draggingRef.current = false;
    } else if (clickCountRef.current >= 2) {
      // Double/triple-click: selection was set in mouseDown, copy now.
      copySelectionToClipboard();
    }
    event.stopPropagation?.();
  };

  /**
   * Click (press + release on the same node): opens the attachment under the
   * click if there is one, otherwise positions the caret. Selection copy is
   * handled by the container-level mouseUp handler.
   */
  const handleRowClick = (line: WrappedLine) => (event: MouseEventData) => {
    if (!draggingRef.current && clickCountRef.current <= 1) {
      const rawOffset = eventToOffset(event, line);
      const tileId = onOpenAttachment ? attachmentTileAt(text, rawOffset) : null;
      if (tileId !== null) {
        onOpenAttachment!(tileId);
        event.stopPropagation?.();
        return;
      }
      const offset = snapOutOfAttachment(text, rawOffset);
      clearSelection();
      moveCaret(offset);
    }
    event.stopPropagation?.();
  };

  return (
    // `flexGrow` so the rows span the full width they are drawn across rather
    // than shrink-wrapping the text: the blank space to the right of a line is
    // where anyone clicks to put the caret at its end, and a box that stops at
    // the last character is not there to be clicked.
    <Box flexDirection="column" flexGrow={1}>
      <Box
        flexDirection="column"
        ref={linesRef}
        onMouseMove={handleContainerMouseMove}
        onMouseUp={handleContainerMouseUp}
      >
      {wrappedLines.map((wl, i) => {
        const lineStart = wl.offset;
        const lineEnd = lineStart + wl.text.length;
        const isLastLine = i === wrappedLines.length - 1;
        const cursorInLine = cursorPos >= lineStart && (isLastLine ? cursorPos <= lineEnd : cursorPos < lineEnd);

        const renderPrefix = (isFirst: boolean) => {
          if (!isFirst) return <Text dimColor>{"  "}</Text>;
          if (agentLock) return <Text bold color="magenta">{lockPrefix}</Text>;
          return <Text bold color="green">{"❯ "}</Text>;
        };

        // Selection range clamped to this wrapped line.
        const sel = getSelectionRange();
        const selStart = sel ? Math.max(sel[0] - lineStart, 0) : 0;
        const selEnd = sel ? Math.min(sel[1] - lineStart, wl.text.length) : 0;
        const hasSelection = sel !== null && selStart < selEnd;

        const rowHandlers = {
          onClick: handleRowClick(wl),
          onMouseDown: handleRowMouseDown(wl),
        };

        if (!text && wl.isFirst) {
          return (
            <Box key={i} {...rowHandlers}>
              {renderPrefix(true)}
              <Text inverse> </Text>
              <Text dimColor>{agentLock ? `Ask ${agentLock}...` : "Type a message..."}</Text>
            </Box>
          );
        }

        // When there is a selection, render it with inverse highlighting.
        // The block cursor is suppressed while a selection is active — the
        // selection itself shows where the focus is.
        if (hasSelection) {
          const before = wl.text.slice(0, selStart);
          const selected = wl.text.slice(selStart, selEnd);
          const after = wl.text.slice(selEnd);
          return (
            <Box key={i} {...rowHandlers}>
              {renderPrefix(wl.isFirst)}
              <Text>{before}</Text>
              <Text inverse color="cyan">{selected}</Text>
              <Text>{after}</Text>
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
            <Box key={i} {...rowHandlers}>
              {renderPrefix(wl.isFirst)}
              <Text>{before}</Text>
              <Text inverse>{ch}</Text>
              <Text>{after}</Text>
            </Box>
          );
        }

        return (
          <Box key={i} {...rowHandlers}>
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
