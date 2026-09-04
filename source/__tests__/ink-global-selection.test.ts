import {EventEmitter} from "node:events";
import {createElement} from "react";
import {beforeEach, describe, expect, it, vi} from "vitest";

const {writeClipboard} = vi.hoisted(() => ({writeClipboard: vi.fn()}));
vi.mock("../ink/termio/clipboard.js", () => ({writeClipboard}));

import render from "../ink/render.js";
import Text from "../ink/components/Text.js";

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

	it("copies the active selection with Kitty Ctrl+Shift+C", async () => {
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
		stdin.emit("data", "\x1b[99;6u");

		expect(writeClipboard).toHaveBeenCalledWith(stdout, "hello");
		instance.unmount();
	});
});
