import {EventEmitter} from "node:events";
import {createElement as h, useState} from "react";
import {describe, it, expect} from "vitest";
import render from "../ink/render.js";
import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import ScrollBox from "../ink/components/ScrollBox.js";
import type {ScrollBoxControls} from "../ink/components/ScrollBox.js";
import type {WheelEventData} from "../ink/types.js";
import {wheelSelect, stepIndex} from "../components/wheel-select.js";

// Opening a command overlay (`/skills`, `/agents`, ...) squeezes the transcript
// down to its three-row floor, because the overlay renders inside the app's
// chrome. Before this, the overlay had no wheel handler of its own, so pointing
// at the long list and scrolling bubbled to the root and moved those three rows
// — indistinguishable from a frozen UI. Each overlay now consumes the wheel.

const ROWS = 24;
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

const lastFrame = (chunks: string[]): string => {
	const painted = chunks.filter(chunk => /[a-z0-9]/i.test(stripAnsi(chunk)));
	return stripAnsi(painted.at(-1) ?? "");
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

const ITEMS = Array.from({length: 30}, (_, i) => `item ${i}`);

/** The shape app.tsx renders while an overlay is open: overlay inside chrome. */
const OverlayShape = ({
	onRootWheel,
}: {
	onRootWheel?: (direction: string) => void;
}) => {
	const [selected, setSelected] = useState(0);
	const handleWheel = wheelSelect(delta => {
		setSelected(i => stepIndex(i, delta, ITEMS.length));
	});

	return h(
		Box,
		{
			flexDirection: "column",
			height: ROWS,
			onWheel: (event: WheelEventData) => onRootWheel?.(event.direction),
		},
		h(Box, {flexDirection: "column", onWheel: handleWheel},
			h(Text, null, `selected: ${selected}`),
			...ITEMS.slice(0, 12).map((label, i) =>
				h(Text, {key: label}, `${i === selected ? "> " : "  "}${label}`),
			),
		),
	);
};

// SGR wheel: CSI < 64|65 ; col ; row M
const wheelAtRow = (direction: "up" | "down", row: number) =>
	`\x1b[<${direction === "up" ? 64 : 65};10;${row}M`;

describe("stepIndex", () => {
	it("clamps at both ends and no-ops on an empty list", () => {
		expect(stepIndex(0, -1, 5)).toBe(0);
		expect(stepIndex(4, 1, 5)).toBe(4);
		expect(stepIndex(2, 1, 5)).toBe(3);
		expect(stepIndex(2, -1, 5)).toBe(1);
		expect(stepIndex(3, 1, 0)).toBe(0);
	});

	it("returns 0 for a single-item list (both directions are no-ops)", () => {
		expect(stepIndex(0, -1, 1)).toBe(0);
		expect(stepIndex(0, 1, 1)).toBe(0);
	});
});

describe("overlay wheel", () => {
	it("moves the selection and does not reach the app root", async () => {
		const seen: string[] = [];
		const stdout = makeStdout();
		const stdin = makeStdin();
		const instance = render(h(OverlayShape, {onRootWheel: d => seen.push(d)}), {
			stdout,
			stdin,
			patchConsole: false,
			exitOnCtrlC: false,
		});
		await settle(instance);
		expect(lastFrame(stdout.chunks)).toContain("selected: 0");

		// Row 3 is inside the list.
		stdin.emit("data", Buffer.from(wheelAtRow("down", 3)));
		await settle(instance);
		expect(lastFrame(stdout.chunks)).toContain("selected: 1");

		stdin.emit("data", Buffer.from(wheelAtRow("up", 3)));
		await settle(instance);
		expect(lastFrame(stdout.chunks)).toContain("selected: 0");

		// The overlay consumed both, so the transcript never double-scrolled.
		expect(seen).toEqual([]);
		instance.unmount();
	});
});

describe("scroll chaining", () => {
	// A box with nothing left to scroll must release the wheel to its ancestors
	// the way a browser chains an over-scroll, or it becomes a dead zone: the
	// pointer rests on it and nothing on screen responds.
	const mountPanel = async (rows: number) => {
		const seen: string[] = [];
		const stdout = makeStdout();
		const stdin = makeStdin();
		const instance = render(
			h(
				Box,
				{
					flexDirection: "column",
					height: ROWS,
					onWheel: (event: WheelEventData) => seen.push(event.direction),
				},
				h(ScrollBox, {
					height: 10,
					children: Array.from({length: rows}, (_, i) =>
						h(Text, {key: i}, `row ${i}`),
					),
				}),
			),
			{stdout, stdin, patchConsole: false, exitOnCtrlC: false},
		);
		await settle(instance);
		return {instance, stdin, seen};
	};

	it("passes the wheel through a panel that has nothing to scroll", async () => {
		const {instance, stdin, seen} = await mountPanel(4);
		stdin.emit("data", Buffer.from(wheelAtRow("up", 2)));
		await settle(instance);
		expect(seen).toEqual(["up"]);
		instance.unmount();
	});

	it("keeps the wheel when the panel can scroll", async () => {
		const {instance, stdin, seen} = await mountPanel(40);
		stdin.emit("data", Buffer.from(wheelAtRow("up", 2)));
		await settle(instance);
		expect(seen).toEqual([]);
		instance.unmount();
	});

	it("releases the wheel again once the panel hits its end", async () => {
		// A fresh box opens on the newest content, so scrolling down is already
		// at the limit.
		const {instance, stdin, seen} = await mountPanel(40);
		stdin.emit("data", Buffer.from(wheelAtRow("down", 2)));
		await settle(instance);
		expect(seen).toEqual(["down"]);
		instance.unmount();
	});
});

describe("ScrollBox controls", () => {
	// `App` drives the one scrolling document from outside it — from the scroll
	// keybindings, and from wheel events that landed on the fixed footer.
	const mount = async (rows: number, height: number) => {
		const stdout = makeStdout();
		const controls: {current: ScrollBoxControls | null} = {current: null};
		const instance = render(
			h(
				Box,
				{flexDirection: "column"},
				h(ScrollBox, {
					height,
					controls,
					children: Array.from({length: rows}, (_, i) =>
						h(Text, {key: i}, `row ${i}`),
					),
				}),
			),
			{stdout, stdin: makeStdin(), patchConsole: false, exitOnCtrlC: false},
		);
		await settle(instance);
		const visible = () =>
			lastFrame(stdout.chunks)
				.split("\n")
				.map(l => l.trimEnd())
				.filter(l => l !== "");
		return {instance, controls, visible};
	};

	it("moves the viewport from outside and clamps at both ends", async () => {
		const {instance, controls, visible} = await mount(40, 6);
		expect(visible().at(-1)).toBe("row 39");

		controls.current?.scrollToTop();
		await settle(instance);
		expect(visible()).toEqual([
			"row 0",
			"row 1",
			"row 2",
			"row 3",
			"row 4",
			"row 5",
		]);

		// Already on the oldest content, so a further jump up is a no-op rather
		// than a debt of scroll-downs to work off.
		controls.current?.scrollBy(10);
		await settle(instance);
		expect(visible()[0]).toBe("row 0");

		controls.current?.scrollBy(-2);
		await settle(instance);
		expect(visible()[0]).toBe("row 2");

		controls.current?.scrollToBottom();
		await settle(instance);
		expect(visible().at(-1)).toBe("row 39");

		instance.unmount();
	});
});
