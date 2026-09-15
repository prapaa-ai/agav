import stringWidth from "string-width";

type Dimensions = {
	width: number;
	height: number;
};

const MAX_CACHE_SIZE = 10_000;
const cache = new Map<string, Dimensions>();

/**
 * Measure the rendered dimensions of a (possibly multi-line, ANSI-styled)
 * string in terminal cells.
 *
 * `width` is the widest visible line and `height` is the number of lines.
 * Ported from Ink's `measure-text.js`; `string-width` replaces `widest-line`
 * for per-line width measurement.
 */
const measureText = (text: string): Dimensions => {
	if (text.length === 0) {
		return {
			width: 0,
			height: 0,
		};
	}

	const cachedDimensions = cache.get(text);

	if (cachedDimensions) {
		return cachedDimensions;
	}

	const lines = text.split("\n");
	let width = 0;

	for (const line of lines) {
		const lineWidth = stringWidth(line);

		if (lineWidth > width) {
			width = lineWidth;
		}
	}

	const dimensions: Dimensions = {width, height: lines.length};
	if (cache.size >= MAX_CACHE_SIZE) {
		const oldestKey = cache.keys().next().value;
		if (oldestKey !== undefined) {
			cache.delete(oldestKey);
		}
	}
	cache.set(text, dimensions);

	return dimensions;
};

export default measureText;
