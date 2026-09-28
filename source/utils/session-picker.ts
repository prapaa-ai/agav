import type { SessionRecord } from "../config/history.js";
import { deleteSession, renameSession } from "../config/history.js";

export async function pickSession(sessions: SessionRecord[]): Promise<SessionRecord | null> {
  if (sessions.length === 0) return null;

  // Keep the full list navigable. Older builds capped this to the 20 most
  // recent sessions, which silently hid everything else with no way to reach
  // it. The viewport below already scrolls through more items than fit on
  // screen, so there's no reason to truncate the backing list.
  const items = sessions.slice();
  let selected = 0;
  const pageSize = Math.min(items.length, process.stdout.rows ? process.stdout.rows - 6 : 15);
  const cols = process.stdout.columns || 80;

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

  function render() {
    // Move cursor up to overwrite previous output
    if (totalLinesRendered > 0) {
      process.stdout.write(`\x1b[${totalLinesRendered}A\x1b[G`);
    }

    const total = items.length;
    const countLabel = `${total} session${total === 1 ? "" : "s"}`;
    const lines: string[] = [];
    lines.push(`\x1b[1;36m  Resume Session\x1b[0m \x1b[2m(${countLabel})\x1b[0m`);
    lines.push("\x1b[2m  ↑↓/scroll/click select · Enter resume · D delete · M/R rename · Esc cancel\x1b[0m");
    lines.push("");

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

    // Pad to a fixed height so cursor math is stable across re-renders. The
    // block is written WITHOUT a trailing newline: emitting one after the last
    // line would push the cursor past the bottom of the terminal and scroll
    // the whole display up a row, which then breaks the click-to-row mapping
    // below (the first session would no longer sit at HEADER_LINES + 1). Cap
    // the height at the terminal size for the same reason.
    const rows = process.stdout.rows ?? pageSize + 6;
    const fixedHeight = Math.min(pageSize + 6, rows);
    while (lines.length < fixedHeight) lines.push("");
    if (lines.length > fixedHeight) lines.length = fixedHeight;

    const output = lines.map((l) => `\x1b[2K${l}`).join("\n");
    process.stdout.write(output);
    // The block spans `fixedHeight` lines joined by `fixedHeight - 1` newlines,
    // so the cursor now rests `fixedHeight - 1` rows below the top. Move back
    // up exactly that many on the next render to overwrite in place.
    totalLinesRendered = fixedHeight - 1;
  }

  render();

  return new Promise((resolve) => {
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

    function cleanup(drainLF = false) {
      stdin.removeListener("data", onData);
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
    function openRenameEditor(session: SessionRecord) {
      let buffer = "";
      // True while the tail of a mouse report split across chunks is still
      // expected. Disabling mouse reporting (below) stops new reports, but a
      // report already in flight when the editor opened can still arrive split
      // — we must swallow its trailing bytes (up to the "M"/"m" terminator)
      // instead of appending them to the proposed name.
      let awaitingMouseTail = false;

      // Turn mouse reporting off for the duration of the editor. Otherwise the
      // terminal keeps emitting SGR reports while the user types, and a report
      // split across chunks (e.g. "\x1b[<65;1;" then "1M") would leak its tail
      // bytes into the proposed name. Re-enabled on every path back to the list.
      disableMouse();

      function returnToList() {
        stdin.removeListener("data", onRenameInput);
        enableMouse();
        process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");
        totalLinesRendered = 0;
        stdin.on("data", onData);
        render();
      }

      function renderRenamePrompt() {
        process.stdout.write("\x1b[2J\x1b[H\x1b[?25h");
        totalLinesRendered = 0;
        process.stdout.write(
          `\x1b[1;36m  Rename session\x1b[0m "${session.title}"\r\n` +
            `\x1b[2m  Enter save · Esc cancel / back\x1b[0m\r\n` +
            `\r\n` +
            `  New name: ${buffer}`,
        );
      }

      function onRenameInput(renameData: Buffer) {
        let input = renameData.toString();

        // Swallow the trailing bytes of a mouse report that was split across
        // chunks before it could be fully dropped. Everything up to and
        // including the "M"/"m" terminator belongs to the report, not the name.
        if (awaitingMouseTail) {
          const term = /[Mm]/.exec(input);
          if (!term) return; // whole chunk is still report body
          awaitingMouseTail = false;
          input = input.slice(term.index + 1);
          if (input.length === 0) return;
        }

        // A chunk starting with ESC is either the Esc key or a terminal
        // escape sequence (arrow keys, function keys, mouse reports, etc.). A
        // bare ESC cancels and returns to the list; longer sequences are
        // control input, not text, so drop them instead of appending their
        // bytes (e.g. "[A") as literal characters into the rename buffer. An
        // unterminated SGR mouse report ("\x1b[<...") means the rest is still
        // coming — remember to swallow that tail from the next chunk.
        if (input[0] === "\x1b") {
          if (input.length === 1) returnToList();
          else if (/^\x1b\[<[\d;]*$/.test(input)) awaitingMouseTail = true;
          return;
        }

        // Ctrl-C exits the whole picker, matching the list handler.
        if (input === "\x03") {
          stdin.removeListener("data", onRenameInput);
          disableMouse();
          restoreRawMode();
          process.stdout.write("\x1b[2J\x1b[H");
          process.exit(0);
        }

        // Enter (\r, \n, or \r\n) submits. An empty/whitespace name is treated
        // as a cancel since renameSession rejects blank names anyway.
        if (input === "\r" || input === "\n" || input === "\r\n") {
          const name = buffer.trim();
          stdin.removeListener("data", onRenameInput);
          if (!name) {
            returnToList();
            return;
          }
          void renameSession(session.id, name)
            .then((renamed) => {
              if (renamed) items[selected] = renamed;
            })
            .catch(() => {})
            .finally(() => {
              enableMouse();
              process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");
              totalLinesRendered = 0;
              stdin.on("data", onData);
              render();
            });
          return;
        }

        // Backspace / Delete removes the last character.
        if (input === "\x7f" || input === "\b") {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            renderRenamePrompt();
          }
          return;
        }

        // Append printable characters only. Control bytes (< 0x20) and DEL are
        // skipped; escape sequences were already handled above.
        let appended = false;
        for (const ch of input) {
          const code = ch.codePointAt(0)!;
          if (code >= 0x20 && code !== 0x7f) {
            buffer += ch;
            appended = true;
          }
        }
        if (appended) renderRenamePrompt();
      }

      renderRenamePrompt();
      stdin.on("data", onRenameInput);
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
        // Hand input over to the raw-mode rename editor. Staying in raw mode
        // (instead of switching to cooked line input) lets us intercept Esc as
        // a discrete cancel key so the user can return to the list without
        // being forced to submit a name change.
        stdin.removeListener("data", onData);
        openRenameEditor(selectedSession);
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
    // head here and prepend it to the next chunk. A bare "\x1b" is ambiguous
    // (it could be the Esc key OR the start of a split sequence), so instead of
    // deciding immediately we arm a short flush timer: if a continuation chunk
    // arrives first it is combined and reprocessed; if the timer fires the
    // buffered bytes are dispatched as-is (a lone "\x1b" then cancels).
    let pendingSeq = "";
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    // Escape-key disambiguation window. Terminals deliver the rest of a real
    // escape sequence within a few ms; a human pressing Esc pauses far longer.
    const ESC_FLUSH_MS = 40;

    // A complete SGR mouse report anchored at the start of the string.
    const mouseAtStart = /^\x1b\[<\d+;\d+;\d+[Mm]/;
    // The entire remaining input is a strict prefix of a still-arriving escape
    // sequence (mouse report or arrow key): "\x1b", "\x1b[", "\x1b[<", or a
    // partially-numbered mouse report. When this matches we wait for more bytes
    // rather than committing to an interpretation.
    const incompleteSeq = /^\x1b(\[(<[\d;]*)?)?$/;

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

        // The remaining input is an unfinished escape sequence. Stash it and
        // wait: either the rest lands in the next chunk, or the flush timer
        // fires and we dispatch it as-is (so a lone Esc still cancels).
        if (incompleteSeq.test(input)) {
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

        // Otherwise take everything up to the next mouse report (or the end)
        // as a single keyboard token and dispatch it.
        const nextMouse = input.indexOf("\x1b[<", input.startsWith("\x1b[<") ? 1 : 0);
        const key = nextMouse === -1 ? input : input.slice(0, nextMouse);
        input = nextMouse === -1 ? "" : input.slice(nextMouse);
        if (mouseChanged) {
          render();
          mouseChanged = false;
        }
        if (handleKey(key)) return; // control handed off; stop draining
      }

      if (mouseChanged) render();
    }

    stdin.on("data", onData);
  });
}
