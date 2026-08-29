import stringWidth from "string-width";

export type WrapType =
	| "wrap"
	| "hard"
	| "truncate-end"
	| "truncate"
	| "truncate-middle"
	| "truncate-start";

const cache: Record<string, string> = {};

/** Matches a single SGR escape sequence (the styling sequences chalk emits). */
const sgrPattern = "\\u001B\\[[0-9;]*m";
const reset = "\u001B[0m";

const graphemes = new Intl.Segmenter(undefined, {granularity: "grapheme"});

type Piece =
	| {kind: "sgr"; value: string; width: 0}
	| {kind: "text"; value: string; width: number; space: boolean};

/**
 * Split a styled string into SGR escapes and individual grapheme clusters, so
 * wrapping can count visible columns without cutting inside an escape sequence
 * or between the code points of a multi-code-point grapheme.
 */
const toPieces = (text: string): Piece[] => {
	const pieces: Piece[] = [];

	const addText = (chunk: string): void => {
		for (const {segment} of graphemes.segment(chunk)) {
			pieces.push({
				kind: "text",
				value: segment,
				width: stringWidth(segment),
				space: /^\s+$/.test(segment),
			});
		}
	};

	const sgr = new RegExp(sgrPattern, "g");
	let last = 0;

	for (let match = sgr.exec(text); match; match = sgr.exec(text)) {
		if (match.index > last) {
			addText(text.slice(last, match.index));
		}

		pieces.push({kind: "sgr", value: match[0], width: 0});
		last = sgr.lastIndex;
	}

	if (last < text.length) {
		addText(text.slice(last));
	}

	return pieces;
};

/** Fold an SGR sequence into the set of styles currently in effect. */
const applySgr = (state: string[], sequence: string): string[] => {
	const parameters = sequence.slice(2, -1);

	if (parameters === "" || /^0+$/.test(parameters)) {
		return [];
	}

	return [...state, sequence];
};

/**
 * Word-wrap a possibly ANSI-styled string to `maxWidth` visible columns.
 *
 * When `wordWrap` is false, tokens are always hard-broken at the column limit
 * (equivalent to `wrap-ansi`'s `wordWrap: false`). Every wrapped line reopens
 * the styles active at the break and closes them so escapes never split.
 */
const wrap = (
	text: string,
	maxWidth: number,
	{wordWrap}: {wordWrap: boolean},
): string => {
	if (maxWidth <= 0) {
		return text;
	}

	// Wrap each source line independently so explicit newlines are preserved.
	return text
		.split("\n")
		.map(line => wrapLine(line, maxWidth, {wordWrap}))
		.join("\n");
};

const wrapLine = (
	text: string,
	maxWidth: number,
	{wordWrap}: {wordWrap: boolean},
): string => {
	if (stringWidth(text) <= maxWidth) {
		return text;
	}

	const lines: string[] = [];
	let open: string[] = [];
	let line: Piece[] = [];
	let width = 0;
	let lastSpace = -1;

	const emit = (cut: number, resume: number): void => {
		const body = line
			.slice(0, cut)
			.map(piece => piece.value)
			.join("");

		lines.push(
			body.length > 0 && (open.length > 0 || body.includes("\u001B"))
				? open.join("") + body + reset
				: body,
		);

		open = line
			.slice(0, resume)
			.reduce(
				(state, piece) =>
					piece.kind === "sgr" ? applySgr(state, piece.value) : state,
				open,
			);

		line = line.slice(resume);
		width = line.reduce((total, piece) => total + piece.width, 0);
		lastSpace = -1;
	};

	for (const piece of toPieces(text)) {
		if (piece.kind === "sgr") {
			line.push(piece);
			continue;
		}

		if (width + piece.width > maxWidth && width > 0) {
			if (piece.space) {
				emit(line.length, line.length);
				continue;
			}

			if (wordWrap && lastSpace >= 0) {
				let resume = lastSpace;

				while (
					resume < line.length &&
					line[resume]!.kind === "text" &&
					(line[resume] as {space: boolean}).space
				) {
					resume++;
				}

				emit(lastSpace, resume);
			} else {
				emit(line.length, line.length);
			}
		}

		if (piece.space && width === 0) {
			// No leading spaces on a wrapped continuation line.
			if (lines.length > 0) {
				continue;
			}
		}

		lastSpace = piece.space ? (lastSpace < 0 ? line.length : lastSpace) : -1;
		line.push(piece);
		width += piece.width;
	}

	if (line.length > 0) {
		emit(line.length, line.length);
	}

	return lines.join("\n");
};

/**
 * Truncate a styled string to `maxWidth` visible columns, inserting an
 * ellipsis at the requested position. Faithful to `cli-truncate`'s three
 * positions.
 */
const truncate = (
	text: string,
	maxWidth: number,
	position: "start" | "middle" | "end",
): string => {
	if (maxWidth < 1) {
		return "";
	}

	if (stringWidth(text) <= maxWidth) {
		return text;
	}

	const ellipsis = "…";
	const pieces = toPieces(text).filter(
		(piece): piece is Extract<Piece, {kind: "text"}> => piece.kind === "text",
	);

	const take = (source: Piece[], budget: number): string => {
		let used = 0;
		let output = "";

		for (const piece of source) {
			if (used + piece.width > budget) {
				break;
			}

			output += piece.value;
			used += piece.width;
		}

		return output;
	};

	if (position === "start") {
		const budget = maxWidth - 1;
		return ellipsis + take([...pieces].reverse(), budget).split("").reverse().join("");
	}

	if (position === "middle") {
		const half = Math.floor((maxWidth - 1) / 2);
		const start = take(pieces, half);
		const endPart = take([...pieces].reverse(), maxWidth - 1 - half)
			.split("")
			.reverse()
			.join("");
		return start + ellipsis + endPart;
	}

	return take(pieces, maxWidth - 1) + ellipsis;
};

/**
 * Wrap or truncate `text` to `maxWidth` terminal columns according to
 * `wrapType`. Results are memoized like Ink's original.
 */
const wrapText = (
	text: string,
	maxWidth: number,
	wrapType: WrapType,
): string => {
	const cacheKey = text + String(maxWidth) + String(wrapType);
	const cachedText = cache[cacheKey];

	if (cachedText !== undefined) {
		return cachedText;
	}

	let wrappedText = text;

	if (wrapType === "wrap") {
		wrappedText = wrap(text, maxWidth, {wordWrap: true});
	}

	if (wrapType === "hard") {
		wrappedText = wrap(text, maxWidth, {wordWrap: false});
	}

	if (wrapType.startsWith("truncate")) {
		let position: "start" | "middle" | "end" = "end";

		if (wrapType === "truncate-middle") {
			position = "middle";
		}

		if (wrapType === "truncate-start") {
			position = "start";
		}

		wrappedText = truncate(text, maxWidth, position);
	}

	cache[cacheKey] = wrappedText;

	return wrappedText;
};

export default wrapText;
