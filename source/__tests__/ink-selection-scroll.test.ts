import {EventEmitter} from "node:events";
import {createElement as h, useState} from "react";
import {describe, expect, it, vi} from "vitest";
import Ink from "../ink/ink.js";
import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import ScrollBox from "../ink/components/ScrollBox.js";
import {stripAnsi} from "../utils/wrap-text.js";

const {writeClipboard} = vi.hoisted(() => ({writeClipboard: vi.fn()}));
vi.mock("../ink/termio/clipboard.js", () => ({writeClipboard}));

const lines = Array.from({length: 16}, (_, i) => `row ${String(i).padStart(2, "0")}`);
const settle = async (ink: Ink, ms = 100) => {
	await new Promise(resolve => setTimeout(resolve, ms));
	await ink.waitUntilRenderFlush();
};

async function mount({controlled = false, text = lines.join("\n"), columns = 20, rows = 24, sidebar = false} = {}) {
	const stdout = new EventEmitter() as NodeJS.WriteStream;
	stdout.isTTY = true;
	stdout.columns = columns;
	stdout.rows = rows;
	stdout.write = vi.fn(() => true) as typeof stdout.write;
	const stdin = new EventEmitter() as NodeJS.ReadStream;
	stdin.isTTY = true;
	stdin.setRawMode = (() => stdin) as typeof stdin.setRawMode;
	stdin.resume = (() => stdin) as typeof stdin.resume;
	stdin.pause = (() => stdin) as typeof stdin.pause;
	stdin.read = () => null;
	const ink = new Ink({stdout, stdin, stderr: stdout, patchConsole: false,
		exitOnCtrlC: false, alternateScreen: false, maxFps: 30});
	let updateText!: (text: string) => void;
	function App() {
		const [content, setContent] = useState(text);
		updateText = setContent;
		const [offset, setOffset] = useState(0);
		return h(Box, {flexDirection: "column"},
			h(Text, null, "header"),
			h(Box, {flexDirection: "row"}, h(Box, {width: sidebar ? 8 : columns, flexDirection: "column"},
			h(ScrollBox, {height: 5, ...(controlled ? {scrollOffset: offset, onScrollChange: setOffset} : {}),
				children: h(Text, null, content)})),
				sidebar ? h(Text, null, "side 0\nside 1\nside 2\nside 3\nside 4") : null),
			h(Text, null, "footer"));
	}
	ink.render(h(App));
	await settle(ink);
	await settle(ink);
	writeClipboard.mockClear();
	const mouse = (button: number, x: number, y: number, release = false) =>
		stdin.emit("data", `\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
	const frame = () => stripAnsi((ink as any).lastOutput).split("\n");
	return {ink, stdin, stdout, mouse, frame, updateText};
}

describe("selection edge auto-scroll", () => {
	it.each([false, true])("keeps scrolling upward with a stationary drag and copies offscreen rows (controlled: %s)", async controlled => {
		const {ink, stdout, mouse, frame} = await mount({controlled});
		try {
			expect(frame()[1]).toBe("row 11");
			mouse(0, 6, 5);
			mouse(32, 0, 1);
			await vi.waitFor(() => expect(frame()[1]).toBe("row 00"), {timeout: 2500});
			mouse(0, 0, 1, true);
			expect(writeClipboard).toHaveBeenLastCalledWith(stdout, lines.join("\n"));
			expect((ink as any).displayedLines[0]).not.toContain("\x1b[7m");
			expect((ink as any).displayedLines[6]).not.toContain("\x1b[7m");
			const stopped = frame();
			await settle(ink, 200);
			expect(frame()).toEqual(stopped);
		} finally { ink.unmount(); }
	});

	it("scrolls down into the footer while retaining the original anchor", async () => {
		const {ink, stdout, mouse, frame} = await mount();
		try {
			for (let i = 0; i < 5; i++) mouse(64, 0, 2);
			await settle(ink);
			expect(frame()[1]).toBe("row 00");
			mouse(0, 0, 1);
			mouse(32, 6, 6);
			await vi.waitFor(() => expect(frame()[5]).toBe("row 15"), {timeout: 2500});
			mouse(0, 6, 6, true);
			expect(writeClipboard).toHaveBeenLastCalledWith(stdout, lines.join("\n"));
		} finally { ink.unmount(); }
	});

	it("preserves soft wraps across frames rather than inserting newlines", async () => {
		const text = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
		const {ink, stdout, mouse, frame} = await mount({text, columns: 8});
		try {
			mouse(0, 6, 5);
			mouse(32, 0, 1);
			await vi.waitFor(() => expect(frame()[1]).toBe("abcdefgh"), {timeout: 2000});
			mouse(0, 0, 1, true);
			expect(writeClipboard).toHaveBeenLastCalledWith(stdout, text);
		} finally { ink.unmount(); }
	});

	it("does not scroll an edge click, and stops when the drag returns inside", async () => {
		const {ink, mouse, frame} = await mount();
		try {
			const initial = frame();
			mouse(0, 0, 1);
			await settle(ink, 200);
			expect(frame()).toEqual(initial);
			mouse(32, 0, 1);
			await vi.waitFor(() => expect(frame()).not.toEqual(initial));
			mouse(32, 4, 3);
			await settle(ink);
			const stopped = frame();
			await settle(ink, 200);
			expect(frame()).toEqual(stopped);
		} finally { ink.unmount(); }
	});

	it("reverses direction without losing the document anchor", async () => {
		const {ink, stdout, mouse, frame} = await mount();
		try {
			mouse(0, 0, 3); // row 13
			mouse(32, 0, 1);
			await vi.waitFor(() => expect(frame()[1]).toBe("row 00"), {timeout: 2500});
			mouse(32, 6, 5);
			await vi.waitFor(() => expect(frame()[5]).toBe("row 15"), {timeout: 2500});
			mouse(0, 6, 5, true);
			expect(writeClipboard).toHaveBeenLastCalledWith(stdout, lines.slice(13).join("\n"));
		} finally { ink.unmount(); }
	});

	it("isolates scrolling selection from an adjacent column", async () => {
		const {ink, stdout, mouse, frame} = await mount({sidebar: true});
		try {
			mouse(0, 6, 5);
			mouse(32, 0, 1);
			await vi.waitFor(() => expect(frame()[1]).toContain("row 00"), {timeout: 2500});
			mouse(0, 0, 1, true);
			const copied = vi.mocked(writeClipboard).mock.calls.at(-1)!;
			expect(copied[0]).toBe(stdout);
			expect(copied[1].split("\n").map((row: string) => row.trimEnd())).toEqual(lines);
			expect(copied[1]).not.toContain("side");
			for (const row of (ink as any).displayedLines.slice(1, 6)) {
				expect(row.slice(row.indexOf("side"))).not.toContain("\x1b[7m");
			}
		} finally { ink.unmount(); }
	});

	it("keeps a selection when an unselected streaming row changes", async () => {
		const {ink, stdout, mouse, updateText} = await mount();
		try {
			mouse(0, 0, 2);
			mouse(32, 6, 3);
			updateText(lines.join("\n") + "!");
			await settle(ink);
			mouse(0, 6, 3, true);
			expect(writeClipboard).toHaveBeenLastCalledWith(stdout, lines.slice(12, 14).join("\n"));
		} finally { ink.unmount(); }
	});

	it("accounts for a frame scrolled up by the terminal's trailing newline", async () => {
		const {ink, stdout, mouse, frame} = await mount({rows: 7});
		try {
			mouse(0, 6, 4); // frame row 5, offset by one terminal row
			mouse(32, 0, 0);
			await vi.waitFor(() => expect(frame()[1]).toBe("row 00"), {timeout: 2500});
			mouse(0, 0, 0, true);
			expect(writeClipboard).toHaveBeenLastCalledWith(stdout, lines.join("\n"));
		} finally { ink.unmount(); }
	});

	it("cancels safely when the terminal is resized", async () => {
		const {ink, stdout, mouse, updateText} = await mount();
		try {
			mouse(0, 6, 5);
			mouse(32, 0, 1);
			stdout.columns = 18;
			updateText(lines.join("\n") + "!");
			await settle(ink);
			expect((ink as any).selectionScrollTimer).toBeUndefined();
			expect((ink as any).selectionRange).toBeNull();
		} finally { ink.unmount(); }
	});

	it.each(["release", "keyboard", "suspend", "unmount"])("stops the timer on %s", async action => {
		const {ink, stdin, stdout, mouse} = await mount();
		let resume: (() => void) | undefined;
		try {
			mouse(0, 6, 5);
			mouse(32, 0, 1);
			if (action === "release") mouse(0, 0, 1, true);
			if (action === "keyboard") stdin.emit("data", "x");
			if (action === "suspend") resume = ink.suspend();
			if (action === "unmount") ink.unmount();
			await settle(ink);
			const writes = vi.mocked(stdout.write).mock.calls.length;
			await settle(ink, 200);
			expect(vi.mocked(stdout.write).mock.calls.length).toBe(writes);
			expect((ink as any).selectionScrollTimer).toBeUndefined();
		} finally { resume?.(); ink.unmount(); }
	});
});
