import stringWidth from "string-width";

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
  return stringWidth(stripAnsi(value));
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
    // Keep indentation attached to the first word (or as the whole blank
    // paragraph), so empty split tokens cannot discard it. Overlong indentation
    // goes through the same column-aware cutting as an overlong word.
    const indentation = paragraph.match(/^ */)![0];
    // Only the single space before the next word is a wrap separator. Keep
    // other spaces in the tokens, including trailing whitespace on full rows.
    const words = paragraph.slice(indentation.length).split(/ (?=[^ ])/);
    words[0] = indentation + words[0]!;
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (visualLen(candidate) <= usable) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      current = word;
      while (visualLen(current) > usable) {
        let cut = 0;
        let used = 0;
        for (const { segment, index } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(current)) {
          const segmentWidth = stringWidth(segment);
          if (cut > 0 && used + segmentWidth > usable) break;
          used += segmentWidth;
          cut = index + segment.length;
          if (used >= usable) break;
        }
        lines.push(current.slice(0, cut));
        current = current.slice(cut);
      }
    }
    // Pushed unconditionally so a blank line stays blank instead of collapsing.
    lines.push(current);
  }

  return lines;
}
