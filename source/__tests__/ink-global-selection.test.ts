import {EventEmitter} from "node:events";
import {createElement} from "react";
import {beforeEach, describe, expect, it, vi} from "vitest";

const {writeClipboard} = vi.hoisted(() => ({writeClipboard: vi.fn()}));
vi.mock("../ink/termio/clipboard.js", () => ({writeClipboard}));

import render from "../ink/render.js";
import Ink from "../ink/ink.js";
import Text from "../ink/components/Text.js";
import Box from "../ink/components/Box.js";
import ClickableLine from "../components/clickable-line.js";
import {buildClickableLines} from "../utils/render-clickable.js";
import {DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING} from "../ink/termio/dec.js";

type FakeStdout = NodeJS.WriteStream & {chunks: string[]};

const makeStdout = (): FakeStdout => {
	const stdout = new EventEmitter() as unknown as FakeStdout;
	stdout.chunks = [];
	stdout.isTTY = true;
	stdout.columns = 80;
	stdout.rows = 24;
	stdout.write = ((data: string) => {
		stdout.chunks.push(data);
		return true;
	}) as FakeStdout["write"];
	return stdout;
};

const makeStdin = (): NodeJS.ReadStream => {
	const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
	stdin.isTTY = true;
	stdin.setRawMode = (() => stdin) as NodeJS.ReadStream["setRawMode"];
	stdin.resume = (() => stdin) as NodeJS.ReadStream["resume"];
	stdin.pause = (() => stdin) as NodeJS.ReadStream["pause"];
	stdin.setEncoding = (() => stdin) as unknown as NodeJS.ReadStream["setEncoding"];
	stdin.read = (() => null) as NodeJS.ReadStream["read"];
	return stdin;
};

describe("global text selection", () => {
	beforeEach(() => writeClipboard.mockClear());

	it.each(["\x03", "\x1b[99;5u", "\x1b[3;5u", "a\x1b[99;5ub", "\x1b[99;5utext", "text\x1b[3;5u"])("exits on Ctrl+C (%j) without a selection", async (input) => {
		const stdout = makeStdout();
		const stdin = makeStdin();
		const instance = render(createElement(Text, null, "hello"), {
			stdout, stdin, patchConsole: false, exitOnCtrlC: true,
		});
		await instance.waitUntilRenderFlush();
		try {
			stdin.emit("data", input);
			expect(stdin.listenerCount("data")).toBe(0);
		} finally {
			instance.unmount();
		}
	});

	it.each(["\x1b[99;5u", "\x1b[3;5u"])("copies and keeps the active selection on enhanced Ctrl+C (%j)", async (input) => {
		const stdout = makeStdout();
		const stdin = makeStdin();
		const instance = render(createElement(Text, null, "hello"), {
			stdout, stdin, patchConsole: false, exitOnCtrlC: true,
		});
		await instance.waitUntilRenderFlush();
		try {
			stdin.emit("data", "\x1b[<0;1;1M");
			stdin.emit("data", "\x1b[<0;6;1m");
			writeClipboard.mockClear();

			stdin.emit("data", input);
			expect(writeClipboard).toHaveBeenCalledTimes(1);
			expect(writeClipboard).toHaveBeenCalledWith(stdout, "hello");
			expect(stdin.listenerCount("data")).toBe(1);

			stdin.emit("data", input + input);
			expect(writeClipboard).toHaveBeenCalledTimes(2);
			expect(writeClipboard).toHaveBeenLastCalledWith(stdout, "hello");
			expect(stdin.listenerCount("data")).toBe(1);
		} finally {
			instance.unmount();
		}
	});

	it.each(["\x03", "\x1b[99;5u", "\x1b[3;5u"])("does not exit on Ctrl+C when exitOnCtrlC is false (%j)", async (input) => {
		const stdout = makeStdout();
		const stdin = makeStdin();
		const instance = render(createElement(Text, null, "hello"), {
			stdout, stdin, patchConsole: false, exitOnCtrlC: false,
		});
		await instance.waitUntilRenderFlush();
		try {
			stdin.emit("data", input);
			expect(stdin.listenerCount("data")).toBe(1);
			expect(writeClipboard).not.toHaveBeenCalled();
		} finally {
			instance.unmount();
		}
	});

	it.each(["\x1b", "\x1b[99;9u", "\x1b[99;13u", "\x1b[99;6u", "\x1b[3;5~", "\x1b[99;5:3u", "\x1b[3;5:3u"])("does not exit on Esc, Cmd+C, or key release (%j)", async (input) => {
		const stdout = makeStdout();
		const stdin = makeStdin();
		const instance = render(createElement(Text, null, "hello"), {
			stdout, stdin, patchConsole: false, exitOnCtrlC: true,
		});
		await instance.waitUntilRenderFlush();
		try {
			stdin.emit("data", input);
			expect(stdin.listenerCount("data")).toBe(1);
		} finally {
			instance.unmount();
		}
	});

	it.each(["\x1b[200~paste\x1b[201~", "\x1b[200~partial", "\x1b[<0;1;1M\x1b[<0;6;1m", "\x1b["])("stops the whole input drain on enhanced Ctrl+C before %j", async (rest) => {
		const stdout = makeStdout();
		const stdin = makeStdin();
		const instance = new Ink({
			stdout, stdin, stderr: stdout, patchConsole: false, exitOnCtrlC: true,
			alternateScreen: false, maxFps: 30,
		});
		instance.render(createElement(Text, null, "hello"));
		await instance.waitUntilRenderFlush();
		const ink = instance as any;
		// Observe the bus directly: components may unsubscribe on unmount.
		const events: string[] = [];
		ink.internalEventEmitter.on("input", () => events.push("input"));
		ink.internalEventEmitter.on("paste", () => events.push("paste"));
		try {
			stdin.emit("data", "\x1b[99;5u" + rest + "after");
			const writes = stdout.chunks.length;
			await new Promise(resolve => setTimeout(resolve, 60));
			expect(events).toEqual([]);
			expect(writeClipboard).not.toHaveBeenCalled();
			expect(stdout.chunks).toHaveLength(writes);
			expect(ink.pasteBuffer).toBeUndefined();
			expect(ink.mouseBuffer).toBeUndefined();
		} finally {
			instance.unmount();
		}
	});

	it.each([false, true])("copies soft wraps without losing hard breaks (clickable: %j)", async (clickable) => {
		const stdout = makeStdout();
		stdout.columns = 12;
		const stdin = makeStdin();
		const text = "implemented by other code.\n\nnext paragraph\ncode line";
		const lines = buildClickableLines(text, 10,
			[{kind: "url", text: "other", start: 15, end: 20}], () => "id", {});
		const tree = clickable
			? createElement(Box, {flexDirection: "column"}, ...lines.map((runs, i) =>
				createElement(ClickableLine, {key: i, runs: [{text: "  "}, ...runs]})))
			: createElement(Box, {paddingLeft: 2}, createElement(Text, null, text));
		const instance = new Ink({stdout, stdin, stderr: stdout, patchConsole: false,
			exitOnCtrlC: false, alternateScreen: false, maxFps: 30});
		instance.render(tree);
		await instance.waitUntilRenderFlush();
		try {
			const rows = (instance as any).lastOutput.split("\n");
			stdin.emit("data", "\x1b[<0;3;1M");
			stdin.emit("data", `\x1b[<0;${rows.at(-1).length + 1};${rows.length}m`);
			expect(writeClipboard).toHaveBeenLastCalledWith(stdout, text);
		} finally {
			instance.unmount();
		}
	});

	it("copies a normal left-button drag when it is released", async () => {
		const stdout = makeStdout();
		const stdin = makeStdin();
		const instance = render(createElement(Text, null, "hello"), {
			stdout,
			stdin,
			patchConsole: false,
			exitOnCtrlC: false,
		});
		await instance.waitUntilRenderFlush();

		stdin.emit("data", "\x1b[<0;1;1M");
		stdin.emit("data", "\x1b[<32;6;1M");
		stdin.emit("data", "\x1b[<0;6;1m");

		expect(writeClipboard).toHaveBeenCalledWith(stdout, "hello");
		instance.unmount();
	});

	it.each([
		["\x1b[99;6u", false], ["\x1b[99;6u", true],
		["\x1b[99;9u", false], ["\x1b[99;9u", true],
	] as const)("copies the active selection with Kitty copy shortcut (%j, exitOnCtrlC: %j)", async (input, exitOnCtrlC) => {
		const stdout = makeStdout();
		const stdin = makeStdin();
		const instance = render(createElement(Text, null, "hello"), {
			stdout,
			stdin,
			patchConsole: false,
			exitOnCtrlC,
		});
		await instance.waitUntilRenderFlush();
		try {
			stdin.emit("data", "\x1b[<0;1;1M");
			stdin.emit("data", "\x1b[<32;6;1M");
			stdin.emit("data", input);

			expect(writeClipboard).toHaveBeenCalledWith(stdout, "hello");
			expect(stdin.listenerCount("data")).toBe(1);
		} finally {
			instance.unmount();
		}
	});

	it("uses a release-only mouse report to copy a drag", async () => {
		const stdout = makeStdout();
		const stdin = makeStdin();
		const instance = render(createElement(Text, null, "hello"), {
			stdout,
			stdin,
			patchConsole: false,
			exitOnCtrlC: false,
		});
		await instance.waitUntilRenderFlush();

		stdin.emit("data", "\x1b[<0;1;1M");
		stdin.emit("data", "\x1b[<0;6;1m");

		expect(writeClipboard).toHaveBeenCalledWith(stdout, "hello");
		instance.unmount();
	});

	it("ignores right-click reports so the host's native context menu handles them", async () => {
		const stdout = makeStdout();
		const stdin = makeStdin();
		const instance = render(createElement(Text, null, "hello"), {
			stdout,
			stdin,
			patchConsole: false,
			exitOnCtrlC: false,
		});
		await instance.waitUntilRenderFlush();

		// A right-click press must not touch the clipboard or selection state,
		// and must re-assert mouse tracking (DISABLE then ENABLE) to reset the
		// terminal's button-state machine — otherwise xterm.js in Cursor is left
		// believing a button is held and every later click breaks.
		const before = stdout.chunks.length;
		stdin.emit("data", "\x1b[<2;3;1M");

		expect(writeClipboard).not.toHaveBeenCalled();
		const written = stdout.chunks.slice(before).join("");
		const disableIdx = written.indexOf(DISABLE_MOUSE_TRACKING);
		const enableIdx = written.indexOf(ENABLE_MOUSE_TRACKING);
		expect(disableIdx).toBeGreaterThanOrEqual(0);
		expect(enableIdx).toBeGreaterThan(disableIdx);
		instance.unmount();
	});

	it("a left-drag still works after a stray right-click", async () => {
		const stdout = makeStdout();
		const stdin = makeStdin();
		const instance = render(createElement(Text, null, "hello"), {
			stdout,
			stdin,
			patchConsole: false,
			exitOnCtrlC: false,
		});
		await instance.waitUntilRenderFlush();

		// Right-click first (ignored), then a normal left-drag selection: the
		// dropped right-click must not have wedged any selection state.
		stdin.emit("data", "\x1b[<2;3;1M");
		stdin.emit("data", "\x1b[<0;1;1M");
		stdin.emit("data", "\x1b[<32;6;1M");
		stdin.emit("data", "\x1b[<0;6;1m");

		expect(writeClipboard).toHaveBeenCalledWith(stdout, "hello");
		instance.unmount();
	});

	it("copies an active selection when CMD reports Ctrl+Shift+C as Ctrl+C", async () => {
		const stdout = makeStdout();
		const stdin = makeStdin();
		const instance = render(createElement(Text, null, "hello"), {
			stdout,
			stdin,
			patchConsole: false,
			exitOnCtrlC: true,
		});
		await instance.waitUntilRenderFlush();

		stdin.emit("data", "\x1b[<0;1;1M");
		stdin.emit("data", "\x1b[<0;6;1m");
		writeClipboard.mockClear();
		stdin.emit("data", "\x03");

		expect(writeClipboard).toHaveBeenCalledWith(stdout, "hello");
		instance.unmount();
	});
});
