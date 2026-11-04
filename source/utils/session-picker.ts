import { StringDecoder } from "node:string_decoder";
import stringWidth from "string-width";
import { writeClipboard } from "../ink/termio/clipboard.js";
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
  //
  // `allItems` is the authoritative source (mutated by delete). `items` is the
  // derived VIEW — `allItems` after applying the name filter, project scope,
  // status filter and sort. Navigation, rendering and mouse mapping all index
  // into `items`; `selected` is an index into the view, not the source.
  const allItems = sessions.slice();
  let items: SessionRecord[] = allItems.slice();
  let selected = 0;

  // ── Filter / sort state ──────────────────────────────────────────────────
  // Free-text name filter (req 1): a case-insensitive substring match over the
  // session title. Edited only through the inline search bar — never by stray
  // list keystrokes — so plain shortcuts like "d" (delete) never conflict with
  // typing a query.
  let nameFilter = "";
  // Whether the inline search bar at the top has keyboard focus. When true,
  // printable keys + Backspace edit `nameFilter`; when false, keys act as list
  // shortcuts (d/r/arrows/…). Toggled with "/" (focus) and Esc (blur). The bar
  // itself is ALWAYS rendered so the current query is always visible.
  let searchActive = false;
  // Project scope (req 2): "" means "all projects"; otherwise an exact cwd.
  // Cycled with Tab through the distinct cwds present in the source list.
  let projectScope = "";
  // Status facet (req 4 & 5): cycle all → running → needs-approval.
  type StatusFilter = "all" | "running" | "needs-approval";
  let statusFilter: StatusFilter = "all";
  // Sort key (req 3): recency ("updated", the historical default) or creation.
  type SortKey = "updated" | "created";
  let sortKey: SortKey = "updated";
  let sortRequested = false;

  const ACTIVE_STATUSES = ["starting", "running", "needs-approval"];
  const UNKNOWN_PROJECT = "(unknown project)";

  function projectOf(s: SessionRecord): string {
    return s.cwd ?? s.runtime?.cwd ?? UNKNOWN_PROJECT;
  }
  function isRunning(s: SessionRecord): boolean {
    return !!s.runtime && ACTIVE_STATUSES.includes(s.runtime.status);
  }
  function needsApproval(s: SessionRecord): boolean {
    return s.runtime?.status === "needs-approval" || (s.runtime?.pendingCount ?? 0) > 0;
  }
  function recencyOf(s: SessionRecord): number {
    return Date.parse(s.updatedAt ?? s.createdAt) || 0;
  }

  // Distinct project directories across the full source list, used to cycle the
  // project scope. "All projects" ("") is prepended so Tab always returns to it.
  function projectCycle(): string[] {
    const seen = new Set<string>();
    for (const s of allItems) seen.add(projectOf(s));
    return ["", ...[...seen].sort((a, b) => a.localeCompare(b))];
  }

  // How many sessions in the full list currently need approval — drives the
  // top-of-list CTA banner (req 4) regardless of the active filters.
  function pendingApprovalCount(): number {
    let count = 0;
    for (const item of allItems) if (needsApproval(item)) count++;
    return count;
  }

  // Compact relative age ("3m", "2h", "5d", "3w", "1y") — scans faster and is
  // far shorter than an absolute toLocaleString timestamp, freeing row width for
  // the project and title columns. "now" for < 1 minute.
  function relativeAge(epochMs: number): string {
    if (!epochMs) return "—";
    const sec = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
    if (sec < 60) return "now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d`;
    const wk = Math.floor(day / 7);
    if (wk < 52) return `${wk}w`;
    return `${Math.floor(day / 365)}y`;
  }

  // Shorten a cwd for display: home → "~", and keep only the last two path
  // segments so deeply-nested project paths still fit the project column.
  function abbreviateProject(cwd: string): string {
    if (cwd === UNKNOWN_PROJECT) return cwd;
    const home = process.env.HOME || process.env.USERPROFILE;
    let path = (home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd).replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
    const parts = path.split(/[/\\]/).filter(Boolean);
    if (parts.length > 2) path = "…/" + parts.slice(-2).join("/");
    return path;
  }

  // Recompute the derived view from `allItems` + the active filter/sort state.
  // Keeps the previously-selected session highlighted when it survives the new
  // filter; otherwise clamps to the nearest valid row.
  //
  // Preserve the caller's order on entry. Once the user chooses a sort,
  // calculate either order from current metadata (including after a rename).
  function recomputeView(preserveSession = true) {
    const priorId = preserveSession ? items[selected]?.id : undefined;
    const lower = nameFilter.toLowerCase();
    const filtered = allItems.filter((s) => {
      if (lower && !s.title.toLowerCase().includes(lower)) return false;
      if (projectScope && projectOf(s) !== projectScope) return false;
      if (statusFilter === "running" && !isRunning(s)) return false;
      if (statusFilter === "needs-approval" && !needsApproval(s)) return false;
      return true;
    });
    if (sortRequested) {
      // Parse once per record, not on every sort comparison. Rebuild for each
      // sort so renames and refreshed metadata cannot leave stale cached keys.
      const timestamps = new Map(filtered.map(s => [s, sortKey === "created"
        ? Date.parse(s.createdAt) || 0 : recencyOf(s)]));
      filtered.sort((a, b) => timestamps.get(b)! - timestamps.get(a)!);
    }
    items = filtered;
    const next = priorId ? items.findIndex((s) => s.id === priorId) : -1;
    selected = next !== -1 ? next : Math.max(0, Math.min(selected, items.length - 1));
    if (selected >= items.length) selected = Math.max(0, items.length - 1);
  }
  recomputeView();

  // Current terminal width. Read on every render (not cached at startup) so a
  // mid-session shrink still clamps lines to the live width instead of wrapping.
  function currentCols(): number {
    return process.stdout.columns || 80;
  }

  // Number of session rows the terminal can hold given its height. This is the
  // VIEWPORT CAPACITY — it depends only on the terminal size, never on how many
  // items currently match the filter, so the rendered frame keeps a stable
  // height. If it shrank with the filtered count, a short filtered frame would
  // overwrite fewer lines than the previous tall frame and leave stale rows on
  // screen. The reserve covers the header lines (variable — see headerLineCount),
  // the 2-line footer, and one pad line.
  function currentCapacity(headerLines = headerLineCount()): number {
    const rows = process.stdout.rows || 21;
    return Math.max(1, rows - headerLines - 3);
  }

  // Number of session rows actually DRAWN this frame: never more than match the
  // current filter, and never more than the viewport can hold.
  function currentPageSize(capacity = currentCapacity()): number {
    return Math.min(items.length, capacity);
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
  let operationError: string | undefined;
  let closed = false;
  const deleting = new Set<string>();

  // Header lines sitting above the first session row. Mouse clicks map a 1-based
  // terminal row to an item index using this offset, so it MUST match the number
  // of header lines pushed in render(). The count is dynamic: a one-line CTA
  // banner is added only when some session needs approval (req 4). Layout:
  //   1-3. inline search box (top border, input line, bottom border)
  //   4.   title + count
  //   5.   facet bar ([Tab] Project · [a] Status · [s] Sort)
  //   6.   hint line (or operationError)
  //   7.   CTA banner — ONLY when pendingApprovalCount() > 0
  //   8.   blank spacer
  function headerLineCount(pending = pendingApprovalCount()): number {
    return pending > 0 ? 8 : 7;
  }

  // Index of the first session row currently drawn on screen. Tracked in the
  // outer scope so the mouse handler can translate a click's Y coordinate into
  // the item it landed on. Kept in sync at the end of every render().
  let visibleStart = 0;
  let visibleEnd = 0;

  // On-screen geometry of the bordered search box (1-based terminal coords),
  // updated every render. The mouse handler hit-tests a click against this
  // rectangle to focus the search bar when clicked inside, or blur it when
  // clicked outside. The box spans three terminal rows: top border, the input
  // line, and the bottom border.
  const searchBox = { top: 1, bottom: 3, left: 1, right: 1 };

  // Truncate a styled line so its VISIBLE width never exceeds maxWidth,
  // preventing wrap onto a second physical row. ANSI escape sequences (SGR
  // colors, etc.) contribute zero width and are copied through verbatim; when
  // the visible budget runs out a reset ("\x1b[0m") is appended so truncation
  // never leaves color bleeding into later rows. maxWidth is reduced by one so
  // a line exactly as wide as the terminal cannot trip last-column autowrap.
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const graphemes = (text: string) => Array.from(segmenter.segment(text), s => s.segment);

  function fitCells(text: string, budget: number, pad = false): string {
    // Printable ASCII is exactly one cell per code unit; Unicode still uses
    // grapheme boundaries so emoji and combining sequences stay intact.
    if (/^[\x20-\x7e]*$/.test(text)) {
      const clipped = text.slice(0, budget);
      return pad ? clipped.padEnd(budget) : clipped;
    }
    let out = "";
    let width = 0;
    for (const { segment: ch } of segmenter.segment(text)) {
      const cells = stringWidth(ch);
      if (width + cells > budget) break;
      out += ch;
      width += cells;
    }
    return pad ? out + " ".repeat(Math.max(0, budget - width)) : out;
  }

  function clampVisibleWidth(line: string, terminalCols: number): string {
    const budget = Math.max(1, terminalCols - 1);
    let out = "";
    let visible = 0;
    // Keep SGR sequences intact, but count printable graphemes in terminal cells.
    for (const token of line.split(/(\x1b\[[0-9;?]*[a-zA-Z])/g)) {
      if (token.startsWith("\x1b[")) { out += token; continue; }
      if (/^[\x20-\x7e]*$/.test(token)) {
        const remaining = budget - visible;
        if (token.length > remaining) return out + token.slice(0, remaining) + "\x1b[0m";
        out += token;
        visible += token.length;
        continue;
      }
      for (const { segment: ch } of segmenter.segment(token)) {
        const cells = stringWidth(ch);
        if (visible + cells > budget) return out + "\x1b[0m";
        out += ch;
        visible += cells;
      }
    }
    return out;
  }

  function render() {
    // Move cursor up to overwrite previous output
    if (totalLinesRendered > 0) {
      process.stdout.write(`\x1b[${totalLinesRendered}A\x1b[G`);
    }

    const pending = pendingApprovalCount();
    const headerLines = headerLineCount(pending);
    const capacity = currentCapacity(headerLines);
    const pageSize = currentPageSize(capacity);
    const cols = currentCols();

    const total = items.length;
    const totalAll = allItems.length;
    // Count reflects filtering: "12 of 48" when a filter narrows the list,
    // mirroring the /model picker's "(N of M)" convention.
    const countLabel = total === totalAll
      ? `${total} session${total === 1 ? "" : "s"}`
      : `${total} of ${totalAll}`;
    const lines: string[] = [];

    // Header lines 1-3: the inline search bar, drawn as a visible bordered box
    // pinned to the very top. It is ALWAYS drawn (stable header height) so the
    // query is always visible. A bright cyan border + block caret mark the
    // FOCUSED state; a dim border marks the blurred state. Typing only edits the
    // query while focused, so plain list keys (d, r, …) never leak into it. The
    // box geometry is recorded in `searchBox` so a click can focus it (inside)
    // or blur it (outside) — see the mouse handler.
    //
    // Box width: 2-column left margin, then a border spanning to a right margin,
    // leaving at least a small inner field even on narrow terminals.
    const boxLeft = 2;                                   // 0-based column of "┌"/"└"/"│"
    const boxInnerLeft = boxLeft + 2;                    // 1-based column of first input cell
    const boxWidth = Math.max(12, Math.min(cols - 4, 60)); // total border width incl. corners
    const innerWidth = boxWidth - 2;                     // cells available between the "│"s
    const pad = " ".repeat(boxLeft);
    const borderColor = searchActive ? "\x1b[36m" : "\x1b[2m"; // bright cyan when focused
    // Record geometry (1-based, inclusive) for the mouse hit-test.
    searchBox.top = 1;
    searchBox.bottom = 3;
    searchBox.left = boxLeft + 1;
    searchBox.right = boxLeft + boxWidth;

    // Top border carries the "Search" label; a hint sits on the right when there
    // is room. The label/hint are embedded in the horizontal rule.
    const title = " Search ";
    const topHint = searchActive ? " Esc done " : nameFilter ? " / edit " : " click or / ";
    const dashBudget = Math.max(0, boxWidth - 2 - title.length - topHint.length);
    const topRule = `${borderColor}┌${title}${"─".repeat(dashBudget)}${topHint}┐\x1b[0m`;

    // Middle: the query (or a dim prompt) plus a block caret when focused, inside
    // the vertical borders, padded so the right "│" aligns.
    const caret = searchActive ? "\x1b[7m \x1b[0m" : "";
    const visibleQuery = fitCells(nameFilter, Math.max(0, innerWidth - 1 - (searchActive ? 1 : 0)));
    const queryText = nameFilter
      ? `\x1b[0m${visibleQuery}`
      : searchActive
        ? ""
        : "\x1b[2mfilter by name…\x1b[0m";
    // Visible length of the inner content (caret counts as 1 cell).
    const innerVisible = stringWidth(visibleQuery) + (searchActive ? 1 : 0) + (!nameFilter && !searchActive ? "filter by name…".length : 0);
    const fill = " ".repeat(Math.max(0, innerWidth - 1 - innerVisible));
    const midLine = `${borderColor}│\x1b[0m ${queryText}${caret}${fill}${borderColor}│\x1b[0m`;

    const bottomRule = `${borderColor}└${"─".repeat(boxWidth - 2)}┘\x1b[0m`;

    lines.push(`${pad}${topRule}`);
    lines.push(`${pad}${midLine}`);
    lines.push(`${pad}${bottomRule}`);

    // Header line 4: title + count.
    lines.push(`\x1b[1;36m  Resume Session\x1b[0m \x1b[2m(${countLabel})\x1b[0m`);

    // Header line 5: the facet bar — current Sort/Status/Project values, each
    // prefixed with the key that cycles it (in yellow) so every facet is both
    // visible AND self-documenting. On its own line so nothing clamps off at
    // 80 cols the way it would if appended to the title. The fixed-width facets
    // (Sort, Status) come FIRST and the variable-width Project comes LAST, so if
    // a long project path forces width-clamping it only trims the project value
    // — never a key hint.
    const projectChip = projectScope ? abbreviateProject(projectScope) : "all";
    const statusChip = statusFilter === "all" ? "all" : statusFilter;
    const sortChip = sortKey === "updated" ? "updated ↓" : "created ↓";
    lines.push(
      `\x1b[2m  [\x1b[0m\x1b[33ms\x1b[0m\x1b[2m] Sort: \x1b[0m\x1b[36m${sortChip}\x1b[0m` +
      `\x1b[2m  [\x1b[0m\x1b[33ma\x1b[0m\x1b[2m] Status: \x1b[0m\x1b[36m${statusChip}\x1b[0m` +
      `\x1b[2m  [\x1b[0m\x1b[33mTab\x1b[0m\x1b[2m] Project: \x1b[0m\x1b[36m${projectChip}\x1b[0m`,
    );

    // Header line 6: hint (or any pending operation error). When the search bar
    // is focused the hint is search-specific; otherwise it lists the plain list
    // shortcuts — delete/rename are bare "d"/"r", since typing only happens
    // inside the focused search bar. Facet keys (Tab/a/s) are advertised on the
    // facet bar above, so the hint stays short enough to clear 80-col clamping.
    const runtime = items[selected]?.runtime;
    const active = runtime && ACTIVE_STATUSES.includes(runtime.status);
    const editHint = active ? "r rename" : "d del · r rename";
    lines.push(operationError
      ? `  \x1b[31m${operationError}\x1b[0m`
      : searchActive
        ? `\x1b[2m  type to filter · Backspace delete · Enter/Esc done\x1b[0m`
        : `\x1b[2m  ↑↓/scroll/click · Enter resume · / search · ${editHint} · q quit\x1b[0m`);

    // Header line 7 (conditional): the approval CTA banner. Shown whenever ANY
    // session needs approval, regardless of the active filters, so pending
    // consent is never buried. Bold + a shape glyph (not color alone).
    if (pending > 0) {
      const sessionWord = pending === 1 ? "session needs" : "sessions need";
      lines.push(`\x1b[1;33m  ⚠ ${pending} ${sessionWord} your approval\x1b[0m\x1b[2m — press a to filter by status\x1b[0m`);
    }

    lines.push("");

    // Center the selection in the viewport, clamped so we never scroll past the
    // ends. Because pageSize tracks the live terminal height, the selected row
    // is always inside [scrollStart, scrollEnd) even after the window shrinks.
    const scrollStart = Math.max(0, Math.min(selected - Math.floor(pageSize / 2), items.length - pageSize));
    const scrollEnd = Math.min(scrollStart + pageSize, items.length);
    visibleStart = scrollStart;
    visibleEnd = scrollEnd;

    const msgsCol = 8;   // "999 msgs"
    const ageCol = 8;    // "yesterday" trimmed / "3d" — relative age
    const projCol = 16;  // abbreviated project/cwd
    const idCol = 8;     // "9d166168"
    // Prefix is now: 2 pad + status gutter (1) + marker (1) + space.
    const metaWidth = projCol + 3 + ageCol + 3 + msgsCol + 3 + idCol; // " · " separators
    const prefixLen = 5; // "  ! ❯ " minus one — "  " + gutter + marker + " "
    const titleCol = Math.min(50, Math.max(16, cols - prefixLen - metaWidth - 2));

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
      const age = relativeAge(recencyOf(s)).padStart(ageCol);
      const msgs = `${s.messages.length} msgs`.padStart(msgsCol);
      const id = s.id.slice(0, idCol);
      const rawTitle = s.title.replace(/\n/g, " ");
      const title = sanitizeTitle(rawTitle, titleCol);
      const project = fitCells(abbreviateProject(projectOf(s)), projCol, true);

      // Status gutter: a shape-distinct glyph per state (accessible — not color
      // alone). "!" needs-approval (bold yellow), "●" running (cyan), else blank.
      let gutter = " ";
      if (needsApproval(s)) gutter = "\x1b[1;33m!\x1b[0m";
      else if (isRunning(s)) gutter = "\x1b[36m●\x1b[0m";

      // Selection marker: a strip-safe "❯" glyph so selection is visible even
      // where reverse-video doesn't render (accessibility) and so tests/tools
      // can detect it after ANSI is stripped. Reverse-video reinforces it.
      const marker = isSel ? "\x1b[32m❯\x1b[0m" : " ";

      if (isSel) {
        // Reverse-video spans the WHOLE row, not just the title. To keep the
        // highlight continuous we build the row from its plain-text segments
        // (no embedded \x1b[0m resets, which would cut the background short),
        // pad to the full terminal width so the background fills the row, then
        // wrap the whole thing in a single reverse-video span. The status
        // gutter glyph still renders as a plain character so it stays visible
        // inside the highlight.
        const gutterGlyph = needsApproval(s) ? "!" : isRunning(s) ? "●" : " ";
        const plainMeta = `  ${project} · ${age} · ${msgs} · ${id}`;
        const plain = `  ${gutterGlyph}❯ ${title}${plainMeta}`;
        // Pad to the clamp budget so the reverse background covers the full row.
        const budget = Math.max(1, cols - 1);
        const padded = fitCells(plain, budget, true);
        lines.push(`\x1b[7m${padded}\x1b[0m`);
      } else {
        const suffix = `  \x1b[2m${project}\x1b[0m\x1b[2m · ${age} · ${msgs} · ${id}\x1b[0m`;
        lines.push(`  ${gutter}${marker} \x1b[2m${title}\x1b[0m${suffix}`);
      }
    }

    // No-matches state (a filter excluded everything). The source list is never
    // empty here — pickSession returns early for that — so this only appears
    // when the active filters are too narrow. Tell the user how to recover.
    if (items.length === 0) {
      lines.push("");
      lines.push("\x1b[2m  No sessions match the current filters.\x1b[0m");
      lines.push("\x1b[2m  Backspace to clear text · Tab/S/A to change facets.\x1b[0m");
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
    // Base the frame height on the viewport CAPACITY, not on how many rows were
    // drawn this pass: a filtered-short list must still pad to the full height so
    // its shorter frame overwrites every row of the previous (taller) frame
    // instead of leaving stale sessions on screen below it.
    const frameHeight = capacity + headerLines + 3; // header + rows + footer + pad
    const rows = process.stdout.rows ?? frameHeight;
    const fixedHeight = Math.min(frameHeight, rows);
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
    let resizeRenameEditor: (() => void) | null = null;
    function onResize() {
      if (!listActive) {
        resizeRenameEditor?.();
        return;
      }
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
      closed = true;
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
      // Caret, selection and viewport use grapheme indices, never UTF-16 or
      // terminal columns. The same cell widths drive rendering and hit testing.
      const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      const graphemes = (text: string) => Array.from(segmenter.segment(text), (s) => s.segment);
      const decoder = new StringDecoder("utf8");
      const chars: string[] = [];
      let cursor = 0;
      let viewStart = 0;
      let viewEnd = 0;
      let anchor: number | null = null;
      let mouseDown = false;
      let pointerX = -1;
      let pointerY = -1;
      let lastClickTime = -Infinity;
      let lastClickX = -1;
      let clickCount = 0;
      let editorActive = true;
      const nameOf = () => chars.join("");
      const selection = (): [number, number] | null =>
        anchor === null || anchor === cursor ? null : [Math.min(anchor, cursor), Math.max(anchor, cursor)];
      function clearSelection() {
        anchor = null;
        mouseDown = false;
        lastClickTime = -Infinity;
      }
      function deleteSelection(): boolean {
        const range = selection();
        if (!range) return false;
        chars.splice(range[0], range[1] - range[0]);
        cursor = range[0];
        clearSelection();
        return true;
      }
      function moveCursor(next: number) {
        clearSelection();
        cursor = next;
        renderNameLine();
      }
      // Preserve fragmented mouse/keyboard reports without leaking their bytes
      // into the proposed name.
      let pendingRenameSeq = "";
      let renameRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

      // The list is no longer on screen: stop the resize handler from painting
      // it over the rename prompt.
      listActive = false;

      // Button-motion tracking is needed for drag selection, but only while
      // editing. Keep SGR coordinates and restore list-only tracking on exit.
      process.stdout.write("\x1b[?1002h");

      function clearRenameRecoveryTimer() {
        if (renameRecoveryTimer !== null) {
          clearTimeout(renameRecoveryTimer);
          renameRecoveryTimer = null;
        }
      }

      function disposeEditor() {
        editorActive = false;
        resizeRenameEditor = null;
        process.stdout.write("\x1b[?1002l");
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

      const NAME_PREFIX = "  New name: ";
      const nameRow = () => Math.min(4, Math.max(1, process.stdout.rows || 24));
      // Leave room for a caret even in a terminal narrower than the label.
      const namePrefix = () => NAME_PREFIX.slice(0, Math.max(0, currentCols() - 3));
      const nameCol = () => namePrefix().length + 1;
      const cellWidth = (start: number, end: number) =>
        chars.slice(start, end).reduce((width, ch) => width + stringWidth(ch), 0);
      function fitText(text: string, budget: number): string {
        let result = "";
        let width = 0;
        for (const ch of graphemes(text)) {
          const cells = stringWidth(ch);
          if (width + cells > budget) break;
          result += ch;
          width += cells;
        }
        return result;
      }

      // Full-screen paints happen only on entry/resize, never per keystroke.
      function renderRenamePrompt() {
        const budget = Math.max(0, currentCols() - 1);
        const title = session.title.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
        const headers = [
          `  Rename session "${title}"`,
          "  Enter save · Esc cancel / back · click/drag select · release copies",
          "",
        ];
        let output = "\x1b[2J\x1b[H\x1b[?25h";
        for (let row = 1; row < nameRow(); row++) {
          output += `${fitText(headers[row - 1]!, budget)}\r\n`;
        }
        process.stdout.write(output);
        totalLinesRendered = 0;
        renderNameLine();
      }
      resizeRenameEditor = renderRenamePrompt;

      // Horizontal scrolling keeps the input on one physical row. Overwrite
      // first, then erase the suffix: avoid a visible blank line between keys.
      function renderNameLine() {
        const capacity = Math.max(0, currentCols() - nameCol());
        viewStart = Math.min(viewStart, cursor);
        while (viewStart < cursor && cellWidth(viewStart, cursor) >= capacity) viewStart++;
        viewEnd = viewStart;
        let width = 0;
        let text = "";
        const range = selection();
        while (viewEnd < chars.length) {
          const ch = chars[viewEnd]!;
          const cells = stringWidth(ch);
          if (width + cells > capacity) break;
          text += range && viewEnd >= range[0] && viewEnd < range[1]
            ? `\x1b[7m${ch}\x1b[27m` : ch;
          width += cells;
          viewEnd++;
        }
        const col = Math.min(currentCols(), nameCol() + cellWidth(viewStart, cursor));
        process.stdout.write(
          `\x1b[${nameRow()};1H${namePrefix()}${text}\x1b[0m\x1b[K` +
          `\x1b[${nameRow()};${col}H`,
        );
      }

      function mouseOffset(x: number): number {
        let column = Math.max(0, x - nameCol());
        for (let i = viewStart; i < viewEnd; i++) {
          const cells = stringWidth(chars[i]!);
          if (column < cells) return column < cells - column ? i : i + 1;
          column -= cells;
        }
        return viewEnd;
      }

      function handleRenameMouse(report: string) {
        const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(report)!;
        const button = Number(match[1]);
        const x = Number(match[2]);
        const y = Number(match[3]);
        const release = match[4] === "m";
        // Ignore wheels and non-left buttons; modifiers don't change the button.
        if ((button & 3) !== 0 || (button & 64) !== 0) return;
        if (release) {
          if (!mouseDown) return;
          // Some terminals coalesce motion reports. Use the release position
          // if it differs from the last press/motion, but leave multi-click
          // selections intact on a stationary release. Do not advance an
          // auto-scrolled viewport twice for the same pointer position.
          if (x !== pointerX || y !== pointerY) {
            updateDrag(x, y);
            renderNameLine();
          }
          mouseDown = false;
          const range = selection();
          if (range) writeClipboard(process.stdout, chars.slice(...range).join(""));
          return;
        }
        if (button & 32) {
          if (!mouseDown) return;
          updateDrag(x, y);
        } else {
          if (y !== nameRow()) return;
          const offset = mouseOffset(x);
          const now = Date.now();
          clickCount = now - lastClickTime < 400 && x === lastClickX ? clickCount % 3 + 1 : 1;
          lastClickTime = now;
          lastClickX = x;
          mouseDown = true;
          anchor = cursor = offset;
          if (clickCount === 2) {
            const word = (ch: string) => /[\p{L}\p{N}_]/u.test(ch);
            if (offset < chars.length && word(chars[offset]!)) {
              while (anchor > 0 && word(chars[anchor - 1]!)) anchor--;
              while (cursor < chars.length && word(chars[cursor]!)) cursor++;
            }
          } else if (clickCount === 3) {
            anchor = 0;
            cursor = chars.length;
          }
        }
        pointerX = x;
        pointerY = y;
        renderNameLine();
      }

      function updateDrag(x: number, y: number) {
        // Drag beyond the visible edge to reveal more of a long name.
        if (y < nameRow() || x < nameCol()) cursor = Math.max(0, viewStart - 1);
        else if (y > nameRow() || x >= currentCols() - 1) cursor = Math.min(chars.length, viewEnd + 1);
        else cursor = mouseOffset(x);
        lastClickTime = -Infinity;
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
              moveCursor(selection()?.[0] ?? Math.max(0, cursor - 1));
              return false;
            case "\x1b[C": // →
              moveCursor(selection()?.[1] ?? Math.min(chars.length, cursor + 1));
              return false;
            case "\x1b[H": // Home
            case "\x1b[1~":
            case "\x1bOH":
              moveCursor(0);
              return false;
            case "\x1b[F": // End
            case "\x1b[4~":
            case "\x1bOF":
              moveCursor(chars.length);
              return false;
            case "\x1b[3~": // Delete (forward)
              if (!deleteSelection() && cursor < chars.length) chars.splice(cursor, 1);
              clearSelection();
              renderNameLine();
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
          if (!name) {
            returnToList();
            return true;
          }
          clearRenameRecoveryTimer();
          stdin.removeListener("data", onRenameInput);
          resizeRenameEditor = null;
          void renameSession(session.id, name)
            .then((renamed) => {
              // Update the authoritative source; the view is rebuilt on return
              // so a rename that changes sort/filter membership is reflected.
              const index = allItems.findIndex((item) => item.id === session.id);
              if (editorActive && renamed && index !== -1) allItems[index] = renamed;
            })
            .catch(() => {})
            .finally(() => {
              if (!editorActive) return;
              disposeEditor();
              listActive = true;
              enableMouse();
              recomputeView();
              process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");
              totalLinesRendered = 0;
              stdin.on("data", onData);
              render();
            });
          return true;
        }

        // Backspace / Delete removes the character BEFORE the caret.
        if (token === "\x7f" || token === "\b") {
          if (!deleteSelection() && cursor > 0) {
            chars.splice(cursor - 1, 1);
            cursor--;
          }
          clearSelection();
          renderNameLine();
          return false;
        }

        const printable = token.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
        if (printable) {
          deleteSelection();
          clearSelection();
          const before = chars.slice(0, cursor).join("") + printable;
          const next = graphemes(before + chars.slice(cursor).join(""));
          // Re-segment after insertion: a combining mark or ZWJ may join the
          // neighbouring grapheme even when it arrived in a separate chunk.
          let offset = 0;
          cursor = 0;
          while (cursor < next.length && offset < before.length) offset += next[cursor++]!.length;
          chars.splice(0, chars.length, ...next);
          renderNameLine();
        }
        return false;
      }

      function onRenameInput(renameData: Buffer) {
        // A continuation arrived — stand down the abandoned-report timer.
        clearRenameRecoveryTimer();
        const incoming = decoder.write(renameData);
        // Ctrl-C cannot be part of a mouse report, even if a prefix is pending.
        if (incoming.includes("\x03")) {
          pendingRenameSeq = "";
          handleRenameToken("\x03");
          return;
        }
        let input = pendingRenameSeq + incoming;
        pendingRenameSeq = "";

        // Walk mouse reports and keyboard tokens in stream order.
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
            handleRenameMouse(mouseMatch[0]);
            input = input.slice(mouseMatch[0].length);
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

          // Consume a single escape/control token, not the text following it.
          // Batched arrow + text + Enter must behave like separate keypresses.
          const escape = /^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1bO.)/.exec(input);
          if (/^\x1b(?:\[[0-?]*[ -/]*|O)$/.test(input) && input.length <= MAX_PENDING) {
            pendingRenameSeq = input;
            renameRecoveryTimer = setTimeout(() => {
              renameRecoveryTimer = null;
              pendingRenameSeq = "";
            }, ESC_FLUSH_MS);
            return;
          }
          const token = escape?.[0] ?? /^\r\n|^[^\x00-\x1f\x7f]+|^[\s\S]/.exec(input)![0];
          input = input.slice(token.length);
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
    // X is captured too now: a click's column is needed to hit-test the search
    // box (clicking a session row still only cares about Y).
    function parseMouseEvents(
      seq: string,
    ): { button: number; x: number; y: number; release: boolean }[] {
      const events: { button: number; x: number; y: number; release: boolean }[] = [];
      const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(seq)) !== null) {
        events.push({
          button: Number(m[1]),
          x: Number(m[2]),
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
      x: number;
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

      // Left-button press (code 0). Ignore the release so a single click doesn't
      // fire twice.
      if (ev.button === 0 && !ev.release) {
        // 1) Click INSIDE the search box focuses it (click-to-activate). The box
        //    spans searchBox.top..bottom rows and left..right columns.
        const insideSearch =
          ev.y >= searchBox.top && ev.y <= searchBox.bottom &&
          ev.x >= searchBox.left && ev.x <= searchBox.right;
        if (insideSearch) {
          if (searchActive) return false; // already focused — no repaint needed
          searchActive = true;
          return true;
        }

        // 2) Click OUTSIDE the box while it is focused blurs it (the filter stays
        //    applied). The click then also falls through to row selection below,
        //    so a single click on a session row both blurs AND selects it. Track
        //    whether a blur happened so a click that changes nothing else still
        //    repaints the now-dimmed box.
        const blurred = searchActive;
        searchActive = false;

        // 3) Click on a session row selects it. Map the 1-based terminal row to
        //    an item index via the header offset and the visible window.
        const rowIndex = ev.y - 1 - headerLineCount(); // 0-based offset into visible rows
        if (rowIndex < 0) return blurred; // other header row: repaint only if we blurred
        const idx = visibleStart + rowIndex;
        if (idx < visibleStart || idx >= visibleEnd) return blurred;
        if (idx === selected) return blurred;
        selected = idx;
        return true;
      }

      return false;
    }

    // Handle one logical keyboard token (already separated from any mouse
    // reports). Returns true if control was handed off — the picker resolved,
    // exited, or switched to the rename editor — so the caller stops draining
    // any remaining input in the current chunk.
    let searchCRDeadline = 0;
    function handleKey(key: string): boolean {
      // A split CRLF is one Enter, not a search commit followed by resume.
      const swallowLF = searchCRDeadline > 0 && Date.now() <= searchCRDeadline;
      searchCRDeadline = 0;
      if (swallowLF && key === "\n") return false;
      // Ctrl-C always exits, in either mode.
      if (key === "\x03") {
        cleanup();
        process.exit(0);
      }

      // ── Search bar focused ──────────────────────────────────────────────
      // While the inline search bar has focus, keystrokes edit the query rather
      // than acting as list shortcuts. Only navigation (arrows) and submit/blur
      // (Enter/Esc) are special; every other printable character types into the
      // query. This is what keeps "d" (and every letter) from colliding with the
      // list's delete/rename shortcuts: letters only ever reach a shortcut when
      // the bar is NOT focused.
      if (searchActive) {
        // Enter or Esc blur the bar and return to the list; the filter stays
        // applied. Enter does not resume here — it just commits the search.
        if (key === "\r" || key === "\n" || key === "\r\n" || key === "\x1b") {
          searchCRDeadline = key === "\r" ? Date.now() + 50 : 0;
          searchActive = false;
          render();
          return false;
        }
        // Arrows still move the selection so the user can scan matches while the
        // bar is focused, without leaving search.
        if (key === "\x1b[A") { selected = Math.max(0, selected - 1); render(); return false; }
        if (key === "\x1b[B") { selected = Math.min(items.length - 1, selected + 1); render(); return false; }
        // Backspace edits the query (and clears the whole bar once empty).
        if (key === "\x7f" || key === "\b") {
          if (nameFilter.length > 0) { nameFilter = graphemes(nameFilter).slice(0, -1).join(""); recomputeView(); render(); }
          return false;
        }
        // Any printable character (incl. space) appends to the query.
        if (key.length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(key)) {
          nameFilter += key;
          recomputeView();
          render();
          return false;
        }
        // Ignore anything else (function keys, etc.) so stray bytes never leak.
        return false;
      }

      // ── List mode (search bar NOT focused) ──────────────────────────────
      // Esc or "q" cancels the picker. With the search bar unfocused, "q" is a
      // safe immediate-cancel alias (it can never be part of a typed query).
      if (key === "\x1b" || key === "q") {
        cleanup();
        resolve(null);
        return true;
      }

      // "/" focuses the inline search bar so the user can type a name filter.
      if (key === "/") {
        searchActive = true;
        render();
        return false;
      }

      // Enter resumes the selected session (\r drains a trailing \n).
      if (key === "\r") {
        if (items.length === 0) return false; // nothing to resume (filtered out)
        cleanup(true);
        resolve(items[selected]!);
        return true;
      }
      if (key === "\n" || key === "\r\n") {
        if (items.length === 0) return false;
        cleanup();
        resolve(items[selected]!);
        return true;
      }

      // Navigation: arrows plus vim-style j/k (safe now that typing only happens
      // in the focused search bar).
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

      // Backspace clears the name filter in one stroke (a quick "show all" that
      // doesn't require re-entering the search bar).
      if (key === "\x7f" || key === "\b") {
        if (nameFilter.length > 0) { nameFilter = ""; recomputeView(); render(); }
        return false;
      }

      // Facet toggles (plain keys, no conflict now that letters aren't captured):
      // Tab cycles project (req 2), "s" cycles sort (req 3), "a" cycles status
      // (reqs 4 & 5).
      if (key === "\t") {
        const cycle = projectCycle();
        const i = cycle.indexOf(projectScope);
        projectScope = cycle[(i + 1) % cycle.length] ?? "";
        recomputeView();
        render();
        return false;
      }
      if (key === "s" || key === "S") {
        sortRequested = true;
        sortKey = sortKey === "updated" ? "created" : "updated";
        // Sorting keeps the focused row (and viewport), not the session identity.
        recomputeView(false);
        render();
        return false;
      }
      if (key === "a" || key === "A") {
        statusFilter = statusFilter === "all" ? "running"
          : statusFilter === "running" ? "needs-approval"
          : "all";
        recomputeView();
        render();
        return false;
      }

      // "d"/"D" deletes the selected session. Safe as a bare key again: typing
      // only edits the query while the search bar is focused, so pressing "d"
      // here always means delete, never a filter character.
      if (key === "d" || key === "D") {
        if (items.length === 0) return false;
        const toDelete = items[selected]!;
        if (toDelete.runtime && ["starting", "running", "needs-approval"].includes(toDelete.runtime.status)) return false;
        if (deleting.has(toDelete.id)) return false;
        deleting.add(toDelete.id);
        operationError = undefined;
        deleteSession(toDelete.id).then((ok) => {
          if (!ok && !closed) { operationError = "Cannot delete: session is active or no longer exists."; if (listActive) render(); }
          if (ok && !closed) {
            // Remove from the authoritative source, then rebuild the view. When
            // the SOURCE is now empty there is nothing left to resume; otherwise
            // recomputeView re-clamps the selection within the filtered list.
            const index = allItems.findIndex(item => item.id === toDelete.id);
            if (index !== -1) allItems.splice(index, 1);
            if (allItems.length === 0) {
              cleanup();
              resolve(null);
              return;
            }
            recomputeView();
            if (listActive) render();
          }
        }).catch(error => {
          if (!closed) {
            operationError = `Delete failed: ${error instanceof Error ? error.message : String(error)}`;
            if (listActive) render();
          }
        }).finally(() => { deleting.delete(toDelete.id); });
        return false;
      }

      // "m"/"M"/"r"/"R" opens the rename editor — plain keys again, since typing
      // only reaches the query inside the focused search bar.
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

    const decoder = new StringDecoder("utf8");
    function onData(data: Buffer) {
      // A continuation arrived before the flush timer — combine and reprocess.
      clearPendingTimer();
      let input = pendingSeq + decoder.write(data);
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
        let key = nextEscape === -1 ? input : input.slice(0, nextEscape);
        if (searchActive || searchCRDeadline > 0) {
          // Text may arrive pasted/coalesced, with controls in the same chunk.
          // Consume complete CSI sequences atomically so their bytes never type.
          key = /^(?:\x1b\[[0-?]*[ -/]*[@-~]|\r\n|[^\x00-\x1f\x7f-\x9f]+|[\s\S])/u.exec(input)![0];
        }
        input = input.slice(key.length);
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
