import {EventEmitter} from "node:events";
import process from "node:process";
import React, {type ReactNode} from "react";
import {LegacyRoot} from "react-reconciler/constants.js";
import Yoga from "yoga-layout";
import reconciler from "./reconciler.js";
import renderer from "./renderer.js";
import * as dom from "./dom.js";
import {type DOMElement} from "./dom.js";
import logUpdate, {type LogUpdate} from "./log-update.js";
import {hitTest} from "./hit-test.js";
import {
	isMouseSequence,
	parseMouseEvent,
	SGR_MOUSE_RE,
	X10_MOUSE_RE,
	type ParsedMouse,
} from "./parse-mouse.js";
import {
	dispatchClick,
	dispatchWheel,
	dispatchMouseDown,
	dispatchMouseUp,
	dispatchHover,
} from "./events/dispatcher.js";
import {
	ENABLE_MOUSE_TRACKING,
	DISABLE_MOUSE_TRACKING,
	ERASE_DISPLAY,
	ERASE_SCROLLBACK,
	CURSOR_HOME,
	ENTER_ALT_SCREEN,
	EXIT_ALT_SCREEN,
	HIDE_CURSOR,
	SHOW_CURSOR,
	ENABLE_BRACKETED_PASTE,
	DISABLE_BRACKETED_PASTE,
} from "./termio/dec.js";
import {
	AppContext,
	StdinContext,
	StdoutContext,
	StderrContext,
} from "./components/contexts.js";
import {type MouseEventData} from "./types.js";
import {resolveFlags, type KittyFlagName} from "./kitty-keyboard.js";

// Begin/end synchronized-update markers (DEC private mode 2026). Wrapping a
// frame in these tells the terminal to hold rendering until the whole frame is
// written, preventing tearing.
const BEGIN_SYNC = "\x1b[?2026h";
const END_SYNC = "\x1b[?2026l";

// Bracketed paste markers. When bracketed paste mode is enabled the terminal
// wraps pasted content between these two sequences.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const noop = (): void => {};

export type InkOptions = {
	stdout: NodeJS.WriteStream;
	stdin: NodeJS.ReadStream;
	stderr: NodeJS.WriteStream;
	exitOnCtrlC?: boolean;
	patchConsole?: boolean;
	alternateScreen?: boolean;
	maxFps?: number;
	kittyKeyboard?: {
		mode: "enabled" | "disabled";
		flags?: string[];
	};
};

/**
 * Create a throttled version of `fn` that runs at most once per `waitMs`, with
 * leading and trailing invocations. A trailing call is scheduled if `fn` was
 * called during the cooldown window.
 */
const throttle = (
	fn: () => void,
	waitMs: number,
): {(): void; flush: () => void; cancel: () => void} => {
	let timer: NodeJS.Timeout | undefined;
	let pending = false;

	const invoke = (): void => {
		pending = false;
		fn();
	};

	const throttled = (): void => {
		if (timer) {
			pending = true;
			return;
		}

		invoke();
		timer = setTimeout(() => {
			timer = undefined;
			if (pending) {
				throttled();
			}
		}, waitMs);
	};

	throttled.flush = (): void => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}

		if (pending) {
			invoke();
		}
	};

	throttled.cancel = (): void => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}

		pending = false;
	};

	return throttled;
};

export default class Ink {
	private readonly options: InkOptions;
	private readonly rootNode: DOMElement;
	private readonly container: ReturnType<
		typeof reconciler.createContainer
	>;

	private readonly log: LogUpdate;
	private readonly interactive: boolean;
	private readonly exitOnCtrlC: boolean;
	private readonly alternateScreen: boolean;

	// Kitty keyboard protocol state. `kittyKeyboardEnabled` tracks whether we
	// pushed a flags stack entry on mount so we know to pop it on unmount.
	private readonly kittyKeyboard: InkOptions["kittyKeyboard"];
	private kittyKeyboardEnabled = false;

	// Non-mouse input bytes are forwarded here so use-input's StdinContext
	// consumer can react.
	private readonly internalEventEmitter = new EventEmitter();

	private readonly throttledOnRender: ReturnType<typeof throttle>;

	private isUnmounted = false;
	// Nesting depth of terminal suspensions. While non-zero Ink owns neither the
	// screen nor stdin, and `onRender` is a no-op.
	private suspendCount = 0;
	private isRawModeEnabled = false;
	private rawModeEnabledCount = 0;
	private isBracketedPasteEnabled = false;
	private bracketedPasteEnabledCount = 0;
	// Buffer holding an in-progress paste whose start marker arrived without its
	// matching end marker (paste spanning multiple chunks).
	private pasteBuffer: string | undefined;
	private lastOutput = "";
	private fullStaticOutput = "";

	// Mouse interaction state.
	private mouseDownTarget: DOMElement | null = null;
	private prevHoverTarget: DOMElement | null = null;

	private readonly exitPromise: Promise<void>;
	private resolveExitPromise: () => void = noop;
	private rejectExitPromise: (error: Error) => void = noop;

	constructor(options: InkOptions) {
		this.options = options;
		this.exitOnCtrlC = options.exitOnCtrlC ?? true;
		this.interactive = Boolean(options.stdout.isTTY);
		this.alternateScreen = Boolean(options.alternateScreen);
		this.kittyKeyboard = options.kittyKeyboard;

		this.rootNode = dom.createNode("ink-root");
		this.rootNode.onComputeLayout = this.calculateLayout;
		this.rootNode.onImmediateRender = this.onRender;

		const maxFps = options.maxFps ?? 30;
		const throttleMs = maxFps > 0 ? Math.max(1, Math.ceil(1000 / maxFps)) : 1;
		this.throttledOnRender = throttle(this.onRender, throttleMs);
		this.rootNode.onRender = this.throttledOnRender;

		this.log = logUpdate.create(options.stdout);

		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		this.container = reconciler.createContainer(
			this.rootNode,
			LegacyRoot,
			null,
			false,
			null,
			"id",
			noop,
			noop,
			noop,
			noop,
		);

		this.exitPromise = new Promise<void>((resolve, reject) => {
			this.resolveExitPromise = resolve;
			this.rejectExitPromise = reject;
		});

		// Avoid unhandled-rejection crashes if the consumer never awaits exit.
		this.exitPromise.catch(noop);

		this.mount();
	}

	private mount(): void {
		const {stdout, stdin} = this.options;

		if (this.alternateScreen) {
			stdout.write(ENTER_ALT_SCREEN);
		}

		stdout.write(ENABLE_MOUSE_TRACKING);
		stdout.write(HIDE_CURSOR);

		// Pin the kitty keyboard protocol mode if requested. Only force-enable
		// when both streams are TTYs so we don't emit escapes into pipes/files.
		if (
			this.kittyKeyboard?.mode === "enabled" &&
			stdin.isTTY &&
			stdout.isTTY
		) {
			const flags = (this.kittyKeyboard.flags ?? [
				"disambiguateEscapeCodes",
			]) as KittyFlagName[];
			stdout.write(`\x1b[>${resolveFlags(flags)}u`);
			this.kittyKeyboardEnabled = true;
		}

		this.setRawMode(true);
		stdin.on("data", this.handleInput);
	}

	private readonly setRawMode = (value: boolean): void => {
		const {stdin} = this.options;

		if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
			return;
		}

		// Reference-count raw mode requests so multiple useInput() hooks don't
		// stomp each other. Keep raw mode on as long as the engine itself wants
		// it (it always does while mounted).
		if (value) {
			this.rawModeEnabledCount++;
		} else if (this.rawModeEnabledCount > 0) {
			this.rawModeEnabledCount--;
		}

		const shouldEnable = this.rawModeEnabledCount > 0;

		if (shouldEnable === this.isRawModeEnabled) {
			return;
		}

		this.isRawModeEnabled = shouldEnable;
		stdin.setRawMode(shouldEnable);

		if (shouldEnable) {
			stdin.resume();
		}
	};

	private readonly setBracketedPasteMode = (value: boolean): void => {
		// Reference-count enable requests so multiple usePaste() hooks don't
		// stomp each other.
		if (value) {
			this.bracketedPasteEnabledCount++;
		} else if (this.bracketedPasteEnabledCount > 0) {
			this.bracketedPasteEnabledCount--;
		}

		const shouldEnable = this.bracketedPasteEnabledCount > 0;

		if (shouldEnable === this.isBracketedPasteEnabled) {
			return;
		}

		this.isBracketedPasteEnabled = shouldEnable;
		this.options.stdout.write(
			shouldEnable ? ENABLE_BRACKETED_PASTE : DISABLE_BRACKETED_PASTE,
		);
	};

	private readonly calculateLayout = (): void => {
		const width = this.options.stdout.columns || 80;
		this.rootNode.yogaNode?.setWidth(width);
		this.rootNode.yogaNode?.calculateLayout(
			undefined,
			undefined,
			Yoga.DIRECTION_LTR,
		);
	};

	/**
	 * Hand the terminal to a caller that draws to stdout itself, and return the
	 * function that hands it back.
	 *
	 * Everything here is synchronous on purpose. A caller that awaits first
	 * gives React's already-scheduled commit a chance to run, and that commit
	 * repaints over whatever the caller drew — the frame is erased by line
	 * count, so it also eats however many lines the caller had written.
	 */
	readonly suspend = (): (() => void) => {
		this.suspendCount++;

		if (this.suspendCount === 1) {
			// Drop any frame still queued behind the FPS throttle, then erase the
			// one on screen so the caller starts from a clean cursor position and
			// `log` no longer believes it owns any lines.
			this.throttledOnRender.cancel();

			if (this.interactive) {
				this.log.clear();
			}

			this.options.stdout.write(DISABLE_MOUSE_TRACKING);
			this.options.stdin.off("data", this.handleInput);
		}

		let resumed = false;

		return (): void => {
			if (resumed) {
				return;
			}

			resumed = true;
			this.suspendCount--;

			if (this.suspendCount > 0 || this.isUnmounted) {
				return;
			}

			const {stdout, stdin} = this.options;

			stdin.on("data", this.handleInput);

			// A raw-stdout caller commonly pauses stdin on its way out, which
			// would leave Ink deaf now that its listener is back.
			if (this.isRawModeEnabled && stdin.isTTY) {
				stdin.resume();
			}

			stdout.write(ENABLE_MOUSE_TRACKING);
			stdout.write(HIDE_CURSOR);

			// Repaint immediately rather than waiting on the throttle, so the UI
			// is back before the next keystroke. On the alternate screen there is
			// no way to know what the other writer left behind, so clear it —
			// there is no scrollback to lose there.
			if (this.alternateScreen) {
				this.resetDisplay();
			} else {
				this.onRender();
			}
		};
	};

	private readonly onRender = (): void => {
		if (this.isUnmounted || this.suspendCount > 0) {
			return;
		}

		this.calculateLayout();

		const {output, staticOutput} = renderer(this.rootNode, false);

		// New <Static> children have been added when static output is non-empty.
		const hasStaticOutput = staticOutput && staticOutput !== "\n";

		if (!this.interactive) {
			if (hasStaticOutput) {
				this.options.stdout.write(staticOutput);
			}

			this.lastOutput = output;
			return;
		}

		const stdout = this.options.stdout;

		stdout.write(BEGIN_SYNC);

		if (hasStaticOutput) {
			// Erase the dynamic frame, write the static block above it, then
			// repaint the dynamic frame beneath.
			this.log.clear();
			stdout.write(staticOutput);
			this.fullStaticOutput += staticOutput;
		}

		this.log(output + "\n");
		this.lastOutput = output;

		stdout.write(END_SYNC);
	};

	private readonly handleInput = (data: Uint8Array | string): void => {
		if (this.isUnmounted) {
			return;
		}

		let chunk =
			typeof data === "string"
				? data
				: Buffer.from(data).toString("utf8");

		// If we're mid-paste (start marker seen in a previous chunk), keep
		// buffering until the end marker arrives.
		if (this.pasteBuffer !== undefined) {
			const endIndex = chunk.indexOf(PASTE_END);
			if (endIndex === -1) {
				this.pasteBuffer += chunk;
				return;
			}

			const text = this.pasteBuffer + chunk.slice(0, endIndex);
			this.pasteBuffer = undefined;
			this.internalEventEmitter.emit("paste", text);
			chunk = chunk.slice(endIndex + PASTE_END.length);
		}

		// Ctrl+C handling.
		if (this.exitOnCtrlC && chunk.includes("\x03")) {
			this.unmount();
			return;
		}

		// Drain the chunk left-to-right. Mouse reports and bracketed paste
		// sequences are handled inline; any run of remaining bytes is forwarded
		// to the input emitter as a group.
		let pendingInput = "";

		const flushInput = (): void => {
			if (pendingInput.length > 0) {
				this.internalEventEmitter.emit("input", pendingInput);
				pendingInput = "";
			}
		};

		while (chunk.length > 0) {
			if (chunk.startsWith(PASTE_START)) {
				flushInput();

				const rest = chunk.slice(PASTE_START.length);
				const endIndex = rest.indexOf(PASTE_END);

				if (endIndex === -1) {
					// End marker not in this chunk — buffer until it arrives.
					this.pasteBuffer = rest;
					chunk = "";
					break;
				}

				const text = rest.slice(0, endIndex);
				this.internalEventEmitter.emit("paste", text);
				chunk = rest.slice(endIndex + PASTE_END.length);
				continue;
			}

			if (isMouseSequence(chunk)) {
				const match = matchMouseAt(chunk);

				if (match) {
					flushInput();
					const parsed = parseMouseEvent(match.sequence);
					if (parsed) {
						this.handleMouseEvent(parsed);
					}

					chunk = chunk.slice(match.length);
					continue;
				}
			}

			pendingInput += chunk[0];
			chunk = chunk.slice(1);
		}

		flushInput();
	};

	/** Hit-test the point pulled back to the nearest cell inside the frame. */
	private readonly hitTestClamped = (
		x: number,
		y: number,
	): DOMElement | null => {
		const root = this.rootNode;
		const width = root.internal_width ?? 0;
		const height = root.internal_height ?? 0;

		if (width <= 0 || height <= 0) {
			return null;
		}

		const clampedX = Math.min(Math.max(x, root.internal_x ?? 0), width - 1);
		const clampedY = Math.min(Math.max(y, root.internal_y ?? 0), height - 1);

		return hitTest(root, clampedX, clampedY);
	};

	private readonly handleMouseEvent = (ev: ParsedMouse): void => {
		const target = hitTest(this.rootNode, ev.x, ev.y);

		const base: MouseEventData = {
			x: ev.x,
			y: ev.y,
			button: ev.button,
			ctrl: ev.ctrl,
			alt: ev.alt,
			shift: ev.shift,
		};

		// Wheel events. When the pointer is outside every laid-out element —
		// below a frame shorter than the terminal, say — retry against the
		// nearest point that is inside. Mouse tracking means the terminal will
		// not scroll on our behalf, so dropping the event outright leaves the
		// user with no way to scroll at all. Dispatching to `rootNode` would not
		// help: bubbling walks *up* from the target, and every handler in the
		// app is below the root.
		if (ev.wheel) {
			const wheelTarget = target ?? this.hitTestClamped(ev.x, ev.y);

			if (!wheelTarget) {
				return;
			}

			dispatchWheel(wheelTarget, {
				x: ev.x,
				y: ev.y,
				direction: ev.wheel,
				ctrl: ev.ctrl,
				alt: ev.alt,
				shift: ev.shift,
			});

			return;
		}

		if (ev.action === "press" && ev.button === 0) {
			this.mouseDownTarget = target;
			if (target) {
				dispatchMouseDown(target, base);
			}

			return;
		}

		if (ev.action === "release") {
			if (target) {
				dispatchMouseUp(target, base);

				// A click fires only when press and release land on the same node.
				if (target === this.mouseDownTarget) {
					dispatchClick(target, base);
				}
			}

			this.mouseDownTarget = null;
			return;
		}

		if (ev.action === "move" || ev.action === "drag") {
			dispatchHover(this.rootNode, this.prevHoverTarget, target, base);
			this.prevHoverTarget = target;
		}
	};

	/** Flush any frame held by the FPS throttle and let the write drain. */
	readonly waitUntilRenderFlush = async (): Promise<void> => {
		this.throttledOnRender.flush();
		await new Promise<void>(resolve => {
			setImmediate(resolve);
		});
	};

	readonly suspendTerminal = (async (
		callback?: () => void | Promise<void>,
	): Promise<unknown> => {
		const resume = this.suspend();

		if (callback) {
			try {
				await callback();
			} finally {
				resume();
			}

			return undefined;
		}

		return {
			async resume() {
				resume();
			},
			async [Symbol.asyncDispose]() {
				resume();
			},
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	}) as any;

	render(node: ReactNode): void {
		const tree = (
			<AppContext.Provider
				value={{
					exit: this.handleExit,
					waitUntilRenderFlush: this.waitUntilRenderFlush,
					suspendTerminal: this.suspendTerminal,
					suspendTerminalSync: this.suspend,
					resetDisplay: this.resetDisplay,
				}}
			>
				<StdinContext.Provider
					value={{
						stdin: this.options.stdin,
						setRawMode: this.setRawMode,
						isRawModeSupported: Boolean(this.options.stdin.isTTY),
						setBracketedPasteMode: this.setBracketedPasteMode,
						// eslint-disable-next-line @typescript-eslint/naming-convention
						internal_exitOnCtrlC: this.exitOnCtrlC,
						// eslint-disable-next-line @typescript-eslint/naming-convention
						internal_eventEmitter: this.internalEventEmitter,
					}}
				>
					<StdoutContext.Provider
						value={{
							stdout: this.options.stdout,
							write: (data: string) => {
								this.options.stdout.write(data);
							},
						}}
					>
						<StderrContext.Provider
							value={{
								stderr: this.options.stderr,
								write: (data: string) => {
									this.options.stderr.write(data);
								},
							}}
						>
							{node}
						</StderrContext.Provider>
					</StdoutContext.Provider>
				</StdinContext.Provider>
			</AppContext.Provider>
		);

		reconciler.updateContainerSync(tree, this.container, null, noop);
		reconciler.flushSyncWork();
	}

	private readonly handleExit = (errorOrResult?: Error | unknown): void => {
		if (errorOrResult instanceof Error) {
			this.unmount(errorOrResult);
			return;
		}

		this.unmount();
	};

	unmount(error?: Error): void {
		if (this.isUnmounted) {
			return;
		}

		this.isUnmounted = true;
		this.throttledOnRender.cancel();

		const {stdout, stdin} = this.options;

		stdin.off("data", this.handleInput);

		// Restore raw mode.
		this.rawModeEnabledCount = 0;
		if (
			this.isRawModeEnabled &&
			stdin.isTTY &&
			typeof stdin.setRawMode === "function"
		) {
			this.isRawModeEnabled = false;
			stdin.setRawMode(false);
		}

		// Disable bracketed paste mode if it was left enabled.
		this.bracketedPasteEnabledCount = 0;
		if (this.isBracketedPasteEnabled) {
			this.isBracketedPasteEnabled = false;
			stdout.write(DISABLE_BRACKETED_PASTE);
		}

		// Tear down the React tree.
		reconciler.updateContainerSync(null, this.container, null, noop);
		reconciler.flushSyncWork();

		if (this.interactive) {
			this.log.done();
		}

		// Pop the kitty keyboard flags we pushed on mount, restoring the
		// terminal's previous mode, before restoring other terminal state.
		if (this.kittyKeyboardEnabled) {
			this.kittyKeyboardEnabled = false;
			stdout.write("\x1b[<u");
		}

		stdout.write(DISABLE_MOUSE_TRACKING);
		stdout.write(SHOW_CURSOR);

		if (this.alternateScreen) {
			stdout.write(EXIT_ALT_SCREEN);
		}

		if (error) {
			this.rejectExitPromise(error);
		} else {
			this.resolveExitPromise();
		}
	}

	async waitUntilExit(): Promise<void> {
		return this.exitPromise;
	}

	clear(): void {
		if (this.interactive) {
			this.log.clear();
		}
	}

	/**
	 * Erase the screen and repaint the app from a known-clean slate.
	 *
	 * Deliberately does *not* use RIS (`ESC c`). A full terminal reset also
	 * drops the alternate screen buffer, mouse tracking, bracketed paste and the
	 * kitty keyboard flags — which lands the app back in the terminal's native
	 * scrollback with its own wheel scrolling dead, and Ink never re-arms any of
	 * it because that only happens on mount.
	 */
	readonly resetDisplay = (): void => {
		if (this.isUnmounted || !this.interactive) {
			return;
		}

		const {stdout} = this.options;

		// Drop any frame queued behind the throttle; it describes a screen that
		// is about to stop existing.
		this.throttledOnRender.cancel();

		stdout.write(ERASE_SCROLLBACK + ERASE_DISPLAY + CURSOR_HOME);
		// The frame is gone, so `log` must not try to erase its lines again.
		this.log.reset();
		stdout.write(HIDE_CURSOR);

		if (this.suspendCount > 0) {
			return;
		}

		this.onRender();
	};
}

// SGR / X10 mouse report matchers anchored at the start of the string.
const SGR_MOUSE_START_RE = new RegExp("^" + SGR_MOUSE_RE.source);
const X10_MOUSE_START_RE = new RegExp("^" + X10_MOUSE_RE.source);

/**
 * If `chunk` begins with a mouse report, return the matched sequence and its
 * length; otherwise null. Used to peel one report off the front of a chunk that
 * may contain several batched reports.
 */
const matchMouseAt = (
	chunk: string,
): {sequence: string; length: number} | null => {
	const sgr = SGR_MOUSE_START_RE.exec(chunk);
	if (sgr) {
		return {sequence: sgr[0], length: sgr[0].length};
	}

	const x10 = X10_MOUSE_START_RE.exec(chunk);
	if (x10) {
		return {sequence: x10[0], length: x10[0].length};
	}

	return null;
};
