/**
 * Line breaking for text drawn inside a padded background band.
 *
 * A band is painted by writing the text followed by enough spaces to reach the
 * right edge. That only holds while every line occupies exactly one row: if the
 * terminal wraps a line itself, the cursor jumps to column 0 partway through and
 * the padding — measured for a single row — lands in the wrong place, tearing the
 * band open. So the caller must never hand the renderer a line the terminal would
 * have to break, which means newlines and overlong words are resolved here.
 */

/** Drop SGR and OSC-8 sequences so widths are measured in visible characters. */
export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\]8;[^]*?\x1b\\/g, "");
}

export function visualLen(value: string): number {
  return stripAnsi(value).length;
}

/**
 * Break `content` into lines that each fit within `width` visible columns.
 *
 * Hard line breaks in the input are preserved, including blank ones, so a
 * multi-line message keeps its shape. Words longer than `width` are cut rather
 * than allowed to overflow. Always returns at least one line.
 */
export function wrapToWidth(content: string, width: number): string[] {
  // A non-positive width would leave the overlong-word loop unable to progress.
  const usable = Math.max(1, Math.floor(width));
  const lines: string[] = [];

  for (const paragraph of content.split(/\r\n|\r|\n/)) {
    let current = "";
    for (const word of paragraph.split(" ")) {
      const candidate = current ? `${current} ${word}` : word;
      if (visualLen(candidate) <= usable) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      current = word;
      while (visualLen(current) > usable) {
        lines.push(current.slice(0, usable));
        current = current.slice(usable);
      }
    }
    // Pushed unconditionally so a blank line stays blank instead of collapsing.
    lines.push(current);
  }

  return lines;
}
