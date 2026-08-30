import {describe, it, expect} from "vitest";
import {
	normalizeSelection,
	selectWordAt,
	selectLineAt,
	getSelectedText,
	extendSelection,
} from "../ink/selection.js";
import {osc52Copy} from "../ink/termio/clipboard.js";

describe("normalizeSelection", () => {
	it("orders two points on different rows into reading order", () => {
		const range = normalizeSelection({x: 5, y: 3}, {x: 2, y: 1});
		expect(range).toEqual({startX: 2, startY: 1, endX: 5, endY: 3});
	});

	it("orders two points on the same row by column", () => {
		const range = normalizeSelection({x: 8, y: 2}, {x: 3, y: 2});
		expect(range).toEqual({startX: 3, startY: 2, endX: 8, endY: 2});
	});

	it("leaves already-ordered points unchanged", () => {
		const range = normalizeSelection({x: 1, y: 0}, {x: 4, y: 0});
		expect(range).toEqual({startX: 1, startY: 0, endX: 4, endY: 0});
	});

	it("extendSelection delegates to normalizeSelection", () => {
		const range = extendSelection({x: 9, y: 4}, {x: 1, y: 1});
		expect(range).toEqual({startX: 1, startY: 1, endX: 9, endY: 4});
	});
});

describe("selectWordAt", () => {
	const lines = ["hello world foo"];

	it("selects the word when clicking inside it", () => {
		// "world" spans columns 6..10 (inclusive), exclusive end = 11.
		const range = selectWordAt(lines, 8, 0);
		expect(range).toEqual({startX: 6, startY: 0, endX: 11, endY: 0});
		expect(getSelectedText(lines, range!)).toBe("world");
	});

	it("selects the first word", () => {
		const range = selectWordAt(lines, 0, 0);
		expect(getSelectedText(lines, range!)).toBe("hello");
	});

	it("returns null when clicking whitespace", () => {
		expect(selectWordAt(lines, 5, 0)).toBeNull();
	});

	it("returns null when out of bounds", () => {
		expect(selectWordAt(lines, 100, 0)).toBeNull();
		expect(selectWordAt(lines, 0, 5)).toBeNull();
	});
});

describe("selectLineAt", () => {
	const lines = ["hello world foo", "second line"];

	it("returns the full line range", () => {
		const range = selectLineAt(lines, 0);
		expect(range).toEqual({startX: 0, startY: 0, endX: 15, endY: 0});
		expect(getSelectedText(lines, range)).toBe("hello world foo");
	});

	it("handles out-of-bounds rows gracefully", () => {
		const range = selectLineAt(lines, 99);
		expect(range).toEqual({startX: 0, startY: 99, endX: 0, endY: 99});
	});
});

describe("getSelectedText", () => {
	it("extracts a single-line selection", () => {
		const lines = ["hello world foo"];
		const range = {startX: 6, startY: 0, endX: 11, endY: 0};
		expect(getSelectedText(lines, range)).toBe("world");
	});

	it("extracts a multi-line selection", () => {
		const lines = ["hello world", "middle line", "last line here"];
		const range = {startX: 6, startY: 0, endX: 4, endY: 2};
		expect(getSelectedText(lines, range)).toBe("world\nmiddle line\nlast");
	});

	it("handles out-of-bounds rows gracefully", () => {
		const lines = ["only line"];
		const range = {startX: 0, startY: 0, endX: 4, endY: 3};
		expect(getSelectedText(lines, range)).toBe("only line\n\n\n");
	});
});

describe("osc52Copy", () => {
	it("produces the correct base64 and escape wrapper for 'hello'", () => {
		expect(osc52Copy("hello")).toBe("\x1b]52;c;aGVsbG8=\x07");
	});
});
