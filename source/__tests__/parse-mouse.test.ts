import {describe, it, expect} from "vitest";
import {
	parseMouseEvent,
	isMouseSequence,
} from "../ink/parse-mouse.js";

const ESC = "\x1b";

describe("parseMouseEvent — SGR encoding", () => {
	it("parses a wheel-up report", () => {
		const result = parseMouseEvent(`${ESC}[<64;10;5M`);
		expect(result).toEqual({
			kind: "mouse",
			button: 0,
			action: "move",
			wheel: "up",
			x: 9,
			y: 4,
			ctrl: false,
			alt: false,
			shift: false,
		});
	});

	it("parses a wheel-down report", () => {
		const result = parseMouseEvent(`${ESC}[<65;10;5M`);
		expect(result?.wheel).toBe("down");
		expect(result?.action).toBe("move");
		expect(result?.x).toBe(9);
		expect(result?.y).toBe(4);
	});

	it("parses a left-button press", () => {
		const result = parseMouseEvent(`${ESC}[<0;10;5M`);
		expect(result).toEqual({
			kind: "mouse",
			button: 0,
			action: "press",
			x: 9,
			y: 4,
			ctrl: false,
			alt: false,
			shift: false,
		});
	});

	it("parses a left-button release", () => {
		const result = parseMouseEvent(`${ESC}[<0;10;5m`);
		expect(result?.action).toBe("release");
		expect(result?.button).toBe(0);
		expect(result?.x).toBe(9);
		expect(result?.y).toBe(4);
	});

	it("parses a drag (button held + motion)", () => {
		// 0x20 (motion) | 0 (left button) = 32.
		const result = parseMouseEvent(`${ESC}[<32;12;7M`);
		expect(result?.action).toBe("drag");
		expect(result?.button).toBe(0);
		expect(result?.x).toBe(11);
		expect(result?.y).toBe(6);
	});

	it("parses a bare move (no button, motion)", () => {
		// 0x20 (motion) | 0b11 (no button) = 35.
		const result = parseMouseEvent(`${ESC}[<35;3;3M`);
		expect(result?.action).toBe("move");
	});

	it("decodes modifier bits", () => {
		// left press + shift(4) + alt(8) + ctrl(16) = 28.
		const result = parseMouseEvent(`${ESC}[<28;1;1M`);
		expect(result).toMatchObject({
			action: "press",
			ctrl: true,
			alt: true,
			shift: true,
		});
	});
});

describe("parseMouseEvent — X10 fallback", () => {
	it("parses a legacy X10 report", () => {
		// button=0+32=' ', col=1+32='!', row=1+32='!'.
		const result = parseMouseEvent(`${ESC}[M !!`);
		expect(result).toEqual({
			kind: "mouse",
			button: 0,
			action: "press",
			x: 0,
			y: 0,
			ctrl: false,
			alt: false,
			shift: false,
		});
	});

	it("decodes X10 coordinates offset by 32", () => {
		// button ' ' (0), col '(' (40-32=8 -> 7), row '0' (48-32=16 -> 15).
		const result = parseMouseEvent(`${ESC}[M (0`);
		expect(result?.x).toBe(7);
		expect(result?.y).toBe(15);
	});
});

describe("parseMouseEvent — misc", () => {
	it("returns null for non-mouse input", () => {
		expect(parseMouseEvent(`${ESC}[A`)).toBeNull();
		expect(parseMouseEvent("hello")).toBeNull();
	});

	it("isMouseSequence detects both encodings", () => {
		expect(isMouseSequence(`${ESC}[<0;1;1M`)).toBe(true);
		expect(isMouseSequence(`${ESC}[M !!`)).toBe(true);
		expect(isMouseSequence("plain text")).toBe(false);
	});
});
