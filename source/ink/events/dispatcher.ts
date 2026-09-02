import {type DOMElement} from "../dom.js";
import {type MouseEventData, type WheelEventData} from "../types.js";

// Event dispatch for mouse interactions. Click / wheel / mousedown / mouseup
// bubble from the target up the parentNode chain (DOM-style bubbling) and can
// be halted early via stopPropagation(). Enter / leave do not bubble.

/** A mouse event with a DOM-style stopPropagation() escape hatch. */
export type DispatchableMouseEvent = MouseEventData & {
	stopPropagation: () => void;
};

/** A wheel event with a DOM-style stopPropagation() escape hatch. */
export type DispatchableWheelEvent = WheelEventData & {
	stopPropagation: () => void;
};

type Stoppable = {stopped: boolean; stopPropagation: () => void};

/**
 * Bubble an event from `target` up the parentNode chain, invoking `handler`
 * on each ancestor that defines it. Stops early if stopPropagation() is called.
 */
const bubble = <E extends object>(
	target: DOMElement,
	event: E,
	getHandler: (node: DOMElement) => ((event: E) => void) | undefined,
): void => {
	const state: Stoppable = {
		stopped: false,
		stopPropagation() {
			state.stopped = true;
		},
	};

	const dispatched = Object.assign({}, event, {
		stopPropagation: state.stopPropagation,
	});

	let node: DOMElement | undefined = target;

	while (node && !state.stopped) {
		const handler = getHandler(node);
		if (handler) {
			handler(dispatched as E);
		}

		node = node.parentNode;
	}
};

/** Dispatch a click, bubbling through onClick handlers up the tree. */
export const dispatchClick = (
	target: DOMElement,
	event: MouseEventData,
): void => {
	bubble(target, event, node => node.onClick);
};

/** Dispatch a wheel event, bubbling through onWheel handlers up the tree. */
export const dispatchWheel = (
	target: DOMElement,
	event: WheelEventData,
): void => {
	bubble(target, event, node => node.onWheel);
};

/** Dispatch a mouse-down, bubbling through onMouseDown handlers. */
export const dispatchMouseDown = (
	target: DOMElement,
	event: MouseEventData,
): void => {
	bubble(target, event, node => node.onMouseDown);
};

/** Dispatch a mouse-up, bubbling through onMouseUp handlers. */
export const dispatchMouseUp = (
	target: DOMElement,
	event: MouseEventData,
): void => {
	bubble(target, event, node => node.onMouseUp);
};

/** Dispatch a mouse-move/drag, bubbling through onMouseMove handlers. */
export const dispatchMouseMove = (
	target: DOMElement,
	event: MouseEventData,
): void => {
	bubble(target, event, node => node.onMouseMove);
};

/** Collect the ancestor chain (including the node itself) up to the root. */
const ancestorChain = (node: DOMElement | null): DOMElement[] => {
	const chain: DOMElement[] = [];
	let current: DOMElement | undefined = node ?? undefined;

	while (current) {
		chain.push(current);
		current = current.parentNode;
	}

	return chain;
};

/**
 * Fire onMouseLeave / onMouseEnter as the hovered target changes.
 *
 * Leave fires on the previous target and every ancestor that is no longer in
 * the new target's chain; enter fires on the new target and every ancestor
 * that was not previously hovered. Enter / leave do not bubble (DOM-style):
 * each handler is invoked directly on its node.
 */
export const dispatchHover = (
	_root: DOMElement,
	prevTarget: DOMElement | null,
	newTarget: DOMElement | null,
	event: MouseEventData,
): void => {
	if (prevTarget === newTarget) {
		return;
	}

	const prevChain = ancestorChain(prevTarget);
	const newChain = ancestorChain(newTarget);
	const newSet = new Set(newChain);
	const prevSet = new Set(prevChain);

	// Leave: previous nodes no longer under the pointer, innermost first.
	for (const node of prevChain) {
		if (!newSet.has(node)) {
			node.onMouseLeave?.(event);
		}
	}

	// Enter: newly-hovered nodes, innermost first.
	for (const node of newChain) {
		if (!prevSet.has(node)) {
			node.onMouseEnter?.(event);
		}
	}
};
