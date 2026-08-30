import {EventEmitter} from "node:events";
import process from "node:process";
import {createContext} from "react";

// ---------------------------------------------------------------------------
// AppContext
// ---------------------------------------------------------------------------

/**
 * A handle returned by `suspendTerminal()` when called without a callback.
 *
 * Call `resume()` to give terminal ownership back to Ink, or use `await using`
 * so the suspension is resumed automatically when it leaves scope.
 */
export type TerminalSuspension = {
	readonly resume: () => Promise<void>;
	readonly [Symbol.asyncDispose]: () => Promise<void>;
};

/**
 * Temporarily hand the terminal over to a child process (e.g. `$EDITOR`,
 * `less`, `fzf`), then restore Ink's terminal state and force a full redraw.
 */
export type SuspendTerminal = {
	(callback: () => void | Promise<void>): Promise<void>;
	(): Promise<TerminalSuspension>;
};

export type AppContextProps = {
	/**
	 * Exit (unmount) the whole Ink app.
	 */
	readonly exit: (errorOrResult?: Error | unknown) => void;
	/**
	 * Returns a promise that settles after pending render output is flushed to
	 * stdout.
	 */
	readonly waitUntilRenderFlush: () => Promise<void>;
	/**
	 * Temporarily release the terminal so a child process can take it over,
	 * then restore Ink's terminal state and force a full redraw.
	 */
	readonly suspendTerminal: SuspendTerminal;
	/**
	 * Synchronous form of {@link suspendTerminal}, for callers that must own the
	 * terminal before yielding to the event loop.
	 *
	 * A caller that writes to stdout itself — a raw-stdout picker, say — cannot
	 * await: React has already scheduled a commit, and awaiting lets that commit
	 * repaint over whatever the caller drew. This takes the terminal
	 * synchronously so the very next write is safe. Call the returned function
	 * to hand it back.
	 */
	readonly suspendTerminalSync: () => () => void;
	/**
	 * Erase the screen and repaint the app from scratch.
	 *
	 * Use this instead of writing RIS (`ESC c`) to stdout: a hard reset also
	 * drops the alternate screen buffer, mouse tracking and bracketed paste,
	 * none of which Ink re-arms outside of mount.
	 */
	readonly resetDisplay: () => void;
};

const noopSuspension: TerminalSuspension = {
	async resume() {},
	async [Symbol.asyncDispose]() {},
};

const appContextDefaultValue: AppContextProps = {
	exit(_errorOrResult?: Error | unknown) {},
	async waitUntilRenderFlush() {},
	suspendTerminal: (async (callback?: () => void | Promise<void>) => {
		if (callback) {
			await callback();
			return undefined;
		}

		return noopSuspension;
	}) as SuspendTerminal,
	suspendTerminalSync: () => () => {},
	resetDisplay() {},
};

/**
 * `AppContext` is a React context that exposes lifecycle methods for the app.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export const AppContext = createContext<AppContextProps>(
	appContextDefaultValue,
);

AppContext.displayName = "InternalAppContext";

// ---------------------------------------------------------------------------
// StdinContext
// ---------------------------------------------------------------------------

export type StdinContextProps = {
	/**
	 * The stdin stream passed to `render()` in `options.stdin`, or
	 * `process.stdin` by default. Useful if your app needs to handle user
	 * input.
	 */
	readonly stdin: NodeJS.ReadStream;
	/**
	 * Ink exposes this function via its own `<StdinContext>` to be able to
	 * handle Ctrl+C. If the `stdin` stream passed to Ink does not support
	 * setRawMode, this function does nothing.
	 */
	readonly setRawMode: (value: boolean) => void;
	/**
	 * A boolean flag determining if the current `stdin` supports `setRawMode`.
	 */
	readonly isRawModeSupported: boolean;
	/**
	 * Enable or disable bracketed paste mode on the terminal.
	 */
	readonly setBracketedPasteMode: (value: boolean) => void;
	// eslint-disable-next-line @typescript-eslint/naming-convention
	readonly internal_exitOnCtrlC: boolean;
	// eslint-disable-next-line @typescript-eslint/naming-convention
	readonly internal_eventEmitter: EventEmitter;
};

/**
 * `StdinContext` is a React context that exposes the input stream.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export const StdinContext = createContext<StdinContextProps>({
	stdin: process.stdin,
	// eslint-disable-next-line @typescript-eslint/naming-convention
	internal_eventEmitter: new EventEmitter(),
	setRawMode() {},
	setBracketedPasteMode() {},
	isRawModeSupported: false,
	// eslint-disable-next-line @typescript-eslint/naming-convention
	internal_exitOnCtrlC: true,
});

StdinContext.displayName = "InternalStdinContext";

// ---------------------------------------------------------------------------
// StdoutContext
// ---------------------------------------------------------------------------

export type StdoutContextProps = {
	/**
	 * Stdout stream passed to `render()` in `options.stdout` or
	 * `process.stdout` by default.
	 */
	readonly stdout: NodeJS.WriteStream;
	/**
	 * Write any string to stdout while preserving Ink's output.
	 */
	readonly write: (data: string) => void;
};

/**
 * `StdoutContext` is a React context that exposes the stdout stream where Ink
 * renders your app.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export const StdoutContext = createContext<StdoutContextProps>({
	stdout: process.stdout,
	write() {},
});

StdoutContext.displayName = "InternalStdoutContext";

// ---------------------------------------------------------------------------
// StderrContext
// ---------------------------------------------------------------------------

export type StderrContextProps = {
	/**
	 * Stderr stream passed to `render()` in `options.stderr` or
	 * `process.stderr` by default.
	 */
	readonly stderr: NodeJS.WriteStream;
	/**
	 * Write any string to stderr while preserving Ink's output.
	 */
	readonly write: (data: string) => void;
};

/**
 * `StderrContext` is a React context that exposes the stderr stream.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export const StderrContext = createContext<StderrContextProps>({
	stderr: process.stderr,
	write() {},
});

StderrContext.displayName = "InternalStderrContext";
