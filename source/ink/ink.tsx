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
	/**
	 * Enable mouse tracking (wheel-scroll and click). Off by default: arming it
	 * hands every click and drag to the app instead of the terminal, which
	 * disables the terminal's own click-drag text selection outright — modifier
	 * overrides (Shift/Option/Fn, terminal-dependent) are the only way back in
	 * while it's on. Off leaves the terminal's native selection working
	 * unmodified; wheel-scroll and click-to-place-caret fall back to their
	 * keyboard equivalents (arrow keys / `scrollUp`/`scrollDown` bindings).
	 * @default false
	 */
	mouse?: boolean;
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
	private readonly mouseEnabled: boolean;

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
	// Buffer holding the prefix of a mouse report that was split across reads.
	// Prepended to the next stdin chunk so the sequence can be matched whole.
	private mouseBuffer: string | undefined;
	private escapeTimer: NodeJS.Timeout | undefined;
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
		this.mouseEnabled = Boolean(options.mouse);
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

		if (this.mouseEnabled) {
			stdout.write(ENABLE_MOUSE_TRACKING);
		}

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

		// Restore terminal state even if the process dies without ever calling
		// unmount() — an uncaught exception, a signal, or main.tsx's own
		// process.exit() paths. Without this, mouse tracking (and, on the
		// alternate screen, the buffer switch) leaks into the user's shell:
		// clicks and drags keep being reported as escape sequences instead of
		// selecting text, until they run `reset` or the equivalent by hand.
		// unmount() is idempotent (guarded by isUnmounted) and fully
		// synchronous, so it is safe to run from the "exit" event, which is the
		// last point at which synchronous work can still reach the streams.
		process.on("exit", this.handleProcessExit);
	}

	private readonly handleProcessExit = (): void => {
		// The "exit" event only allows synchronous work, and Node treats a
		// throw here as fatal — don't let a destroyed/closed stream (a common
		// state this late in shutdown) turn a best-effort cleanup into a crash.
		try {
			this.unmount();
		} catch {
			// Best-effort: the terminal may already be gone.
		}
	};

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

			if (this.mouseEnabled) {
				this.options.stdout.write(DISABLE_MOUSE_TRACKING);
			}

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

			if (this.mouseEnabled) {
				stdout.write(ENABLE_MOUSE_TRACKING);
			}

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

		// If we buffered a partial mouse sequence from the previous read,
		// prepend it so the full sequence can be matched.
		if (this.mouseBuffer !== undefined) {
			chunk = this.mouseBuffer + chunk;
			this.mouseBuffer = undefined;
			clearTimeout(this.escapeTimer);
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

			// Check if the remaining chunk is a partial mouse sequence prefix
			// that was split across reads.  Buffer it for the next read.
			const partialLen = mouseSequencePrefixLength(chunk);
			if (partialLen > 0) {
				flushInput();
				this.mouseBuffer = chunk.slice(0, partialLen);
				chunk = chunk.slice(partialLen);
				continue;
			}

			// A trailing ESC is almost always the start of an escape sequence
			// (arrow key, mouse report, function key) that got split across
			// reads. Buffer it so the next read can complete the sequence.
			// Without this, the ESC goes through as input while the rest of
			// the sequence arrives next and leaks as literal text (e.g. the
			// SGR mouse body `[<65;44;18M` appears in the prompt).
			if (chunk.length === 1 && chunk[0] === "\x1b") {
				flushInput();
				this.mouseBuffer = "\x1b";
				// If no follow-up bytes arrive within 50ms, this is a real Escape
				// keypress — flush it as input rather than holding it indefinitely.
				clearTimeout(this.escapeTimer);
				this.escapeTimer = setTimeout(() => {
					if (this.mouseBuffer === "\x1b") {
						this.mouseBuffer = undefined;
						this.internalEventEmitter.emit("input", "\x1b");
					}
				}, 50);
				chunk = "";
				break;
			}

			// Orphaned CSI body: a `[` followed by parameter bytes and a
			// final byte, matching the shape of an escape sequence whose
			// leading ESC was already consumed (split across reads, or
			// stripped upstream). Drop it silently — it is never real input.
			const orphanedLen = matchOrphanedCSI(chunk);
			if (orphanedLen > 0) {
				flushInput();
				chunk = chunk.slice(orphanedLen);
				continue;
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

	/**
	 * How far the frame has scrolled off the top of the terminal.
	 *
	 * A mouse report names a terminal row; layout names a frame row. The two
	 * agree only while the whole frame is on screen. A frame is written as
	 * `output + "\n"`, so once it is within one row of filling the terminal that
	 * trailing newline pushes the top of it into scrollback, and every laid-out
	 * row from then on sits that many rows higher than its number says.
	 * Hit-testing a raw mouse row against those rectangles then picks the wrong
	 * element, or none at all down where the last rows are.
	 */
	private get frameScrollOffset(): number {
		const height = this.rootNode.internal_height ?? 0;
		const rows = this.options.stdout.rows ?? 0;

		if (height === 0 || rows === 0) {
			return 0;
		}

		return Math.max(0, height + 1 - rows);
	}

	private readonly handleMouseEvent = (ev: ParsedMouse): void => {
		// Everything downstream — hit-testing, and the coordinates handlers
		// compare against `internal_x` / `internal_y` — works in frame rows.
		const y = ev.y + this.frameScrollOffset;
		const target = hitTest(this.rootNode, ev.x, y);

		const base: MouseEventData = {
			x: ev.x,
			y,
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
			const wheelTarget = target ?? this.hitTestClamped(ev.x, y);

			if (!wheelTarget) {
				return;
			}

			dispatchWheel(wheelTarget, {
				x: ev.x,
				y,
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
		clearTimeout(this.escapeTimer);
		this.throttledOnRender.cancel();
		process.off("exit", this.handleProcessExit);

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

		// Pause stdin so it no longer keeps the Node.js event loop alive.
		// mount() called stdin.resume() via setRawMode(true); without a
		// matching pause() the process hangs after waitUntilExit() resolves.
		stdin.pause();

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

		if (this.mouseEnabled) {
			stdout.write(DISABLE_MOUSE_TRACKING);
		}

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

/**
 * If `chunk` starts with an incomplete mouse report prefix, return its length.
 * Returns 0 when the chunk is not a recognizable mouse prefix.
 *
 * This lets us buffer the partial sequence instead of leaking its bytes into
 * the input emitter as typed text.
 *
 * We only buffer when the prefix is **unambiguously** a mouse sequence:
 *   SGR: \x1b[< followed by digits/semicolons (waiting for M or m)
 *   X10: \x1b[M followed by 0–2 of the 3 required raw bytes
 *
 * A bare \x1b or \x1b[ is NOT buffered — those are shared CSI prefixes used
 * by arrow keys, function keys, and many other sequences.
 */
const SGR_MOUSE_PARTIAL_RE = /^\x1b\[<[\d;]*$/;
const X10_MOUSE_PARTIAL_RE = /^\x1b\[M[\s\S]{0,2}$/;

/**
 * Matches an orphaned SGR mouse report at the start of `chunk` — one whose
 * leading ESC was consumed by a previous read. Shape: `[<` + digits/semicolons
 * + `M` or `m`. Returns the length of the matched sequence, or 0.
 *
 * Only SGR mouse reports are matched (they start with `[<`, which is not a
 * sequence any real keystroke produces without an ESC in front). Generic CSI
 * sequences are NOT matched here because a bare `[` is a normal typeable
 * character and stripping `[t`, `[A`, etc. would eat real input.
 */
const ORPHANED_SGR_MOUSE_RE = /^\[<\d+;\d+;\d+[Mm]/;

const matchOrphanedCSI = (chunk: string): number => {
	if (chunk.length < 6 || chunk[0] !== "[" || chunk[1] !== "<") {
		return 0;
	}

	const m = ORPHANED_SGR_MOUSE_RE.exec(chunk);
	return m ? m[0].length : 0;
};

const mouseSequencePrefixLength = (chunk: string): number => {
	// Must start with the unambiguous mouse discriminator: \x1b[< or \x1b[M
	if (chunk.length < 3 || chunk[0] !== "\x1b" || chunk[1] !== "[") {
		return 0;
	}

	// Check SGR partial: \x1b[< followed by digits/semicolons, no final M/m yet.
	// A complete SGR match would have been consumed by matchMouseAt() already.
	const end = Math.min(chunk.length, 20);
	for (let len = end; len >= 3; len--) {
		const prefix = chunk.slice(0, len);
		if (SGR_MOUSE_PARTIAL_RE.test(prefix)) {
			return len;
		}
	}

	// Check X10 partial: \x1b[M with 0–2 trailing bytes (3 needed for a full match).
	if (chunk[2] === "M" && chunk.length < 6) {
		const len = Math.min(chunk.length, 5);
		const prefix = chunk.slice(0, len);
		if (X10_MOUSE_PARTIAL_RE.test(prefix)) {
			return len;
		}
	}

	return 0;
};
