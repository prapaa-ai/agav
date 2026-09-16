import {EventEmitter} from "node:events";
import {createElement as h} from "react";
import {describe, it, expect} from "vitest";
import render from "../ink/render.js";
import Text from "../ink/components/Text.js";
import useInput from "../ink/hooks/use-input.js";

// Reproduces the macOS "11MMMMMM" gibberish: a scroll-wheel flood of SGR mouse
// reports gets split across read boundaries while the event loop is busy (the
// "agav hangs then emits crazy characters" symptom). The tails of split SGR
// reports collapse to bare `digitM` / `M` fragments and leak into the prompt.

type FakeStdout = NodeJS.WriteStream & {chunks: string[]};

const makeStdout = (): FakeStdout => {
	const emitter = new EventEmitter() as unknown as FakeStdout;
	emitter.chunks = [];
	emitter.isTTY = true;
	emitter.columns = 120;
	emitter.rows = 30;
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

// A wheel-up SGR report: button 64, at col 11, row 5.
const sgr = (col: number, row: number) => `\x1b[<64;${col};${row}M`;

describe("ink layer drops split SGR wheel reports (11MMMMMM gibberish)", () => {
	it("does not leak tails when a flood is split mid-sequence", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		// Build a flood of concatenated reports, then split it at arbitrary
		// byte offsets — exactly what a busy event loop does under a scroll.
		let flood = "";
		for (let i = 0; i < 8; i++) flood += sgr(11, 5 + i);

		// Split every 7 bytes so boundaries fall inside the `;col;rowM` tails.
		for (let i = 0; i < flood.length; i += 7) {
			stdin.emit("data", flood.slice(i, i + 7));
		}
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toBe("");
		instance.unmount();
	});

	it("does not leak when the escape timer flushes between reads (hang)", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		// One report split so the leading \x1b lands alone at a read end, then
		// wait past the 50ms escape timer AND the 150ms mouse-burst window so
		// the tail arrives "cold" — the hang scenario.
		const report = sgr(11, 5);
		const splitAt = report.indexOf("<") + 4; // mid-body
		stdin.emit("data", report.slice(0, 1)); // lone ESC
		await new Promise(r => setTimeout(r, 220));
		stdin.emit("data", report.slice(1)); // "[<64;11;5M" headless
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toBe("");
		void splitAt;
		instance.unmount();
	});

	it("stays quiet as a hung flood drains rapidly (11MMMMMM)", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		// The hang symptom: the event loop was blocked while the terminal
		// flooded scroll reports, so the OS buffered them and delivered the pile
		// as ONE read when the loop unblocked — a full report followed by a run
		// of collapsed tails and lone terminators, all adjacent in one chunk.
		// That is the exact `11MMMMMM` the user sees.
		stdin.emit("data", sgr(11, 5) + "11M" + "MMMM");
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toBe("");
		instance.unmount();
	});

	it("drops lone M/m terminators adjacent to a report in one read", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		// A lone `M`/`m` is the SGR terminator of a report whose whole body was
		// consumed just before it in the same buffered read. It is never user
		// input in that position and must be dropped.
		stdin.emit("data", sgr(11, 5) + "Mm");
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toBe("");
		instance.unmount();
	});

	it("keeps M-initial typing right after a scroll (man/mkdir/M)", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		// The false-positive the lone-terminator match must NOT cause: a user
		// scrolls, then immediately types a command starting with M/m. The
		// keystroke arrives inside the 150ms burst window, but it is REAL input
		// — the residue run ends at the first typed byte, so nothing is eaten.
		stdin.emit("data", sgr(11, 5)); // scroll consumed
		stdin.emit("data", "mkdir foo"); // typed immediately after
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toBe("mkdir foo");
		instance.unmount();
	});

	it("keeps a lone typed M right after a scroll", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		// A single `M` typed one keystroke at a time after a scroll: the first
		// real byte ends the residue run, so even a bare `M` survives.
		stdin.emit("data", sgr(11, 5));
		stdin.emit("data", "M");
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toBe("M");
		instance.unmount();
	});

	it("keeps M-initial typing in a read separate from the flood", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		// The flood (with its lone terminators) drains as one buffered read and
		// is dropped. The user then types an M-initial word — a later, separate
		// read where no mouse fragment precedes it in the chunk, so its leading
		// letter is preserved.
		stdin.emit("data", sgr(11, 5) + "MM"); // flood + tails, one read
		stdin.emit("data", "man"); // real typing, separate read
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toBe("man");
		instance.unmount();
	});

	it("keeps M-initial typing in the SAME read as a mouse report", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		// The same-chunk false positive: a mouse report and a typed command
		// batched into one read. The lone-terminator lookahead requires the
		// next byte to be more mouse residue, so `m` followed by `a` is NOT
		// dropped — `man` keeps its leading letter.
		stdin.emit("data", sgr(11, 5) + "man");
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toBe("man");
		instance.unmount();
	});

	it("keeps mkdir/More in the same read as a mouse report", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		stdin.emit("data", sgr(11, 5) + "mkdir foo");
		await instance.waitUntilRenderFlush();
		expect(captured.join("")).toBe("mkdir foo");

		captured.length = 0;
		stdin.emit("data", sgr(11, 5) + "More");
		await instance.waitUntilRenderFlush();
		expect(captured.join("")).toBe("More");

		instance.unmount();
	});

	it("still drops flood residue that is followed by more residue in one read", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		// Lone terminators followed by more mouse residue (another M, a `<`
		// report, a digit tail) — all dropped; nothing leaks.
		stdin.emit("data", sgr(11, 5) + "MM" + "<64;11;6M" + "11M" + "M");
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toBe("");
		instance.unmount();
	});

	it("keeps a lone M typed at the very end of a report's read", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		// Ambiguity note: a lone `M` at end-of-chunk right after a report IS
		// treated as residue (the last terminator of a flood). A user typing a
		// bare `M` in the exact same read as a mouse report is indistinguishable
		// and vanishingly rare — the documented trade-off. Typing a bare `M`
		// arrives as its own separate read (covered above) and is preserved.
		stdin.emit("data", sgr(11, 5) + "M");
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toBe("");
		instance.unmount();
	});

	// --- Documented, intentional trade-offs (raised in review) ---------------

	it("DOC: a cross-read lone M is NOT dropped (protects M-command typing)", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		// A lone `M` that arrives in its OWN read after a mouse report in a
		// prior read is byte- and timing-identical to a user pressing `M`. We
		// deliberately let it through: dropping it (window-based) would eat the
		// leading letter of every `man`/`mkdir`/`More` typed after a scroll,
		// which is real data loss. A stray single `M` from the rare read-split
		// case is cosmetic by comparison. Real floods arrive same-read (dropped
		// above), so this cross-read leak is a low-frequency edge, not the bug.
		stdin.emit("data", sgr(11, 5)); // report, one read
		stdin.emit("data", "M"); // lone M, separate read -> kept
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toBe("M");
		instance.unmount();
	});

	it("keeps a typed M before an escape sequence (arrow/Alt) in one read", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		// Regression for the review finding: `\x1b` is NOT a mouse-continuation
		// byte, so a typed `M` immediately followed by an escape sequence (an
		// arrow key here) in the same read keeps its `M`. The arrow itself is a
		// mouse-buffer/keypress concern handled elsewhere; what matters is the
		// leading `M` is not eaten as residue.
		stdin.emit("data", sgr(11, 5) + "M\x1b[D");
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toContain("M");
		instance.unmount();
	});

	it("DOC: same-read `M<digit>` after a report drops the M (accepted ambiguity)", async () => {
		captured.length = 0;
		const {stdin, instance} = mount();
		await instance.waitUntilRenderFlush();

		// `M1` batched into the SAME read as a mouse report is indistinguishable
		// from a collapsed `M`+`11M` flood tail — the same ambiguity already
		// documented for the numeric `1;2m` case. Keeping the M's residue
		// lookahead broad here is what guarantees ZERO flood leakage (the
		// primary goal); narrowing it would re-leak a stray `M` per report on
		// every scroll. This only bites the rare same-read `M<digit>` typing.
		stdin.emit("data", sgr(11, 5) + "M1");
		await instance.waitUntilRenderFlush();

		expect(captured.join("")).toBe("1");
		instance.unmount();
	});
});
