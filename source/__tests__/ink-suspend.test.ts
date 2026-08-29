import {EventEmitter} from "node:events";
import {createElement} from "react";
import {describe, it, expect, vi} from "vitest";
import render, {type Instance} from "../ink/render.js";
import Text from "../ink/components/Text.js";

// A raw-stdout picker (/model, /resume) draws to the terminal itself. Ink has
// to stop repainting *before* the picker's first write, otherwise the frame
// React already scheduled lands on top and erases the picker by line count.
// These tests pin that ordering.

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
	emitter.setRawMode = (() => emitter) as NodeJS.ReadStream["setRawMode"];
	emitter.resume = (() => emitter) as NodeJS.ReadStream["resume"];
	emitter.pause = (() => emitter) as NodeJS.ReadStream["pause"];
	emitter.setEncoding = (() =>
		emitter) as unknown as NodeJS.ReadStream["setEncoding"];
	emitter.read = (() => null) as NodeJS.ReadStream["read"];
	return emitter;
};

const mount = (
	text: string,
	options: {alternateScreen?: boolean} = {},
): {instance: Instance; stdout: FakeStdout; stdin: NodeJS.ReadStream} => {
	const stdout = makeStdout();
	const stdin = makeStdin();
	const instance = render(createElement(Text, null, text), {
		stdout,
		stdin,
		patchConsole: false,
		exitOnCtrlC: false,
		...options,
	});
	return {instance, stdout, stdin};
};

// RIS ("ESC c") is a full terminal reset: it drops the alternate screen buffer,
// mouse tracking, bracketed paste and the kitty keyboard flags. Ink only arms
// those on mount, so a single RIS anywhere in the app permanently hands the
// viewport back to the terminal — native scrollbar returns, agav's own
// wheel-driven ScrollBox goes dead. Nothing may emit it.
const RIS = String.fromCharCode(27) + "c";

describe("ink terminal suspension", () => {
	it("swallows frames committed while suspended, then repaints on resume", async () => {
		const {instance, stdout} = mount("first");
		await instance.waitUntilRenderFlush();
		expect(stdout.text()).toContain("first");

		const resume = instance.suspendTerminal();
		stdout.chunks.length = 0;

		// This is the commit that used to race the picker: it is scheduled before
		// the picker draws and flushes afterwards.
		instance.rerender(createElement(Text, null, "second"));
		await instance.waitUntilRenderFlush();
		expect(stdout.text()).not.toContain("second");

		// The picker's own output survives untouched.
		stdout.write("PICKER");

		resume();
		expect(stdout.text()).toContain("second");

		instance.unmount();
	});

	it("stops listening to stdin while suspended and listens again after", async () => {
		const {instance, stdin} = mount("hello");
		await instance.waitUntilRenderFlush();

		const before = stdin.listenerCount("data");
		expect(before).toBeGreaterThan(0);

		const resume = instance.suspendTerminal();
		expect(stdin.listenerCount("data")).toBe(before - 1);

		resume();
		expect(stdin.listenerCount("data")).toBe(before);

		instance.unmount();
	});

	it("re-resumes stdin, which raw-stdout pickers pause on their way out", async () => {
		const {instance, stdin} = mount("hello");
		await instance.waitUntilRenderFlush();

		const resume = instance.suspendTerminal();
		const resumeSpy = vi.spyOn(stdin, "resume");
		resume();

		expect(resumeSpy).toHaveBeenCalled();
		instance.unmount();
	});

	it("only repaints once nested suspensions have all resumed", async () => {
		const {instance, stdout} = mount("first");
		await instance.waitUntilRenderFlush();

		const outer = instance.suspendTerminal();
		const inner = instance.suspendTerminal();
		instance.rerender(createElement(Text, null, "second"));
		await instance.waitUntilRenderFlush();
		stdout.chunks.length = 0;

		inner();
		expect(stdout.text()).not.toContain("second");

		outer();
		expect(stdout.text()).toContain("second");

		instance.unmount();
	});

	it("clears the alternate screen on resume, since the picker's leftovers are unknowable", async () => {
		const {instance, stdout} = mount("first", {alternateScreen: true});
		await instance.waitUntilRenderFlush();

		const resume = instance.suspendTerminal();
		stdout.write("PICKER LEFTOVERS");
		stdout.chunks.length = 0;
		resume();

		const written = stdout.text();
		expect(written).toContain("[2J");
		expect(written).toContain("first");
		// Never by dropping back to the main buffer.
		expect(written).not.toContain("[?1049l");

		instance.unmount();
	});

	it("resuming twice is a no-op", async () => {
		const {instance, stdout, stdin} = mount("first");
		await instance.waitUntilRenderFlush();

		const resume = instance.suspendTerminal();
		resume();
		const listeners = stdin.listenerCount("data");
		stdout.chunks.length = 0;

		resume();
		expect(stdin.listenerCount("data")).toBe(listeners);
		expect(stdout.chunks).toHaveLength(0);

		instance.unmount();
	});
});

describe("resetDisplay", () => {
	it("erases and repaints without resetting the terminal", async () => {
		const {instance, stdout} = mount("hello", {alternateScreen: true});
		await instance.waitUntilRenderFlush();
		stdout.chunks.length = 0;

		instance.resetDisplay();

		const written = stdout.text();
		expect(written).toContain("[2J"); // erase display
		expect(written).toContain("[H"); // cursor home
		expect(written).toContain("hello"); // repainted straight away
		expect(written).not.toContain(RIS);
		expect(written).not.toContain("[?1049l"); // still on the alt screen
		expect(written).not.toContain("[?1000l"); // mouse tracking still armed

		instance.unmount();
	});

	it("does not emit eraseLines for a frame it just erased", async () => {
		const {instance, stdout} = mount("hello", {alternateScreen: true});
		await instance.waitUntilRenderFlush();
		stdout.chunks.length = 0;

		instance.resetDisplay();

		// ansi-escapes' eraseLines is a run of "[2K" + "[1A". Cursor-up after a
		// full clear would drag the repaint off the top of the screen.
		expect(stdout.text()).not.toContain("[1A");

		instance.unmount();
	});
});

describe("the app never hard-resets the terminal", () => {
	it("no source file emits RIS", async () => {
		const {execFileSync} = await import("node:child_process");
		// Matches the source text `\x1Bc` / `\x1bc`, plus a real ESC byte followed
		// by `c`. grep exits 1 when nothing matches, which is the passing case.
		let hits = "";
		try {
			hits = execFileSync(
				"grep",
				[
					"-rlE",
					String.raw`\\x1[Bb]c|` + String.fromCharCode(27) + "c",
					"source",
					"--include=*.ts",
					"--include=*.tsx",
				],
				{encoding: "utf8"},
			);
		} catch {
			hits = "";
		}

		const offenders = hits
			.split("\n")
			.filter(Boolean)
			.filter(file => !file.endsWith("ink-suspend.test.ts"));

		expect(offenders).toEqual([]);
	});
});
