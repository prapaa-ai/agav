import process from "node:process";
import {type ReactNode} from "react";
import Ink, {type InkOptions} from "./ink.js";

export type RenderOptions = {
	/** Output stream where the app is rendered. @default process.stdout */
	stdout?: NodeJS.WriteStream;
	/** Input stream where the app listens for input. @default process.stdin */
	stdin?: NodeJS.ReadStream;
	/** Error stream. @default process.stderr */
	stderr?: NodeJS.WriteStream;
	/** Exit the app on Ctrl+C. @default true */
	exitOnCtrlC?: boolean;
	/** Patch console methods to write above the app. @default true */
	patchConsole?: boolean;
	/** Use the alternate screen buffer. @default false */
	alternateScreen?: boolean;
	/** Maximum render frames per second. @default 30 */
	maxFps?: number;
	/**
	 * Pin the terminal's kitty keyboard protocol mode on mount and restore it
	 * on unmount. When enabled, requested flags are pushed with `CSI > flags u`
	 * and popped with `CSI < u`. @default undefined (do nothing)
	 */
	kittyKeyboard?: {
		mode: "enabled" | "disabled";
		flags?: string[];
	};
};

export type Instance = {
	/** Replace the app's root React node and re-render. */
	rerender: (node: ReactNode) => void;
	/** Unmount the app and restore the terminal. */
	unmount: () => void;
	/** Resolves when the app unmounts. */
	waitUntilExit: () => Promise<void>;
	/** Clear the app's output from the terminal. */
	clear: () => void;
	/**
	 * Synchronously hand the terminal to a caller that draws to stdout itself.
	 * Call the returned function to give it back and force a repaint.
	 */
	suspendTerminal: () => () => void;
	/** Resolves once any frame held by the FPS throttle has been written. */
	waitUntilRenderFlush: () => Promise<void>;
	/** Erase the screen and repaint the app from scratch. */
	resetDisplay: () => void;
};

// Ink keeps one live renderer per stdout stream so concurrent render() calls to
// the same output reuse the same engine rather than competing for it.
const instances = new WeakMap<NodeJS.WriteStream, Ink>();

/**
 * Mount a React component and render it to the terminal.
 */
const render = (node: ReactNode, options?: RenderOptions): Instance => {
	const inkOptions: InkOptions = {
		stdout: process.stdout,
		stdin: process.stdin,
		stderr: process.stderr,
		exitOnCtrlC: true,
		patchConsole: true,
		alternateScreen: false,
		maxFps: 30,
		...options,
	};

	const instance = getInstance(
		inkOptions.stdout,
		() => new Ink(inkOptions),
	);

	instance.render(node);

	return {
		rerender: node => {
			instance.render(node);
		},
		unmount: () => {
			instance.unmount();
		},
		waitUntilExit: () => instance.waitUntilExit(),
		clear: () => {
			instance.clear();
		},
		suspendTerminal: () => instance.suspend(),
		waitUntilRenderFlush: () => instance.waitUntilRenderFlush(),
		resetDisplay: () => {
			instance.resetDisplay();
		},
	};
};

const getInstance = (
	stdout: NodeJS.WriteStream,
	createInstance: () => Ink,
): Ink => {
	const existing = instances.get(stdout);

	if (existing === undefined) {
		const instance = createInstance();
		instances.set(stdout, instance);
		return instance;
	}

	process.stderr.write(
		"Warning: render() was called again for the same stdout before the previous Ink instance was unmounted. Call unmount() first.\n",
	);

	return existing;
};

export default render;
