// Text selection helpers operating on the rendered screen as an array of
// plain-text lines (ANSI already stripped by the caller). Coordinates are
// 0-indexed. A `SelectionRange` is normalized so that (startX, startY) precedes
// (endX, endY) in reading order (top-to-bottom, then left-to-right).

export type SelectionRange = {
	startX: number;
	startY: number;
	endX: number;
	endY: number;
};

type Point = {x: number; y: number};

/** Returns true if point `a` precedes point `b` in reading order. */
const precedes = (a: Point, b: Point): boolean => {
	if (a.y !== b.y) {
		return a.y < b.y;
	}

	return a.x <= b.x;
};

/** Order two points into reading order, producing a normalized range. */
export const normalizeSelection = (a: Point, b: Point): SelectionRange => {
	const [start, end] = precedes(a, b) ? [a, b] : [b, a];

	return {
		startX: start.x,
		startY: start.y,
		endX: end.x,
		endY: end.y,
	};
};

// Characters considered part of a "word" for double-click word selection.
const isWordChar = (ch: string | undefined): boolean =>
	ch !== undefined && /\w/.test(ch);

/**
 * Expand to the word boundaries around (x, y) using \w-ish boundaries.
 * Returns null if the coordinate is out of bounds or not on a word character.
 * The returned range is [startX, endX) — endX is exclusive (one past the last
 * word character), matching `getSelectedText`'s slicing.
 */
export const selectWordAt = (
	lines: string[],
	x: number,
	y: number,
): SelectionRange | null => {
	if (y < 0 || y >= lines.length) {
		return null;
	}

	const line = lines[y];
	if (line === undefined || x < 0 || x >= line.length) {
		return null;
	}

	if (!isWordChar(line[x])) {
		return null;
	}

	let start = x;
	while (start > 0 && isWordChar(line[start - 1])) {
		start--;
	}

	let end = x;
	while (end < line.length && isWordChar(line[end])) {
		end++;
	}

	return {startX: start, startY: y, endX: end, endY: y};
};

/**
 * Select the whole line `y`. The range spans from column 0 to the line length
 * (exclusive end). Out-of-bounds `y` yields an empty range on that row.
 */
export const selectLineAt = (lines: string[], y: number): SelectionRange => {
	const line = y >= 0 && y < lines.length ? lines[y] : undefined;
	const length = line?.length ?? 0;

	return {startX: 0, startY: y, endX: length, endY: y};
};

/** Build a normalized selection from a drag: `anchor` down to `to`. */
export const extendSelection = (anchor: Point, to: Point): SelectionRange =>
	normalizeSelection(anchor, to);

/**
 * Extract the selected substring across lines and join with "\n".
 * Multi-line: first line from startX to end-of-line, middle lines whole, last
 * line up to endX. `endX` is treated as exclusive. Out-of-bounds rows/columns
 * are handled gracefully.
 */
export const getSelectedText = (
	lines: string[],
	range: SelectionRange,
): string => {
	const {startX, startY, endX, endY} = range;

	if (startY === endY) {
		const line = startY >= 0 && startY < lines.length ? lines[startY] : "";
		return (line ?? "").slice(Math.max(0, startX), Math.max(0, endX));
	}

	const parts: string[] = [];

	for (let y = startY; y <= endY; y++) {
		const line = (y >= 0 && y < lines.length ? lines[y] : "") ?? "";

		if (y === startY) {
			parts.push(line.slice(Math.max(0, startX)));
		} else if (y === endY) {
			parts.push(line.slice(0, Math.max(0, endX)));
		} else {
			parts.push(line);
		}
	}

	return parts.join("\n");
};
