import type { SessionRecord } from "../config/history.js";
import { deleteSession, renameSession } from "../config/history.js";

export async function pickSession(sessions: SessionRecord[]): Promise<SessionRecord | null> {
  if (sessions.length === 0) return null;

  const items = sessions.slice(0, 20);
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

  let totalLinesRendered = 0;

  function render() {
    // Move cursor up to overwrite previous output
    if (totalLinesRendered > 0) {
      process.stdout.write(`\x1b[${totalLinesRendered}A\x1b[G`);
    }

    const lines: string[] = [];
    lines.push("\x1b[1;36m  Resume Session\x1b[0m");
    lines.push("\x1b[2m  ↑↓ navigate · Enter select · D delete · M/R rename · Esc cancel\x1b[0m");
    lines.push("");

    const scrollStart = Math.max(0, Math.min(selected - Math.floor(pageSize / 2), items.length - pageSize));
    const scrollEnd = Math.min(scrollStart + pageSize, items.length);

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
      lines.push("");
      lines.push(`\x1b[2m  ${scrollStart + 1}-${scrollEnd} of ${items.length}\x1b[0m`);
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

        // Esc cancels and returns to the list without renaming.
        if (input === "\x1b") {
          returnToList();
          return;
        }

        // Ctrl-C exits the whole picker, matching the list handler.
        if (input === "\x03") {
          stdin.removeListener("data", onRenameInput);
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

        // Append printable characters (skip other control/escape sequences).
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

    function onData(data: Buffer) {
      const key = data.toString();

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
