// Parser for terminal mouse reports. Supports the SGR extended encoding
// (\x1b[<b;col;rowM / m) and the legacy X10 encoding (\x1b[M + 3 bytes).
//
// Button field bit layout (shared by both encodings):
//   low 2 bits  -> button (0=left, 1=middle, 2=right)
//   0x04 (4)    -> shift modifier
//   0x08 (8)    -> alt/meta modifier
//   0x10 (16)   -> ctrl modifier
//   0x20 (32)   -> motion / drag
//   0x40 (64)   -> wheel (low bit: 0=up, 1=down)
//
// Coordinates in the protocol are 1-indexed; the parsed result is 0-indexed.

/** SGR mouse report: \x1b[<button;col;row(M|m). */
export const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

/** Legacy X10 mouse report: \x1b[M followed by 3 bytes (button, col, row). */
// eslint-disable-next-line no-control-regex
export const X10_MOUSE_RE = /\x1b\[M([\s\S])([\s\S])([\s\S])/;

/** All recognized mouse report shapes. */
export const MOUSE_SEQUENCE_RE = [SGR_MOUSE_RE, X10_MOUSE_RE] as const;

export type MouseAction = "press" | "release" | "drag" | "move";

export type ParsedMouse = {
	kind: "mouse";
	button: number;
	action: MouseAction;
	wheel?: "up" | "down";
	x: number;
	y: number;
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
};

// Button field bit masks.
const BUTTON_MASK = 0b11;
const SHIFT_BIT = 0x04;
const ALT_BIT = 0x08;
const CTRL_BIT = 0x10;
const MOTION_BIT = 0x20;
const WHEEL_BIT = 0x40;

/** Returns true if the string starts with a recognized mouse report. */
export const isMouseSequence = (s: string): boolean =>
	MOUSE_SEQUENCE_RE.some(re => re.test(s));

type Decoded = Pick<
	ParsedMouse,
	"button" | "action" | "wheel" | "ctrl" | "alt" | "shift"
>;

/**
 * Decode the raw button field into button number, action, wheel direction, and
 * modifiers. `released` indicates an SGR release report (trailing 'm'); the
 * legacy X10 encoding cannot represent releases distinctly.
 */
const decodeButtonField = (field: number, released: boolean): Decoded => {
	const shift = (field & SHIFT_BIT) !== 0;
	const alt = (field & ALT_BIT) !== 0;
	const ctrl = (field & CTRL_BIT) !== 0;

	const isWheel = (field & WHEEL_BIT) !== 0;

	if (isWheel) {
		const wheel: "up" | "down" = (field & 1) === 0 ? "up" : "down";
		return {
			button: field & BUTTON_MASK,
			action: "move",
			wheel,
			ctrl,
			alt,
			shift,
		};
	}

	const isMotion = (field & MOTION_BIT) !== 0;
	const button = field & BUTTON_MASK;

	let action: MouseAction;
	if (released) {
		action = "release";
	} else if (isMotion) {
		// With a button held, motion is a drag; button 3 (0b11) with motion is a
		// bare move (no button pressed).
		action = button === BUTTON_MASK ? "move" : "drag";
	} else {
		action = "press";
	}

	return {button, action, ctrl, alt, shift};
};

/**
 * Parse a single SGR or X10 mouse report from the start of `sequence`.
 * Returns a typed, 0-indexed result, or null if no mouse report is present.
 */
export const parseMouseEvent = (sequence: string): ParsedMouse | null => {
	const sgr = SGR_MOUSE_RE.exec(sequence);
	if (sgr) {
		const field = Number.parseInt(sgr[1]!, 10);
		const col = Number.parseInt(sgr[2]!, 10);
		const row = Number.parseInt(sgr[3]!, 10);
		const released = sgr[4] === "m";

		return {
			kind: "mouse",
			x: col - 1,
			y: row - 1,
			...decodeButtonField(field, released),
		};
	}

	const x10 = X10_MOUSE_RE.exec(sequence);
	if (x10) {
		// Each byte is offset by 32 in the X10 encoding.
		const field = x10[1]!.charCodeAt(0) - 32;
		const col = x10[2]!.charCodeAt(0) - 32;
		const row = x10[3]!.charCodeAt(0) - 32;

		return {
			kind: "mouse",
			x: col - 1,
			y: row - 1,
			...decodeButtonField(field, false),
		};
	}

	return null;
};
