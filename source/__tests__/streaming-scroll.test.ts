import {EventEmitter} from "node:events";
import {createElement as h} from "react";
import {describe, it, expect} from "vitest";
import render from "../ink/render.js";
import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import ScrollBox from "../ink/components/ScrollBox.js";

// A streamed response is rendered in full inside the app's single scrolling
// document, so that document grows a line at a time while the user is looking
// at it. Two things have to hold at once: parked at the bottom it must follow
// the tail, and scrolled up it must not drift — the incoming lines have to push
// the offset instead of the view.

const ROWS = 24;
const COLS = 80;
const VIEWPORT = 6;

type FakeStdout = NodeJS.WriteStream & {chunks: string[]};

const makeStdout = (): FakeStdout => {
	const emitter = new EventEmitter() as unknown as FakeStdout;
	emitter.chunks = [];
	emitter.isTTY = true;
	emitter.columns = COLS;
	emitter.rows = ROWS;
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
	return emitter;
};

const stripAnsi = (s: string): string =>
	s.replaceAll(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

const visibleRows = (chunks: string[]): string[] => {
	const painted = chunks.filter(chunk => /[a-z0-9]/i.test(stripAnsi(chunk)));
	return stripAnsi(painted.at(-1) ?? "")
		.split("\n")
		.map(l => l.trimEnd())
		.filter(l => l !== "");
};

const settle = async (instance: {waitUntilRenderFlush: () => Promise<void>}) => {
	for (let i = 0; i < 5; i++) {
		// eslint-disable-next-line no-await-in-loop
		await new Promise(resolve => {
			setTimeout(resolve, 40);
		});
		// eslint-disable-next-line no-await-in-loop
		await instance.waitUntilRenderFlush();
	}
};

/** The document's shape while streaming: a growing body in a fixed viewport. */
const pane = (lines: number) =>
	h(
		Box,
		{flexDirection: "column"},
		h(ScrollBox, {
			height: VIEWPORT,
			stickToBottom: false,
			children: Array.from({length: lines}, (_, i) =>
				h(Text, {key: i}, `line ${i}`),
			),
		}),
	);

const wheelUp = (row: number) => `\x1b[<64;10;${row}M`;

const mount = async (lines: number) => {
	const stdout = makeStdout();
	const stdin = makeStdin();
	const instance = render(pane(lines), {
		stdout,
		stdin,
		patchConsole: false,
		exitOnCtrlC: false,
	});
	await settle(instance);
	return {instance, stdout, stdin};
};

describe("document while streaming", () => {
	it("stays capped at its height no matter how much arrives", async () => {
		const {instance, stdout} = await mount(200);
		expect(visibleRows(stdout.chunks)).toHaveLength(VIEWPORT);
		instance.unmount();
	});

	it("follows the tail while parked at the bottom", async () => {
		const {instance, stdout} = await mount(20);
		expect(visibleRows(stdout.chunks).at(-1)).toBe("line 19");

		instance.rerender(pane(30));
		await settle(instance);
		expect(visibleRows(stdout.chunks).at(-1)).toBe("line 29");

		instance.unmount();
	});

	it("survives a terminal resize while scrolled up during active streaming", async () => {
		const {instance, stdout, stdin} = await mount(30);

		// Scroll up a few ticks so we're no longer at the tail.
		stdin.emit("data", Buffer.from(wheelUp(2)));
		stdin.emit("data", Buffer.from(wheelUp(2)));
		await settle(instance);

		const beforeResize = visibleRows(stdout.chunks);
		expect(beforeResize.length).toBe(VIEWPORT);

		// Simulate a terminal resize: shrink rows and widen columns.
		stdout.rows = 16;
		stdout.columns = 120;
		stdout.emit("resize");
		await settle(instance);

		const afterResize = visibleRows(stdout.chunks);
		// The viewport should still render exactly VIEWPORT rows (height is
		// fixed by the ScrollBox, not by the terminal), and the content should
		// consist of valid "line N" entries — i.e. it didn't crash or garble.
		expect(afterResize.length).toBe(VIEWPORT);
		for (const row of afterResize) {
			expect(row).toMatch(/^line \d+$/);
		}

		instance.unmount();
	});

	it("holds its place when new lines arrive after the user scrolls up", async () => {
		const {instance, stdout, stdin} = await mount(20);

		// One tick up: WHEEL_STEP is 3, so the tail moves off by three lines.
		stdin.emit("data", Buffer.from(wheelUp(2)));
		await settle(instance);
		const parked = visibleRows(stdout.chunks);
		expect(parked.at(-1)).toBe("line 16");

		// Ten more lines stream in. The same ten rows must still be on screen.
		instance.rerender(pane(30));
		await settle(instance);
		expect(visibleRows(stdout.chunks)).toEqual(parked);

		instance.unmount();
	});
});
