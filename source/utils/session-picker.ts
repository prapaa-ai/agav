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

    // Pad to a fixed height so cursor math is stable across re-renders
    const fixedHeight = pageSize + 6;
    while (lines.length < fixedHeight) lines.push("");

    const output = lines.map((l) => `\x1b[2K${l}`).join("\n") + "\n";
    process.stdout.write(output);
    totalLinesRendered = fixedHeight + 1;
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

      function returnToList() {
        stdin.removeListener("data", onRenameInput);
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
        const input = renameData.toString();

        // A chunk starting with ESC is either the Esc key or a terminal
        // escape sequence (arrow keys, function keys, etc.). A bare ESC cancels
        // and returns to the list; longer sequences are control input, not
        // text, so drop them instead of appending their bytes (e.g. "[A") as
        // literal characters into the rename buffer.
        if (input[0] === "\x1b") {
          if (input.length === 1) returnToList();
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

    // Parse an SGR mouse report (mode 1006): "\x1b[<b;x;yM" (press) or
    // "...m" (release). Returns the decoded event, or null if the chunk isn't
    // a mouse report. Only the low button bits and the Y coordinate matter
    // here — X is ignored since a click anywhere on a row selects it.
    function parseMouse(
      seq: string,
    ): { button: number; y: number; release: boolean } | null {
      const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(seq);
      if (!m) return null;
      return {
        button: Number(m[1]),
        y: Number(m[3]),
        release: m[4] === "m",
      };
    }

    function handleMouse(ev: {
      button: number;
      y: number;
      release: boolean;
    }): void {
      // Wheel events set bit 6 (button codes 64 = up, 65 = down) and report on
      // press only. Scroll moves the selection so the viewport follows it,
      // reusing the same scrolling math as the arrow keys.
      if (ev.button === 64) {
        selected = Math.max(0, selected - 1);
        render();
        return;
      }
      if (ev.button === 65) {
        selected = Math.min(items.length - 1, selected + 1);
        render();
        return;
      }

      // Left-button press (code 0) on a session row selects it. Ignore the
      // release event so a single click doesn't fire twice. Map the 1-based
      // terminal row to an item index via the header offset and the currently
      // visible window.
      if (ev.button === 0 && !ev.release) {
        const rowIndex = ev.y - 1 - HEADER_LINES; // 0-based offset into visible rows
        if (rowIndex < 0) return;
        const idx = visibleStart + rowIndex;
        if (idx < visibleStart || idx >= visibleEnd) return;
        selected = idx;
        render();
      }
    }

    function onData(data: Buffer) {
      const key = data.toString();

      // Mouse reports arrive as their own chunk and start with "\x1b[<". Handle
      // them first so their bytes are never mistaken for keyboard input.
      const mouse = parseMouse(key);
      if (mouse) {
        handleMouse(mouse);
        return;
      }

      if (key === "\x1b" || key === "q") {
        cleanup();
        resolve(null);
        return;
      }

      // Handle Enter: \r, \n, or \r\n as a single chunk.
      // Only drain a trailing \n when we got a bare \r — if the terminal
      // delivered \r\n together the newline is already consumed.
      if (key === "\r") {
        cleanup(true);
        resolve(items[selected]!);
        return;
      }

      if (key === "\n" || key === "\r\n") {
        cleanup();
        resolve(items[selected]!);
        return;
      }

      if (key === "\x1b[A" || key === "k") {
        selected = Math.max(0, selected - 1);
        render();
        return;
      }

      if (key === "\x1b[B" || key === "j") {
        selected = Math.min(items.length - 1, selected + 1);
        render();
        return;
      }

      if (key === "d" || key === "D") {
        if (items.length === 0) return;
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
        return;
      }

      if (key === "m" || key === "M" || key === "r" || key === "R") {
        const selectedSession = items[selected];
        if (!selectedSession) return;
        // Hand input over to the raw-mode rename editor. Staying in raw mode
        // (instead of switching to cooked line input) lets us intercept Esc as
        // a discrete cancel key so the user can return to the list without
        // being forced to submit a name change.
        stdin.removeListener("data", onData);
        openRenameEditor(selectedSession);
        return;
      }

      if (key === "\x03") {
        cleanup();
        process.exit(0);
      }
    }

    stdin.on("data", onData);
  });
}
