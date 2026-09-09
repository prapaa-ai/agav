import {EventEmitter} from "node:events";
import {createElement} from "react";
import {describe, it, expect, beforeEach, afterEach, vi} from "vitest";
import render from "../ink/render.js";
import Text from "../ink/components/Text.js";
import {ENABLE_MOUSE_TRACKING} from "../ink/termio/dec.js";

// Laptop sleep/wake, lid close, Space switch, display change, tmux
// detach→attach and ssh reconnect can leave the terminal having silently reset
// DEC private modes (mouse tracking, kitty keyboard) with no signal Ink can
// hook. The next keystroke then lands in a terminal whose state no longer
// matches Ink's, and mouse/key sequences leak into the prompt as gibberish —
// the macOS "idle then type" symptom in Cursor's terminal. Ink guards against
// this by re-asserting the modes on the first stdin chunk after a long gap.
// These tests pin that behavior around the 5s threshold.

type FakeStdout = NodeJS.WriteStream & {chunks: string[]; text: () => string};

const makeStdout = (): FakeStdout => {
	const emitter = new EventEmitter() as unknown as FakeStdout;
	const chunks: string[] = [];
	emitter.chunks = chunks;
	emitter.text = () => chunks.join("");
	emitter.isTTY = true;
	emitter.columns = 80;
	emitter.rows = 24;
	emitter.write = ((data: string) => {
		chunks.push(data);
		return true;
	}) as FakeStdout["write"];
	return emitter;
};

const makeStdin = (): NodeJS.ReadStream => {
	const emitter = new EventEmitter() as unknown as NodeJS.ReadStream;
	emitter.isTTY = true;
	emitter.setRawMode = (() =>
		emitter) as unknown as NodeJS.ReadStream["setRawMode"];
	emitter.resume = (() => emitter) as unknown as NodeJS.ReadStream["resume"];
	emitter.pause = (() => emitter) as unknown as NodeJS.ReadStream["pause"];
	emitter.setEncoding = (() =>
		emitter) as unknown as NodeJS.ReadStream["setEncoding"];
	emitter.read = (() => null) as unknown as NodeJS.ReadStream["read"];
	return emitter;
};

const mount = (
	options: {kittyKeyboard?: {mode: "enabled" | "disabled"; flags?: string[]}} = {},
): {stdin: NodeJS.ReadStream; stdout: FakeStdout; unmount: () => void} => {
	const stdout = makeStdout();
	const stdin = makeStdin();
	const instance = render(createElement(Text, null, "hi"), {
		stdout,
		stdin,
		patchConsole: false,
		exitOnCtrlC: false,
		...options,
	} as Parameters<typeof render>[1]);
	return {stdin, stdout, unmount: () => instance.unmount()};
};

// Count how many times the mouse-tracking enable sequence appears in what has
// been written to stdout since a given index.
const mouseEnablesSince = (stdout: FakeStdout, since: number): number =>
	stdout.chunks.slice(since).filter((c) => c.includes(ENABLE_MOUSE_TRACKING)).length;

describe("stdin gap terminal-mode re-assert", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("re-asserts mouse tracking on the first input after a >5s idle gap", () => {
		const {stdin, stdout, unmount} = mount();
		const mark = stdout.chunks.length;

		// A rapid keystroke soon after mount must NOT re-assert.
		vi.advanceTimersByTime(500);
		stdin.emit("data", Buffer.from("a"));
		expect(mouseEnablesSince(stdout, mark)).toBe(0);

		// After a >5s silence, the next keystroke re-asserts mouse tracking.
		vi.advanceTimersByTime(6000);
		stdin.emit("data", Buffer.from("b"));
		expect(mouseEnablesSince(stdout, mark)).toBe(1);

		unmount();
	});

	it("does not re-assert on rapid successive input", () => {
		const {stdin, stdout, unmount} = mount();
		const mark = stdout.chunks.length;

		for (let i = 0; i < 5; i++) {
			vi.advanceTimersByTime(100);
			stdin.emit("data", Buffer.from("x"));
		}
		expect(mouseEnablesSince(stdout, mark)).toBe(0);

		unmount();
	});

	it("pops before pushing the kitty keyboard flags on re-assert (balanced stack)", () => {
		const {stdin, stdout, unmount} = mount({
			kittyKeyboard: {mode: "enabled", flags: ["disambiguateEscapeCodes"]},
		});
		const mark = stdout.chunks.length;

		vi.advanceTimersByTime(6000);
		stdin.emit("data", Buffer.from("k"));

		const written = stdout.chunks.slice(mark).join("");
		// The pop (CSI < u) must be emitted, and it must come before the push
		// (CSI > <flags> u) so the kitty stack depth stays at exactly one.
		const popIdx = written.indexOf("\x1b[<u");
		const pushIdx = written.search(/\x1b\[>\d+u/);
		expect(popIdx).toBeGreaterThanOrEqual(0);
		expect(pushIdx).toBeGreaterThanOrEqual(0);
		expect(popIdx).toBeLessThan(pushIdx);

		unmount();
	});

	it("does not touch the kitty stack when kitty keyboard is disabled", () => {
		const {stdin, stdout, unmount} = mount({
			kittyKeyboard: {mode: "disabled"},
		});
		const mark = stdout.chunks.length;

		vi.advanceTimersByTime(6000);
		stdin.emit("data", Buffer.from("z"));

		const written = stdout.chunks.slice(mark).join("");
		// Mouse tracking still re-asserts, but no kitty pop/push.
		expect(written).toContain(ENABLE_MOUSE_TRACKING);
		expect(written).not.toContain("\x1b[<u");

		unmount();
	});
});
