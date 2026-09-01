import {useEffect, useRef} from "react";
import reconciler from "../reconciler.js";
import {useStdinContext} from "./use-stdin.js";

export type PasteHandler = (text: string) => void;

export type UsePasteOptions = {
	/**
	 * Enable or disable capturing of paste events. When `false`, the handler is
	 * not registered and bracketed paste mode is not enabled by this hook.
	 *
	 * @default true
	 */
	readonly isActive?: boolean;
};

/**
 * A React hook that calls `handler` whenever the user pastes text in the
 * terminal. Bracketed paste mode (`\x1b[?2004h`) is automatically enabled while
 * the hook is active, so pasted text arrives as a single string rather than
 * being misinterpreted as individual key presses.
 *
 * `usePaste` and `useInput` can be used together in the same component. They
 * operate on separate event channels, so paste content is never forwarded to
 * `useInput` handlers when `usePaste` is active.
 *
 * ```
 * import {useInput, usePaste} from '../ink/index.js';
 *
 * const MyInput = () => {
 * 	useInput((input, key) => {
 * 		// Only receives typed characters and key events, not pasted text.
 * 		if (key.return) {
 * 			// Submit
 * 		}
 * 	});
 *
 * 	usePaste((text) => {
 * 		// Receives the full pasted string, including newlines.
 * 		console.log('Pasted:', text);
 * 	});
 *
 * 	return …
 * };
 * ```
 */
const usePaste = (handler: PasteHandler, options: UsePasteOptions = {}): void => {
	const {
		setRawMode,
		setBracketedPasteMode,
		// eslint-disable-next-line @typescript-eslint/naming-convention
		internal_eventEmitter,
	} = useStdinContext();

	useEffect(() => {
		if (options.isActive === false) {
			return;
		}

		setRawMode(true);
		setBracketedPasteMode(true);

		return () => {
			setRawMode(false);
			setBracketedPasteMode(false);
		};
	}, [options.isActive, setRawMode, setBracketedPasteMode]);

	// A useRef-based stable callback so the effect below doesn't need to
	// re-subscribe every render when `handler` changes identity.
	const handlerRef = useRef(handler);
	handlerRef.current = handler;

	useEffect(() => {
		if (options.isActive === false) {
			return;
		}

		const handlePaste = (text: string): void => {
			// Use discreteUpdates to assign DiscreteEventPriority to state
			// updates triggered by paste, matching the priority of useInput.
			// @ts-expect-error Types require 5 arguments (fn, a, b, c, d) but only fn is needed at runtime.
			reconciler.discreteUpdates(() => {
				handlerRef.current(text);
			});
		};

		internal_eventEmitter.on("paste", handlePaste);

		return () => {
			internal_eventEmitter.removeListener("paste", handlePaste);
		};
	}, [options.isActive, internal_eventEmitter]);
};

export default usePaste;
