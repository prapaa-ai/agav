// Text selection helpers operating on the rendered screen as an array of
// plain-text lines (ANSI already stripped by the caller). Coordinates are
// 0-indexed. A `SelectionRange` is normalized so that (startX, startY) precedes
// (endX, endY) in reading order (top-to-bottom, then left-to-right).

import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";

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

/** Source separator and content column for a rendered visual row. */
export type CopyLine = {
	separator: string;
	startX: number;
	endX?: number;
	explicit?: boolean;
	source?: object | string;
};

/** Recover source boundaries before visual rows lose their wrapping provenance. */
export const getCopyLines = (source: string, rows: string[]): CopyLine[] => {
	let cursor = 0;
	const identity = {};
	return rows.map((row, index) => {
		let start = index > 0 && row === "" && source[cursor] === "\n"
			? cursor + 1 : source.indexOf(row, cursor);
		if (start < 0) start = cursor;
		const gap = source.slice(cursor, start);
		const separator = index === 0 || /[\r\n]/.test(gap) ? "\n" : gap;
		cursor = start + row.length;
		return {separator, startX: 0, endX: stringWidth(row), source: identity};
	});
};

/** Extract a selection, restoring source separators when wrap metadata exists. */
export const getSelectedText = (
	lines: string[],
	range: SelectionRange,
	copyLines: (CopyLine | undefined)[] = [],
): string => {
	const {startX, startY, endX, endY} = range;

	if (startY === endY) {
		const line = startY >= 0 && startY < lines.length ? lines[startY] : "";
		return sliceAnsi(line ?? "", Math.max(0, startX), Math.min(Math.max(0, endX), copyLines[startY]?.endX ?? Infinity));
	}

	const parts: string[] = [];

	for (let y = startY; y <= endY; y++) {
		const line = (y >= 0 && y < lines.length ? lines[y] : "") ?? "";

		const copy = copyLines[y];
		const previous = copyLines[y - 1];
		const sameSource = copy?.explicit ? previous !== undefined
			: !copy?.source || copy.source === previous?.source;
		const from = y === startY ? Math.max(0, startX) : (sameSource ? (copy?.startX ?? 0) : 0);
		const to = Math.min(y === endY ? Math.max(0, endX) : stringWidth(line), copy?.endX ?? Infinity);
		if (y > startY) parts.push(sameSource ? (copy?.separator ?? "\n") : "\n");
		parts.push(sliceAnsi(line, from, to));
	}

	return parts.join("");
};
