import React, {forwardRef} from "react";
import {type DOMElement} from "../dom.js";
import {
	type MouseEventData,
	type WheelEventData,
	type Styles,
} from "../types.js";

/** Mouse handler props that flow through to the host element. */
export type MouseHandlers = {
	/** Fired when the element is clicked. */
	readonly onClick?: (event: MouseEventData) => void;
	/** Fired when a mouse button is pressed over the element. */
	readonly onMouseDown?: (event: MouseEventData) => void;
	/** Fired when a mouse button is released over the element. */
	readonly onMouseUp?: (event: MouseEventData) => void;
	/** Fired when the mouse moves/drags over the element. */
	readonly onMouseMove?: (event: MouseEventData) => void;
	/** Fired when the pointer enters the element. */
	readonly onMouseEnter?: (event: MouseEventData) => void;
	/** Fired when the pointer leaves the element. */
	readonly onMouseLeave?: (event: MouseEventData) => void;
	/** Fired when the mouse wheel is scrolled over the element. */
	readonly onWheel?: (event: WheelEventData) => void;
};

export type Props = Omit<Styles, "textWrap"> &
	MouseHandlers & {
		readonly children?: React.ReactNode;
	};

/**
 * `<Box>` is an essential Ink component to build your layout. It's like
 * `<div style="display: flex">` in the browser.
 */
const Box = forwardRef<DOMElement, Props>(function Box(
	{
		children,
		onClick,
		onMouseDown,
		onMouseUp,
		onMouseEnter,
		onMouseLeave,
		onWheel,
		...style
	},
	ref,
) {
	return React.createElement(
		"ink-box",
		{
			ref,
			style: {
				flexWrap: "nowrap",
				flexDirection: "row",
				flexGrow: 0,
				flexShrink: 1,
				...style,
				overflowX: style.overflowX ?? style.overflow ?? "visible",
				overflowY: style.overflowY ?? style.overflow ?? "visible",
			},
			// Mouse handler props flow through to the host element so the
			// reconciler assigns them directly to the DOM node.
			onClick,
			onMouseDown,
			onMouseUp,
			onMouseEnter,
			onMouseLeave,
			onWheel,
		},
		children,
	);
});

Box.displayName = "Box";

export default Box;
