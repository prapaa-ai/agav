import {describe, it, expect} from "vitest";
import {
	normalizeSelection,
	selectWordAt,
	selectLineAt,
	getSelectedText,
	getCopyLines,
	extendSelection,
} from "../ink/selection.js";
import Output from "../ink/output.js";
import {osc52Copy} from "../ink/termio/clipboard.js";
import {ENABLE_MOUSE_TRACKING} from "../ink/termio/dec.js";

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
	it.each([
		["implemented by code", ["impl", "emented", "by code"]],
		["one\n\n\ntwo", ["one", "", "", "two"]],
		["same same\nsame", ["same", "same", "same"]],
	])("recovers source boundaries for %j", (source, rows) => {
		expect(getSelectedText(rows, {startX: 0, startY: 0,
			endX: rows.at(-1)!.length, endY: rows.length - 1}, getCopyLines(source, rows))).toBe(source);
	});

	it("copies a partial selection across a mid-word wrap", () => {
		const rows = ["impl", "emented"];
		expect(getSelectedText(rows, {startX: 2, startY: 0, endX: 3, endY: 1},
			getCopyLines("implemented", rows))).toBe("pleme");
	});
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

describe("output copy metadata", () => {
	it("clips source boundaries without shifting their original coordinates", () => {
		const output = new Output({width: 8, height: 3});
		output.clip({x1: 2, x2: 5, y1: 1, y2: 4});
		output.write(0, 0, "abcdef\nghijkl\nmnopqr\nstuvwx", {
			transformers: [], copyLines: getCopyLines("abcdefghijklmnopqrstuvwx", ["abcdef", "ghijkl", "mnopqr", "stuvwx"]),
		});
		const rows = output.get().output.split("\n");
		expect(rows).toEqual(["", "  ijk", "  opq"]);
		expect(getSelectedText(rows, {startX: 2, startY: 1, endX: 5, endY: 2}, output.copyLines)).toBe("ijkopq");
	});

	it("keeps genuine empty rows inside a clip but ignores empty writes outside it", () => {
		const output = new Output({width: 8, height: 3});
		output.clip({x1: 0, x2: 5, y1: 0, y2: 3});
		output.write(0, 0, "one\n\ntwo", {transformers: [], copyLines: getCopyLines("one\n\ntwo", ["one", "", "two"])});
		output.write(5, 1, "", {transformers: [], copyLines: [{separator: "", startX: 0, endX: 0, explicit: true}]});
		const rows = output.get().output.split("\n");
		expect(getSelectedText(rows, {startX: 0, startY: 0, endX: 3, endY: 2}, output.copyLines)).toBe("one\n\ntwo");
		expect(output.copyLines[1]?.endX).toBe(0);
	});

	it("keeps an explicitly empty source write", () => {
		const output = new Output({width: 5, height: 1});
		output.write(2, 0, "", {transformers: [], copyLines: [{separator: "\n", startX: 0, endX: 0, explicit: true}]});
		output.get();
		expect(output.copyLines[0]).toMatchObject({startX: 2, endX: 2, separator: "\n"});
	});

	it("preserves intentional whitespace while excluding decorative padding", () => {
		const rows = ["  one  " + "      ", "  " + "        ", "  two " + "       "];
		const metadata = getCopyLines("one  \n\ntwo ", ["one  ", "", "two "])
			.map(copy => ({...copy, startX: 2, endX: copy.endX! + 2}));
		expect(getSelectedText(rows, {startX: 2, startY: 0, endX: 20, endY: 2}, metadata)).toBe("one  \n\ntwo ");
		expect(getSelectedText(rows, {startX: 2, startY: 0, endX: 20, endY: 0}, metadata)).toBe("one  ");
	});

	it("measures content boundaries in terminal columns, not UTF-16 units", () => {
		const rows = ["  界é   ", "  next   "];
		const metadata = getCopyLines("界énext", ["界é", "next"])
			.map(copy => ({...copy, startX: 2, endX: copy.endX! + 2}));
		expect(getSelectedText(rows, {startX: 2, startY: 0, endX: 6, endY: 1}, metadata)).toBe("界énext");
	});

	it("falls back to screen rows for adjacent independent columns", () => {
		const output = new Output({width: 12, height: 2});
		output.write(0, 0, "ABC\nDEF", {transformers: [], copyLines: getCopyLines("ABC\nDEF", ["ABC", "DEF"])});
		output.write(6, 0, "123456\n789", {transformers: [], copyLines: getCopyLines("123456789", ["123456", "789"])});
		const rows = output.get().output.split("\n");
		expect(rows).toEqual(["ABC   123456", "DEF   789"]);
		expect(getSelectedText(rows, {startX: 0, startY: 0, endX: 9, endY: 1}, output.copyLines)).toBe(rows.join("\n"));
	});

	it.each([5, -3])("ignores a fully horizontally clipped continuation at x=%i", x => {
		const output = new Output({width: 10, height: 2});
		output.write(0, 0, "left\nnext", {transformers: [], copyLines: getCopyLines("left\nnext", ["left", "next"])});
		output.clip({x1: 0, x2: 5, y1: undefined, y2: undefined});
		output.write(x, 1, "xxx", {transformers: [], copyLines: [{separator: "", startX: 0, explicit: true}]});
		const rows = output.get().output.split("\n");
		expect(rows).toEqual(["left", "next"]);
		expect(getSelectedText(rows, {startX: 0, startY: 0, endX: 4, endY: 1}, output.copyLines)).toBe("left\nnext");
	});
});

describe("osc52Copy", () => {
	it("produces the correct base64 and escape wrapper for 'hello'", () => {
		expect(osc52Copy("hello")).toBe("\x1b]52;c;aGVsbG8=\x07");
	});
});

describe("mouse tracking for in-app selection", () => {
	it("enables drag tracking but not unused any-motion tracking", () => {
		expect(ENABLE_MOUSE_TRACKING).toContain("\x1b[?1000h");
		expect(ENABLE_MOUSE_TRACKING).toContain("\x1b[?1002h");
		expect(ENABLE_MOUSE_TRACKING).toContain("\x1b[?1006h");
		expect(ENABLE_MOUSE_TRACKING).not.toContain("\x1b[?1003h");
	});
});
