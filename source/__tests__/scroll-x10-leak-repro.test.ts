import {EventEmitter} from "node:events";
import {createElement as h} from "react";
import {describe, it, expect} from "vitest";
import render from "../ink/render.js";
import Text from "../ink/components/Text.js";
import useInput from "../ink/hooks/use-input.js";

// Direct verification of the macOS scroll-gibberish fix at the INK LAYER.
//
// After switching back to macOS and scrolling, the terminal can fall back to
// legacy X10 wheel reports (\x1b[M + 3 bytes). Under a scroll flood the 50 ms
// escape timer flushes a lone leading \x1b, so the next read begins with a
// HEADLESS X10 body: `[M`+3 bytes. Before the fix, ink's handleInput had no
// recovery for this shape (matchOrphanedCSI only knew SGR), so those bytes were
// re-emitted on the "input" channel and leaked toward the prompt.
//
// We attach a component whose useInput records EVERY string ink emits, so the
// assertion is sensitive to the ink-layer behaviour itself — independent of any
// downstream stripping in InputPrompt/keybindings.

type FakeStdout = NodeJS.WriteStream & {chunks: string[]};

const makeStdout = (): FakeStdout => {
	const emitter = new EventEmitter() as unknown as FakeStdout;
	emitter.chunks = [];
	emitter.isTTY = true;
	emitter.columns = 80;
	emitter.rows = 24;
	emitter.write = ((data: string) => {
		emitter.chunks.push(data);
		return true;
	}) as FakeStdout["write"];
	return emitter;
};

const makeStdin = (): NodeJS.ReadStream => {
	const emitter = new EventEmitter() as unknown as NodeJS.ReadStream;
	emitter.isTTY = true;
	emitter.setRawMode = (() => emitter) as NodeJS.ReadStream["setRawMode"];
	emitter.resume = (() => emitter) as NodeJS.ReadStream["resume"];
	emitter.pause = (() => emitter) as NodeJS.ReadStream["pause"];
	emitter.read = (() => null) as NodeJS.ReadStream["read"];
	emitter.setEncoding = (() => emitter) as NodeJS.ReadStream["setEncoding"];
	return emitter;
};

// Captures every input string ink re-emits (the raw pre-prompt signal).
const captured: string[] = [];
const Capture = () => {
	useInput((input: string) => {
		captured.push(input);
	});
	return h(Text, null, "capture");
};

const mount = () => {
	const stdout = makeStdout();
	const stdin = makeStdin();
	const instance = render(h(Capture), {
		stdout,
		stdin,
		patchConsole: false,
		exitOnCtrlC: false,
	});
	return {stdout, stdin, instance};
};

// A complete X10 wheel report: \x1b[M + 3 payload bytes (each offset by 32).
const X10_WHEEL = "\x1b[M\x60\x28\x2c";
// The headless X10 body after the escape timer flushed the leading \x1b.
const HEADLESS_X10 = "[M\x60\x28\x2c";

describe("ink layer drops X10 wheel reports (macOS scroll gibberish)", () => {
	it("does not emit any input for a complete X10 wheel report", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		stdin.emit("data", X10_WHEEL);
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toBe("");
		instance.unmount();
	});

	it("does not emit any input for a HEADLESS X10 body (the fix)", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		stdin.emit("data", HEADLESS_X10);
		await instance.waitUntilRenderFlush();

		// Before the fix, `[M`+3 bytes fell through to the input emitter.
		expect(captured.join("")).toBe("");
		instance.unmount();
	});

	it("stays silent across a scroll flood of headless X10 bodies", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		for (let i = 0; i < 10; i++) {
			stdin.emit("data", HEADLESS_X10);
		}
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toBe("");
		instance.unmount();
	});

	it("still delivers a real keystroke after a headless X10 flood", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		stdin.emit("data", HEADLESS_X10);
		stdin.emit("data", "x");
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toBe("x");
		instance.unmount();
	});

	it("does not swallow ordinary text starting with '[' or 'M'", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		// "Menu" has no ESC introducer and is not `[M`+3 bytes; must pass through.
		stdin.emit("data", "Menu");
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toContain("Menu");
		instance.unmount();
	});

	it("does not swallow a bracket followed by non-mouse text", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		// `[note` starts with `[` but the second char is not `M`/`<`.
		stdin.emit("data", "[note");
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toContain("[note");
		instance.unmount();
	});
});
