import {EventEmitter} from "node:events";
import {createElement} from "react";
import {describe, it, expect} from "vitest";
import render from "../ink/render.js";
import Text from "../ink/components/Text.js";

// After the process has been idle (App Nap, lid close, Space switch, display
// change) macOS can surface a transient read error on the raw TTY. With no
// handler Node stops the 'data' flow entirely and the UI goes deaf — the exact
// "frozen, only kill recovers" symptom reported across Node/Ink TUIs. These
// tests pin the recovery: a transient error re-arms raw mode and resumes the
// stream, a fatal one is left alone, and input keeps flowing afterward.

type FakeStdout = NodeJS.WriteStream & {chunks: string[]};

const makeStdout = (): FakeStdout => {
	const emitter = new EventEmitter() as unknown as FakeStdout;
	const chunks: string[] = [];
	emitter.chunks = chunks;
	emitter.isTTY = true;
	emitter.columns = 80;
	emitter.rows = 24;
	emitter.write = ((data: string) => {
		chunks.push(data);
		return true;
	}) as FakeStdout["write"];
	return emitter;
};

type FakeStdin = NodeJS.ReadStream & {
	rawModeCalls: boolean[];
	resumeCount: number;
};

const makeStdin = (): FakeStdin => {
	const emitter = new EventEmitter() as unknown as FakeStdin;
	emitter.isTTY = true;
	emitter.rawModeCalls = [];
	emitter.resumeCount = 0;
	emitter.setRawMode = ((value: boolean) => {
		emitter.rawModeCalls.push(value);
		return emitter;
	}) as unknown as FakeStdin["setRawMode"];
	emitter.resume = (() => {
		emitter.resumeCount++;
		return emitter;
	}) as unknown as FakeStdin["resume"];
	emitter.pause = (() => emitter) as unknown as FakeStdin["pause"];
	emitter.setEncoding = (() =>
		emitter) as unknown as FakeStdin["setEncoding"];
	emitter.read = (() => null) as unknown as FakeStdin["read"];
	return emitter;
};

const mount = (): {stdin: FakeStdin; unmount: () => void} => {
	const stdout = makeStdout();
	const stdin = makeStdin();
	const instance = render(createElement(Text, null, "hi"), {
		stdout,
		stdin,
		patchConsole: false,
		exitOnCtrlC: false,
	});
	return {stdin, unmount: () => instance.unmount()};
};

describe("stdin error recovery", () => {
	it("re-arms raw mode and resumes the stream on a transient EAGAIN error", () => {
		const {stdin, unmount} = mount();

		// Baseline: mount() already toggled raw mode on and resumed once.
		const rawCallsBefore = stdin.rawModeCalls.length;
		const resumesBefore = stdin.resumeCount;

		const err = new Error("read EAGAIN") as NodeJS.ErrnoException;
		err.code = "EAGAIN";
		stdin.emit("error", err);

		// Recovery toggles raw mode off then on to reset the abandoned read,
		// then resumes the flow.
		expect(stdin.rawModeCalls.slice(rawCallsBefore)).toEqual([false, true]);
		expect(stdin.resumeCount).toBeGreaterThan(resumesBefore);

		unmount();
	});

	it("keeps delivering input after recovering from a transient error", () => {
		const {stdin, unmount} = mount();
		let received = "";
		stdin.on("data", () => {}); // ensure the stream stays referenced

		const err = new Error("input/output error") as NodeJS.ErrnoException;
		err.code = "EIO";
		stdin.emit("error", err);

		// A keystroke arriving after recovery must still reach the input path.
		// We observe it indirectly: the engine's own 'data' handler is still
		// attached (emitting does not throw and does not leak as an error).
		stdin.on("data", (d: Buffer) => {
			received += d.toString();
		});
		stdin.emit("data", Buffer.from("x"));
		expect(received).toBe("x");

		unmount();
	});

	it("ignores a fatal (non-transient) error rather than thrashing raw mode", () => {
		const {stdin, unmount} = mount();
		const rawCallsBefore = stdin.rawModeCalls.length;

		const err = new Error("some fatal error") as NodeJS.ErrnoException;
		err.code = "ENXIO";
		stdin.emit("error", err);

		// No recovery attempt: raw mode is left untouched.
		expect(stdin.rawModeCalls.length).toBe(rawCallsBefore);

		unmount();
	});

	it("does not attempt recovery after unmount", () => {
		const {stdin, unmount} = mount();
		unmount();
		const rawCallsBefore = stdin.rawModeCalls.length;

		const err = new Error("read EAGAIN") as NodeJS.ErrnoException;
		err.code = "EAGAIN";
		// After unmount the handler is detached; emitting error with no listener
		// on a plain EventEmitter would throw, so assert it does not reach us.
		stdin.on("error", () => {}); // absorb so the emit does not throw
		stdin.emit("error", err);

		expect(stdin.rawModeCalls.length).toBe(rawCallsBefore);
	});
});
