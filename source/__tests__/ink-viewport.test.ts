import {EventEmitter} from "node:events";
import {createElement as h, useEffect, useRef, useState} from "react";
import {describe, it, expect} from "vitest";
import render from "../ink/render.js";
import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import ScrollBox from "../ink/components/ScrollBox.js";
import {measureElement} from "../ink/measure-element.js";
import type {DOMElement} from "../ink/dom.js";
import type {WheelEventData} from "../ink/types.js";

// Two invariants the app depends on and used to violate:
//
//  1. The frame must never be taller than the terminal. When it is, the
//     terminal scrolls, log-update's eraseLines() can no longer reach the rows
//     it wrote, and every subsequent repaint smears. The app used to reserve a
//     flat 8 rows for chrome whose real height is unbounded.
//  2. A wheel event must reach the transcript wherever the pointer is. Mouse
//     tracking is on, so the terminal will not scroll on the user's behalf; an
//     event that finds no handler means no scrolling at all.

const ROWS = 30;
const COLS = 80;

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

/** Height in rows of the last frame that actually carried text. */
const lastFrameHeight = (chunks: string[]): number => {
	const painted = chunks.filter(chunk => /[a-z0-9]/i.test(stripAnsi(chunk)));
	return stripAnsi(painted.at(-1) ?? "").split("\n").length;
};

const transcript = Array.from({length: 40}, (_, i) =>
	h(
		Box,
		{key: `m${i}`, flexDirection: "column", marginBottom: 1},
		h(Text, null, `message ${i} line A`),
		h(Text, null, `message ${i} line B`),
	),
);

/** The shape app.tsx renders: frame pinned to the terminal, chrome measured. */
const AppShape = ({
	chromeLines,
	onRootWheel,
}: {
	chromeLines: number;
	onRootWheel?: (direction: string) => void;
}) => {
	const chromeRef = useRef<DOMElement | null>(null);
	const [chromeHeight, setChromeHeight] = useState(8);

	useEffect(() => {
		const measured = measureElement(chromeRef.current).height;
		if (measured > 0 && measured !== chromeHeight) setChromeHeight(measured);
	});

	const viewport = Math.max(3, ROWS - chromeHeight);

	return h(
		Box,
		{
			flexDirection: "column",
			height: ROWS,
			onWheel: (event: WheelEventData) => onRootWheel?.(event.direction),
		},
		h(ScrollBox, {
			height: viewport,
			scrollOffset: 0,
			onScrollChange() {},
			children: transcript,
		}),
		h(
			Box,
			{flexDirection: "column", flexShrink: 0, ref: chromeRef},
			...Array.from({length: chromeLines}, (_, i) =>
				h(Text, {key: `c${i}`}, `chrome ${i}`),
			),
		),
	);
};

const settle = async (instance: {waitUntilRenderFlush: () => Promise<void>}) => {
	// measure -> setState -> repaint needs a few frames to converge.
	for (let i = 0; i < 5; i++) {
		// eslint-disable-next-line no-await-in-loop
		await new Promise(resolve => {
			setTimeout(resolve, 40);
		});
		// eslint-disable-next-line no-await-in-loop
		await instance.waitUntilRenderFlush();
	}
};

const mountAppShape = async (
	chromeLines: number,
	onRootWheel?: (direction: string) => void,
) => {
	const stdout = makeStdout();
	const stdin = makeStdin();
	const instance = render(h(AppShape, {chromeLines, onRootWheel}), {
		stdout,
		stdin,
		patchConsole: false,
		exitOnCtrlC: false,
	});
	await settle(instance);
	return {instance, stdout, stdin};
};

describe("frame height", () => {
	// +1 because the frame is written with a trailing newline.
	const maxLines = ROWS + 1;

	it.each([4, 8, 20, 40])(
		"stays within the terminal with %i rows of chrome",
		async chromeLines => {
			const {instance, stdout} = await mountAppShape(chromeLines);
			expect(lastFrameHeight(stdout.chunks)).toBeLessThanOrEqual(maxLines);
			instance.unmount();
		},
	);

	it("measureElement reports the laid-out height", async () => {
		let measured = -1;
		const Probe = () => {
			const ref = useRef<DOMElement | null>(null);
			useEffect(() => {
				measured = measureElement(ref.current).height;
			});
			return h(
				Box,
				{flexDirection: "column", ref},
				...Array.from({length: 7}, (_, i) => h(Text, {key: i}, `row ${i}`)),
			);
		};

		const stdout = makeStdout();
		const instance = render(h(Probe), {
			stdout,
			stdin: makeStdin(),
			patchConsole: false,
			exitOnCtrlC: false,
		});
		await settle(instance);
		expect(measured).toBe(7);
		instance.unmount();
	});
});

describe("wheel routing", () => {
	// SGR wheel-up: CSI < 64 ; col ; row M
	const wheelUpAtRow = (row: number) => `\x1b[<64;10;${row}M`;

	it("bubbles to the root when the pointer is over the chrome", async () => {
		const seen: string[] = [];
		const {instance, stdin} = await mountAppShape(6, d => seen.push(d));

		stdin.emit("data", Buffer.from(wheelUpAtRow(28)));
		await settle(instance);

		expect(seen).toEqual(["up"]);
		instance.unmount();
	});

	it("is consumed by the ScrollBox when the pointer is over the transcript", async () => {
		const seen: string[] = [];
		const {instance, stdin} = await mountAppShape(6, d => seen.push(d));

		stdin.emit("data", Buffer.from(wheelUpAtRow(2)));
		await settle(instance);

		// ScrollBox handled it and stopped propagation, so the root's handler
		// must not fire — otherwise the transcript scrolls twice per tick.
		expect(seen).toEqual([]);
		instance.unmount();
	});

	it("still reaches a handler when the pointer is outside the frame", async () => {
		const seen: string[] = [];
		const {instance, stdin} = await mountAppShape(6, d => seen.push(d));

		stdin.emit("data", Buffer.from(wheelUpAtRow(200)));
		await settle(instance);

		expect(seen).toEqual(["up"]);
		instance.unmount();
	});
});

describe("message rows", () => {
	it("emits blank margin rows with no lingering background", async () => {
		const {instance, stdout} = await mountAppShape(6);
		const painted = stdout.chunks.filter(chunk =>
			/[a-z0-9]/i.test(stripAnsi(chunk)),
		);

		for (const line of (painted.at(-1) ?? "").split("\n")) {
			if (stripAnsi(line).trim() !== "") continue;
			// A blank row carrying a background code paints a full-width bar.
			const codes = [...line.matchAll(/\x1b\[([0-9;]*)m/g)].flatMap(m =>
				(m[1] ?? "").split(";").map(Number),
			);
			const hasBackground = codes.some(
				code => (code >= 40 && code <= 49) || (code >= 100 && code <= 107),
			);
			expect(hasBackground).toBe(false);
		}

		instance.unmount();
	});
});
