import {type DOMElement} from "./dom.js";

export type ElementSize = {
	width: number;
	height: number;
};

/**
 * Read the laid-out size of a `<Box>` in terminal cells.
 *
 * Layout is computed before every paint, so reading this from an effect gives
 * the size the element had in the frame that just went to the screen. Returns
 * zeroes before the first layout.
 *
 * Use it to size one part of the UI against another — e.g. giving a scrolling
 * viewport whatever rows the surrounding chrome did not take — instead of
 * hard-coding a row count that goes wrong the moment the chrome grows.
 */
export const measureElement = (node: DOMElement | null): ElementSize => ({
	width: node?.yogaNode?.getComputedWidth() ?? 0,
	height: node?.yogaNode?.getComputedHeight() ?? 0,
});

export default measureElement;
