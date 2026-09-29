import type { SessionRecord } from "../config/history.js";
import { deleteSession, renameSession } from "../config/history.js";

export interface PickSessionOptions {
  /**
   * Bounded recovery window (ms) for a mouse report that begins but never sends
   * its terminator, after which the buffered bytes are discarded so input never
   * wedges. Exposed mainly so tests can shorten it. Defaults to 2000ms.
   */
  mouseRecoveryMs?: number;
}

export async function pickSession(
  sessions: SessionRecord[],
  options: PickSessionOptions = {},
): Promise<SessionRecord | null> {
  if (sessions.length === 0) return null;

  // Keep the full list navigable. Older builds capped this to the 20 most
  // recent sessions, which silently hid everything else with no way to reach
  // it. The viewport below already scrolls through more items than fit on
  // screen, so there's no reason to truncate the backing list.
  const items = sessions.slice();
  let selected = 0;

  // Current terminal width. Read on every render (not cached at startup) so a
  // mid-session shrink still clamps lines to the live width instead of wrapping.
  function currentCols(): number {
    return process.stdout.columns || 80;
  }

  // Number of session rows that fit given the current terminal height. Recomputed
  // on every render (not cached at startup) so a mid-session resize keeps the
  // viewport — and the selected row — within what is actually drawn. The 6-line
  // reserve covers the 3 header lines, the 2-line footer, and one pad line.
  function currentPageSize(): number {
    const rows = process.stdout.rows || 21;
    return Math.min(items.length, Math.max(1, rows - 6));
  }

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  // Clear the current buffer and hide the cursor. Deliberately not DECSET 1049:
  // the app is already on the alternate screen, and 1049 is not nestable — the
  // matching 1049l on the way out would drop the whole app back to the main
  // buffer, restoring the terminal's native scrollbar for the rest of the
  // session. The caller suspends Ink around this, so the screen is ours.
  process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");

  // Enable mouse reporting so users can scroll the list and click a row to
  // select it. 1000 = button press/release events, 1006 = SGR extended
  // coordinates (avoids the 223-column limit of the legacy encoding). Both
  // MUST be disabled on every exit path (see disableMouse) or the host
  // terminal keeps emitting mouse escape sequences into whatever runs next.
  let mouseEnabled = false;
  function enableMouse() {
    process.stdout.write("\x1b[?1000h\x1b[?1006h");
    mouseEnabled = true;
  }
  function disableMouse() {
    if (!mouseEnabled) return;
    process.stdout.write("\x1b[?1006l\x1b[?1000l");
    mouseEnabled = false;
  }
  enableMouse();

  let totalLinesRendered = 0;

  // The three header lines (title, hint, blank) sit above the first session
  // row. Mouse clicks map a 1-based terminal row to an item index using this
  // offset, so it must match the number of header lines pushed in render().
  const HEADER_LINES = 3;

  // Index of the first session row currently drawn on screen. Tracked in the
  // outer scope so the mouse handler can translate a click's Y coordinate into
  // the item it landed on. Kept in sync at the end of every render().
  let visibleStart = 0;
  let visibleEnd = 0;

  // Truncate a styled line so its VISIBLE width never exceeds maxWidth,
  // preventing wrap onto a second physical row. ANSI escape sequences (SGR
  // colors, etc.) contribute zero width and are copied through verbatim; when
  // the visible budget runs out a reset ("\x1b[0m") is appended so truncation
  // never leaves color bleeding into later rows. maxWidth is reduced by one so
  // a line exactly as wide as the terminal cannot trip last-column autowrap.
  function clampVisibleWidth(line: string, terminalCols: number): string {
    const budget = Math.max(1, terminalCols - 1);
    let out = "";
    let visible = 0;
    let sawEscape = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === "\x1b") {
        // Copy the whole CSI sequence: ESC [ ... final-byte (0x40–0x7E).
        let j = i + 1;
        if (line[j] === "[") {
          j++;
          while (j < line.length) {
            const code = line.charCodeAt(j);
            if (code >= 0x40 && code <= 0x7e) break;
            j++;
          }
        }
        out += line.slice(i, j + 1);
        i = j;
        sawEscape = true;
        continue;
      }
      if (visible >= budget) {
        // Out of visible room; stop before adding more printable characters.
        return sawEscape ? out + "\x1b[0m" : out;
      }
      out += ch;
      visible++;
    }
    return out;
  }

  function render() {
    // Move cursor up to overwrite previous output
    if (totalLinesRendered > 0) {
      process.stdout.write(`\x1b[${totalLinesRendered}A\x1b[G`);
    }

    const pageSize = currentPageSize();
    const cols = currentCols();

    const total = items.length;
    const countLabel = `${total} session${total === 1 ? "" : "s"}`;
    const lines: string[] = [];
    lines.push(`\x1b[1;36m  Resume Session\x1b[0m \x1b[2m(${countLabel})\x1b[0m`);
    lines.push("\x1b[2m  ↑↓/scroll/click select · Enter resume · D delete · M/R rename · Esc cancel\x1b[0m");
    lines.push("");

    // Center the selection in the viewport, clamped so we never scroll past the
    // ends. Because pageSize tracks the live terminal height, the selected row
    // is always inside [scrollStart, scrollEnd) even after the window shrinks.
    const scrollStart = Math.max(0, Math.min(selected - Math.floor(pageSize / 2), items.length - pageSize));
    const scrollEnd = Math.min(scrollStart + pageSize, items.length);
    visibleStart = scrollStart;
    visibleEnd = scrollEnd;

    const msgsCol = 8;  // "999 msgs"
    const dateCol = 22; // "7/29/2026, 12:28 PM"
    const idCol = 10;   // "9d166168"
    const metaWidth = msgsCol + 3 + dateCol + 3 + idCol; // " · " separators
    const prefixLen = 4; // "  ❯ " or "    "
    const titleCol = Math.min(50, Math.max(20, cols - prefixLen - metaWidth - 2));

    function sanitizeTitle(raw: string, maxLen: number): string {
      let result = "";
      for (const ch of raw) {
        const code = ch.codePointAt(0)!;
        if (code >= 0x20 && code <= 0x7E) {
          result += ch;
        } else if (code === 0x2018 || code === 0x2019) {
          result += "'";
        } else if (code === 0x201C || code === 0x201D) {
          result += '"';
        } else if (code === 0x2014) {
          result += "-";
        } else if (code === 0x2026) {
          result += "...";
        } else {
          result += "?";
        }
        if (result.length >= maxLen) break;
      }
      return result.length > maxLen ? result.slice(0, maxLen) : result.padEnd(maxLen);
    }

    for (let i = scrollStart; i < scrollEnd; i++) {
      const s = items[i]!;
      const isSel = i === selected;
      const date = new Date(s.createdAt).toLocaleString();
      const msgs = `${s.messages.length} msgs`.padStart(msgsCol);
      const id = s.id.slice(0, 8);
      const rawTitle = s.title.replace(/\n/g, " ");
      const title = sanitizeTitle(rawTitle, titleCol);
      const suffix = `  ${msgs} · ${date} · ${id}`;

      if (isSel) {
        lines.push(`  \x1b[32m❯\x1b[0m \x1b[1m${title}\x1b[0m\x1b[2m${suffix}\x1b[0m`);
      } else {
        lines.push(`\x1b[2m    ${title}${suffix}\x1b[0m`);
      }
    }

    if (items.length > pageSize) {
      const more = items.length - scrollEnd;
      const above = scrollStart;
      const hint =
        above > 0 && more > 0
          ? `  ↑ ${above} more · ${more} more ↓`
          : more > 0
            ? `  ${more} more ↓`
            : above > 0
              ? `  ↑ ${above} more`
              : "";
      lines.push("");
      lines.push(
        `\x1b[2m  showing ${scrollStart + 1}-${scrollEnd} of ${items.length}${hint}\x1b[0m`,
      );
    }

    // Clamp every line to the terminal width BEFORE writing. A line wider than
    // the terminal wraps onto a second physical row, which both scrolls the
    // supposedly height-limited frame and desyncs the click-to-row mapping
    // (one logical line would no longer equal one screen row). ANSI SGR codes
    // are zero-width, so truncate by visible characters while copying escape
    // sequences through untouched, then reset styling at the cut.
    const clamped = lines.map((l) => clampVisibleWidth(l, cols));

    // Pad to a fixed height so cursor math is stable across re-renders. The
    // block is written WITHOUT a trailing newline: emitting one after the last
    // line would push the cursor past the bottom of the terminal and scroll
    // the whole display up a row, which then breaks the click-to-row mapping
    // below (the first session would no longer sit at HEADER_LINES + 1). Cap
    // the height at the terminal size for the same reason.
    const rows = process.stdout.rows ?? pageSize + 6;
    const fixedHeight = Math.min(pageSize + 6, rows);
    while (clamped.length < fixedHeight) clamped.push("");
    if (clamped.length > fixedHeight) clamped.length = fixedHeight;

    const output = clamped.map((l) => `\x1b[2K${l}`).join("\n");
    process.stdout.write(output);
    // The block spans `fixedHeight` lines joined by `fixedHeight - 1` newlines,
    // so the cursor now rests `fixedHeight - 1` rows below the top. Move back
    // up exactly that many on the next render to overwrite in place.
    totalLinesRendered = fixedHeight - 1;
  }

  render();

  return new Promise((resolve) => {
    // Repaint immediately when the terminal is resized (SIGWINCH). Only active
    // while the list is on screen — the rename editor toggles this off so a
    // resize there doesn't paint the list over the prompt. A resize can scramble
    // the cursor, so reset the overwrite counter and re-home before repainting.
    let listActive = true;
    function onResize() {
      if (!listActive) return;
      totalLinesRendered = 0;
      process.stdout.write("\x1b[2J\x1b[H");
      render();
    }
    process.stdout.on("resize", onResize);
    function removeResizeListener() {
      process.stdout.removeListener("resize", onResize);
    }

    function restoreRawMode() {
      stdin.setRawMode(wasRaw ?? false);
    }

    function drainTrailingNewline() {
      // Some terminals send \r\n for Enter. After handling \r we need to
      // swallow the trailing \n so it doesn't leak into the next input handler
      // (e.g. Ink), which would cause a phantom empty submission.
      // Raw mode must stay active while draining so the \n arrives immediately
      // instead of being line-buffered in cooked mode.
      const timer = setTimeout(() => {
        stdin.removeListener("data", onDrain);
        restoreRawMode();
      }, 50);
      const onDrain = (chunk: Buffer) => {
        clearTimeout(timer);
        const s = chunk.toString();
        if (s !== "\n") {
          // Not a trailing newline — put it back by re-emitting after
          // restoring raw mode so downstream handlers see the right state.
          restoreRawMode();
          stdin.emit("data", chunk);
        } else {
          restoreRawMode();
        }
      };
      stdin.once("data", onDrain);
    }

    let disposeRenameEditor: (() => void) | null = null;

    function cleanup(drainLF = false) {
      disposeRenameEditor?.();
      stdin.removeListener("data", onData);
      removeResizeListener();
      // Cancel any armed Esc-flush timer so it can't fire after we've torn down.
      clearPendingTimer();
      // Turn mouse reporting off before Ink resumes; otherwise the terminal
      // keeps sending mouse escape sequences that would leak into the app.
      disableMouse();
      if (drainLF) {
        // Defer raw mode restoration until the trailing \n is drained
        drainTrailingNewline();
      } else {
        restoreRawMode();
      }
      // Leave the screen blank; whoever suspended Ink repaints on resume.
      process.stdout.write("\x1b[2J\x1b[H");
    }

    // Raw-mode line editor for renaming a session. Unlike cooked input, this
    // lets Esc cancel and return to the list without applying any change.
    // `carryOver` holds bytes left in the same chunk after the M/R key (e.g. a
    // partial mouse report) that the editor must consume rather than drop.
    function openRenameEditor(session: SessionRecord, carryOver = "") {
      // The proposed name as an array of characters (grapheme-agnostic; good
      // enough for a session name) and the caret position within it. Editing
      // happens AT the caret so left/right arrows, Home/End, and mid-string
      // insert/delete all work — not just append/backspace at the end.
      const chars: string[] = [];
      let cursor = 0;
      const nameOf = () => chars.join("");
      // Holds the incomplete tail of a mouse report split across chunks. Mouse
      // reporting is disabled below so no NEW reports start, but a report already
      // in flight when the editor opened (or carried over from the trigger
      // chunk) can still arrive fragmented — we buffer the head and swallow the
      // continuation instead of appending it to the proposed name.
      let pendingRenameSeq = "";
      let renameRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

      // The list is no longer on screen: stop the resize handler from painting
      // it over the rename prompt.
      listActive = false;

      // Turn mouse reporting off for the duration of the editor.
      disableMouse();

      function clearRenameRecoveryTimer() {
        if (renameRecoveryTimer !== null) {
          clearTimeout(renameRecoveryTimer);
          renameRecoveryTimer = null;
        }
      }

      function disposeEditor() {
        clearRenameRecoveryTimer();
        pendingRenameSeq = "";
        stdin.removeListener("data", onRenameInput);
        disposeRenameEditor = null;
      }
      disposeRenameEditor = disposeEditor;

      function returnToList() {
        disposeEditor();
        listActive = true;
        enableMouse();
        process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");
        totalLinesRendered = 0;
        stdin.on("data", onData);
        render();
      }

      // "  New name: " prefix — the name text begins at column 13 (1-based).
      const NAME_PREFIX = "  New name: ";
      const NAME_COL = NAME_PREFIX.length + 1;
      const NAME_ROW = 4; // rows 1-3 are the two header lines + a blank line

      // Full-screen paint. Used only once when the editor opens (and after a
      // resize); per-keystroke updates use renderNameLine to avoid flicker.
      function renderRenamePrompt() {
        process.stdout.write("\x1b[2J\x1b[H\x1b[?25h");
        totalLinesRendered = 0;
        process.stdout.write(
          `\x1b[1;36m  Rename session\x1b[0m "${session.title}"\r\n` +
            `\x1b[2m  Enter save · Esc cancel / back\x1b[0m\r\n` +
            `\r\n` +
            NAME_PREFIX,
        );
        renderNameLine();
      }

      // Redraw ONLY the name line in place and reposition the caret. Rewriting a
      // single line (instead of clearing and repainting the whole screen on
      // every key) removes the flicker. Absolute addressing is safe because the
      // frame always starts at terminal row 1 (renderRenamePrompt homed it).
      function renderNameLine() {
        const name = nameOf();
        process.stdout.write(
          `\x1b[${NAME_ROW};1H` + // move to the name row, column 1
            "\x1b[2K" + // clear the line
            NAME_PREFIX +
            name +
            `\x1b[${NAME_ROW};${NAME_COL + cursor}H`, // place caret at the edit point
        );
      }

      // Dispatch one keyboard token (mouse reports already stripped upstream).
      // Returns true if the editor closed so the caller stops draining.
      function handleRenameToken(token: string): boolean {
        // Escape sequences: a lone ESC cancels; cursor-movement/edit sequences
        // are handled here; anything else (function keys, etc.) is ignored so
        // its bytes never land in the name.
        if (token[0] === "\x1b") {
          if (token.length === 1) {
            returnToList();
            return true;
          }
          // Left / right arrows move the caret; Home/End jump to the ends;
          // Delete (CSI 3~) removes the character AT the caret. Support both the
          // CSI-with-final-letter forms and the numeric "~" forms terminals send.
          switch (token) {
            case "\x1b[D": // ←
              if (cursor > 0) { cursor--; renderNameLine(); }
              return false;
            case "\x1b[C": // →
              if (cursor < chars.length) { cursor++; renderNameLine(); }
              return false;
            case "\x1b[H": // Home
            case "\x1b[1~":
            case "\x1bOH":
              if (cursor !== 0) { cursor = 0; renderNameLine(); }
              return false;
            case "\x1b[F": // End
            case "\x1b[4~":
            case "\x1bOF":
              if (cursor !== chars.length) { cursor = chars.length; renderNameLine(); }
              return false;
            case "\x1b[3~": // Delete (forward)
              if (cursor < chars.length) { chars.splice(cursor, 1); renderNameLine(); }
              return false;
            default:
              return false; // unknown escape sequence — ignore
          }
        }

        // Ctrl-C exits the whole picker, matching the list handler.
        if (token === "\x03") {
          cleanup();
          process.exit(0);
        }

        // Enter (\r, \n, or \r\n) submits. An empty/whitespace name is treated
        // as a cancel since renameSession rejects blank names anyway.
        if (token === "\r" || token === "\n" || token === "\r\n") {
          const name = nameOf().trim();
          disposeEditor();
          if (!name) {
            returnToList();
            return true;
          }
          void renameSession(session.id, name)
            .then((renamed) => {
              if (renamed) items[selected] = renamed;
            })
            .catch(() => {})
            .finally(() => {
              listActive = true;
              enableMouse();
              process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");
              totalLinesRendered = 0;
              stdin.on("data", onData);
              render();
            });
          return true;
        }

        // Backspace / Delete removes the character BEFORE the caret.
        if (token === "\x7f" || token === "\b") {
          if (cursor > 0) {
            chars.splice(cursor - 1, 1);
            cursor--;
            renderNameLine();
          }
          return false;
        }

        // Insert printable characters AT the caret. Control bytes (< 0x20) and
        // DEL are skipped; escape sequences were already handled above.
        let inserted = false;
        for (const ch of token) {
          const code = ch.codePointAt(0)!;
          if (code >= 0x20 && code !== 0x7f) {
            chars.splice(cursor, 0, ch);
            cursor++;
            inserted = true;
          }
        }
        if (inserted) renderNameLine();
        return false;
      }

      function onRenameInput(renameData: Buffer) {
        // A continuation arrived — stand down the abandoned-report timer.
        clearRenameRecoveryTimer();
        const incoming = renameData.toString();
        // Ctrl-C cannot be part of a mouse report, even if a prefix is pending.
        if (incoming.includes("\x03")) {
          pendingRenameSeq = "";
          handleRenameToken("\x03");
          return;
        }
        let input = pendingRenameSeq + incoming;
        pendingRenameSeq = "";

        // Walk the input, discarding complete mouse reports (mouse actions do
        // nothing in the editor) and dispatching keyboard tokens in between.
        // Multiple reports and a report immediately followed by a keypress are
        // all handled; an incomplete trailing report is buffered for later.
        while (input.length > 0) {
          // A new escape interrupts an abandoned report; do not swallow the
          // cancellation key (or the start of a fresh report) with its prefix.
          const interrupted = /^\x1b\[<[\d;]*(?=\x1b)/.exec(input);
          if (interrupted) input = input.slice(interrupted[0].length);

          // Two Esc presses cancel the editor, then the list. The second one
          // may arrive before the first one's disambiguation timer expires.
          if (input.startsWith("\x1b\x1b")) {
            returnToList();
            onData(Buffer.from(input.slice(1)));
            return;
          }

          const mouseMatch = mouseAtStart.exec(input);
          if (mouseMatch) {
            input = input.slice(mouseMatch[0].length); // drop the whole report
            continue;
          }

          // A recognized but unfinished mouse report: buffer it and wait. Never
          // append it as text. A bounded recovery timer drops an abandoned
          // report; cancellation is handled separately from its continuation.
          if (incompleteMouse.test(input) && input.length <= MAX_PENDING) {
            pendingRenameSeq = input;
            renameRecoveryTimer = setTimeout(() => {
              renameRecoveryTimer = null;
              pendingRenameSeq = ""; // discard the abandoned report
            }, MOUSE_RECOVERY_MS);
            return;
          }

          // As in the list, distinguish a real Esc press from a report split
          // after ESC or CSI. Reuse the timer so every editor exit clears it.
          if (ambiguousEscPrefix.test(input)) {
            pendingRenameSeq = input;
            renameRecoveryTimer = setTimeout(() => {
              renameRecoveryTimer = null;
              const pending = pendingRenameSeq;
              pendingRenameSeq = "";
              handleRenameToken(pending);
            }, ESC_FLUSH_MS);
            return;
          }

          // Split before any escape prefix, including one following text, so
          // a fragmented report need not already contain the full ESC[< head.
          const nextEscape = input.indexOf("\x1b", input.startsWith("\x1b") ? 1 : 0);
          const token = nextEscape === -1 ? input : input.slice(0, nextEscape);
          input = nextEscape === -1 ? "" : input.slice(nextEscape);
          if (handleRenameToken(token)) return; // editor closed
        }
      }

      renderRenamePrompt();
      stdin.on("data", onRenameInput);

      // Feed any bytes carried over from the chunk that triggered the rename
      // through the same handler, so complete/partial mouse reports there are
      // consumed rather than leaking into the name.
      if (carryOver.length > 0) onRenameInput(Buffer.from(carryOver));
    }

    // Parse every SGR mouse report (mode 1006) in a chunk: "\x1b[<b;x;yM"
    // (press) or "...m" (release). Returns them in order. During rapid wheel
    // scrolling the terminal batches several reports into a single stdin chunk
    // (e.g. "\x1b[<65;1;1M\x1b[<65;1;1M"), so a global, un-anchored scan is
    // required — an anchored single-match regex would drop all but nothing.
    // Only the low button bits and the Y coordinate matter here; X is ignored
    // since a click anywhere on a row selects it.
    function parseMouseEvents(
      seq: string,
    ): { button: number; y: number; release: boolean }[] {
      const events: { button: number; y: number; release: boolean }[] = [];
      const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(seq)) !== null) {
        events.push({
          button: Number(m[1]),
          y: Number(m[3]),
          release: m[4] === "m",
        });
      }
      return events;
    }

    // Apply a single mouse event to the selection. Returns true if the
    // selection changed so the caller can coalesce one render for a batch of
    // events instead of repainting per report during rapid scrolling.
    function applyMouseEvent(ev: {
      button: number;
      y: number;
      release: boolean;
    }): boolean {
      // Wheel events set bit 6 (button codes 64 = up, 65 = down) and report on
      // press only. Scroll moves the selection so the viewport follows it,
      // reusing the same scrolling math as the arrow keys.
      if (ev.button === 64) {
        const next = Math.max(0, selected - 1);
        if (next === selected) return false;
        selected = next;
        return true;
      }
      if (ev.button === 65) {
        const next = Math.min(items.length - 1, selected + 1);
        if (next === selected) return false;
        selected = next;
        return true;
      }

      // Left-button press (code 0) on a session row selects it. Ignore the
      // release event so a single click doesn't fire twice. Map the 1-based
      // terminal row to an item index via the header offset and the currently
      // visible window.
      if (ev.button === 0 && !ev.release) {
        const rowIndex = ev.y - 1 - HEADER_LINES; // 0-based offset into visible rows
        if (rowIndex < 0) return false;
        const idx = visibleStart + rowIndex;
        if (idx < visibleStart || idx >= visibleEnd) return false;
        if (idx === selected) return false;
        selected = idx;
        return true;
      }

      return false;
    }

    // Handle one logical keyboard token (already separated from any mouse
    // reports). Returns true if control was handed off — the picker resolved,
    // exited, or switched to the rename editor — so the caller stops draining
    // any remaining input in the current chunk.
    function handleKey(key: string): boolean {
      if (key === "\x1b" || key === "q") {
        cleanup();
        resolve(null);
        return true;
      }

      // Handle Enter: \r, \n, or \r\n as a single token.
      // Only drain a trailing \n when we got a bare \r — if the terminal
      // delivered \r\n together the newline is already consumed.
      if (key === "\r") {
        cleanup(true);
        resolve(items[selected]!);
        return true;
      }

      if (key === "\n" || key === "\r\n") {
        cleanup();
        resolve(items[selected]!);
        return true;
      }

      if (key === "\x1b[A" || key === "k") {
        selected = Math.max(0, selected - 1);
        render();
        return false;
      }

      if (key === "\x1b[B" || key === "j") {
        selected = Math.min(items.length - 1, selected + 1);
        render();
        return false;
      }

      if (key === "d" || key === "D") {
        if (items.length === 0) return false;
        const toDelete = items[selected]!;
        deleteSession(toDelete.id).then((ok) => {
          if (ok) {
            items.splice(selected, 1);
            if (items.length === 0) {
              cleanup();
              resolve(null);
              return;
            }
            if (selected >= items.length) selected = items.length - 1;
            render();
          }
        });
        return false;
      }

      if (key === "m" || key === "M" || key === "r" || key === "R") {
        const selectedSession = items[selected];
        if (!selectedSession) return false;
        // Request the rename editor. onData actually opens it so it can hand
        // over any input left in the current chunk after this key (e.g. the
        // start of a mouse report), which the editor must consume rather than
        // leak into the name. Staying in raw mode lets Esc cancel discretely.
        stdin.removeListener("data", onData);
        renameRequested = selectedSession;
        return true;
      }

      if (key === "\x03") {
        cleanup();
        process.exit(0);
      }

      return false;
    }

    // Buffer for an escape sequence split across stdin chunks. A mouse report
    // (or arrow key) can arrive in pieces at ANY boundary — "\x1b" | "[<65;1;1M",
    // "\x1b[" | "<65;1;1M", "\x1b[<65;1;" | "1M" — so we hold the incomplete
    // head here and prepend it to the next chunk.
    let pendingSeq = "";
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    // Set by handleKey when the M/R key requests the rename editor. onData reads
    // it after dispatch so it can hand any remaining bytes in the chunk to the
    // editor instead of dropping them (see the rename carry-over below).
    let renameRequested: SessionRecord | null = null;
    // Escape-key disambiguation window. A bare "\x1b" / "\x1b[" is ambiguous
    // (Esc key vs. the start of an arrow key or a mouse report). Terminals send
    // the rest of a real sequence within a few ms; a human pressing Esc pauses
    // far longer, so on expiry we treat the buffered prefix as a keypress.
    const ESC_FLUSH_MS = 40;
    // Recovery bound for a RECOGNIZED-but-unfinished mouse report ("\x1b[<...").
    // We never flush such a report into handleKey (its tail could otherwise be
    // parsed as a command); we simply keep waiting for the terminator. This
    // longer window only guards against a peer that starts a report and never
    // finishes it, so a malformed stream can't wedge the buffer permanently.
    const MOUSE_RECOVERY_MS = options.mouseRecoveryMs ?? 2000;
    const MAX_PENDING = 64; // drop obviously malformed/oversized buffers

    // A complete SGR mouse report anchored at the start of the string.
    const mouseAtStart = /^\x1b\[<\d+;\d+;\d+[Mm]/;
    // A recognized but still-incomplete SGR mouse report: the "\x1b[<"
    // introducer has arrived but the terminator ("M"/"m") has not. These are
    // preserved until the terminator (never timed out into a keypress).
    const incompleteMouse = /^\x1b\[<[\d;]*$/;
    // An ambiguous escape prefix that is NOT yet identifiable as a mouse report:
    // a lone "\x1b" or a bare CSI "\x1b[". Subject to the short Esc flush.
    const ambiguousEscPrefix = /^\x1b\[?$/;

    function clearPendingTimer() {
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    }

    function onData(data: Buffer) {
      // A continuation arrived before the flush timer — combine and reprocess.
      clearPendingTimer();
      let input = pendingSeq + data.toString();
      pendingSeq = "";

      // Walk the combined input left to right, peeling off complete mouse
      // reports and dispatching runs of keyboard bytes in between. This keeps
      // batched scroll reports, reports split across chunks, and a report
      // immediately followed by a keypress (e.g. click then Enter) all working.
      let mouseChanged = false;
      while (input.length > 0) {
        const mouseMatch = mouseAtStart.exec(input);
        if (mouseMatch) {
          const events = parseMouseEvents(mouseMatch[0]);
          for (const ev of events) {
            if (applyMouseEvent(ev)) mouseChanged = true;
          }
          input = input.slice(mouseMatch[0].length);
          continue;
        }

        // A recognized-but-unfinished mouse report: keep it until the
        // terminator arrives. Never flush it as a keypress — its tail (e.g. a
        // trailing "M") would otherwise be parsed as a command. A generous
        // recovery timer only drops a report a peer starts but never finishes.
        if (incompleteMouse.test(input) && input.length <= MAX_PENDING) {
          if (mouseChanged) render();
          pendingSeq = input;
          pendingTimer = setTimeout(() => {
            pendingTimer = null;
            pendingSeq = ""; // discard the abandoned report; do NOT dispatch it
          }, MOUSE_RECOVERY_MS);
          return;
        }

        // An ambiguous escape prefix ("\x1b" or "\x1b["): could be the Esc key,
        // an arrow key, or the start of a mouse report. Wait briefly — a real
        // sequence's continuation lands within a few ms; otherwise the short
        // timer fires and we dispatch the prefix as a keypress (a lone Esc then
        // cancels; a bare CSI is a no-op in handleKey).
        if (ambiguousEscPrefix.test(input)) {
          if (mouseChanged) render();
          pendingSeq = input;
          pendingTimer = setTimeout(() => {
            pendingTimer = null;
            const pending = pendingSeq;
            pendingSeq = "";
            if (pending.length > 0) handleKey(pending);
          }, ESC_FLUSH_MS);
          return;
        }

        // Split before escape prefixes too, so a rename key can hand even a
        // bare ESC or CSI remainder to the editor for disambiguation.
        const nextEscape = input.indexOf("\x1b", input.startsWith("\x1b") ? 1 : 0);
        const key = nextEscape === -1 ? input : input.slice(0, nextEscape);
        input = nextEscape === -1 ? "" : input.slice(nextEscape);
        if (mouseChanged) {
          render();
          mouseChanged = false;
        }
        if (handleKey(key)) {
          // Control handed off. If the M/R key opened the rename editor, pass
          // any bytes remaining in this chunk to it — e.g. "r\x1b[<65;1;" leaves
          // a partial mouse report that the editor must consume, not leak into
          // the name.
          if (renameRequested) {
            const session = renameRequested;
            renameRequested = null;
            openRenameEditor(session, input);
          }
          return; // stop draining
        }
      }

      if (mouseChanged) render();
    }

    stdin.on("data", onData);
  });
}
