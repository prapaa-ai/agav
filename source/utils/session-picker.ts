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

  // Switch to alternate screen buffer and hide cursor
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[H");

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
    function drainTrailingNewline() {
      // Some terminals send \r\n for Enter. After handling \r we need to
      // swallow the trailing \n so it doesn't leak into the next input handler
      // (e.g. Ink), which would cause a phantom empty submission.
      const onDrain = (chunk: Buffer) => {
        const s = chunk.toString();
        if (s !== "\n") {
          // Not a trailing newline — put it back by re-emitting
          stdin.emit("data", chunk);
        }
        stdin.removeListener("data", onDrain);
      };
      stdin.once("data", onDrain);
      // If nothing arrives within 50ms, stop waiting
      setTimeout(() => stdin.removeListener("data", onDrain), 50);
    }

    function cleanup(drainLF = false) {
      stdin.removeListener("data", onData);
      if (drainLF) drainTrailingNewline();
      stdin.setRawMode(wasRaw ?? false);
      // Restore main screen buffer and show cursor
      process.stdout.write("\x1b[?1049l\x1b[?25h");
    }

    function onData(data: Buffer) {
      const key = data.toString();

      if (key === "\x1b" || key === "q") {
        cleanup();
        resolve(null);
        return;
      }

      if (key === "\r") {
        cleanup(true);
        resolve(items[selected]!);
        return;
      }

      if (key === "\n") {
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
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        // Clear screen for rename prompt
        process.stdout.write("\x1b[2J\x1b[H\x1b[?25h");
        totalLinesRendered = 0;
        process.stdout.write(`  Rename session "${selectedSession.title}"\n  New name: `);
        const onRenameInput = (renameData: Buffer) => {
          stdin.removeListener("data", onRenameInput);
          stdin.setRawMode(true);
          process.stdout.write("\x1b[?25l");
          const name = renameData.toString().trim();
          void renameSession(selectedSession.id, name).then((renamed) => {
            if (renamed) items[selected] = renamed;
            process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");
            totalLinesRendered = 0;
            stdin.on("data", onData);
            render();
          }).catch(() => {
            process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");
            totalLinesRendered = 0;
            stdin.on("data", onData);
            render();
          });
        };
        stdin.once("data", onRenameInput);
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
