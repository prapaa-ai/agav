import React, {useCallback, useEffect, useRef, useState} from "react";
import {type WheelEventData} from "../types.js";
import {type DOMElement} from "../dom.js";
import {measureElement} from "../measure-element.js";
import Box from "./Box.js";

export type ScrollBoxProps = {
	/** Number of visible rows in the viewport. */
	readonly height: number;
	/** Row groups to render. Each child is treated as a self-contained block. */
	readonly children: React.ReactNode;
	/**
	 * Controlled scroll offset in lines-from-bottom. `0` means pinned to the
	 * newest content. When provided together with `onScrollChange`, the
	 * component runs in controlled mode.
	 */
	readonly scrollOffset?: number;
	/** Called with the next offset when the user scrolls (controlled mode). */
	readonly onScrollChange?: (offset: number) => void;
	/** When true and the viewport is at the bottom, stay pinned as new children arrive. */
	readonly stickToBottom?: boolean;
};

/** Number of lines to move per wheel tick. */
const WHEEL_STEP = 3;

/**
 * `<ScrollBox>` renders a vertically scrollable viewport over its children.
 *
 * The content is laid out at its natural height inside a clipped viewport and
 * moved with a negative top margin, so the scroll range comes from the real
 * yoga layout rather than a guess. An earlier version walked the element tree
 * to estimate row counts, which silently returned 0 for anything wrapped in a
 * function component (a component element carries no `children` prop): the
 * scroll range collapsed to zero and the wheel did nothing.
 */
export default function ScrollBox({
	height,
	children,
	scrollOffset,
	onScrollChange,
	stickToBottom = true,
}: ScrollBoxProps): React.ReactNode {
	const isControlled =
		scrollOffset !== undefined && onScrollChange !== undefined;

	const [internalOffset, setInternalOffset] = useState(0);
	const offset = isControlled ? scrollOffset : internalOffset;

	const contentRef = useRef<DOMElement | null>(null);
	const [contentHeight, setContentHeight] = useState(0);

	// Measure after every commit. Ink lays the yoga tree out during
	// `resetAfterCommit`, which runs before passive effects, so the computed
	// height is already available here. The measurement cannot feed back into
	// itself: the content column is `flexShrink={0}` and its height does not
	// depend on the viewport or on the scroll offset.
	useEffect(() => {
		const measured = measureElement(contentRef.current).height;
		if (measured !== contentHeight) {
			setContentHeight(measured);
		}
	});

	// The viewport is every row it was given — nothing is reserved for chrome.
	const viewport = Math.max(1, height);
	const maxScroll = Math.max(0, contentHeight - viewport);
	const clampedOffset = Math.min(Math.max(0, offset), maxScroll);

	// Rows of content hidden above the top edge of the viewport.
	const topSkip = Math.max(0, contentHeight - viewport - clampedOffset);

	// When `stickToBottom` is false and the user has scrolled up, growing
	// content at the bottom would visually push their view. Because offset is
	// measured from the bottom, we bump the offset by the number of new lines
	// so the on-screen position stays anchored to the same content.
	const prevContentHeight = useRef(contentHeight);
	if (!isControlled) {
		const grew = contentHeight - prevContentHeight.current;
		if (grew > 0 && !stickToBottom && internalOffset > 0) {
			setInternalOffset(internalOffset + grew);
		}
	}

	prevContentHeight.current = contentHeight;

	// Wheel ticks arrive faster than Ink repaints, so several land between two
	// renders. Deriving each one from `clampedOffset` would make them all start
	// from the same stale value and collapse a fast scroll into a single step;
	// this tracks the latest intent instead. Assigning during render keeps it
	// pinned to whatever was last painted.
	const offsetRef = useRef(clampedOffset);
	offsetRef.current = clampedOffset;

	const setOffset = useCallback(
		(next: number) => {
			const clamped = Math.min(Math.max(0, next), maxScroll);
			offsetRef.current = clamped;
			if (isControlled) {
				onScrollChange(clamped);
			} else {
				setInternalOffset(clamped);
			}
		},
		[isControlled, maxScroll, onScrollChange],
	);

	// A controlled parent that also handles the wheel (so the pointer can be
	// anywhere on screen, not just over the viewport) would otherwise scroll a
	// second time when the event bubbles up out of here.
	const handleWheel = useCallback(
		(event: WheelEventData) => {
			event.stopPropagation?.();
			const step = event.ctrl
				? Math.max(1, Math.floor(viewport / 2))
				: WHEEL_STEP;
			setOffset(offsetRef.current + (event.direction === "up" ? step : -step));
		},
		[viewport, setOffset],
	);

	// In controlled mode the parent can hand us an offset past the end of the
	// content — it has no way to know `maxScroll`. Report the clamped value back
	// so repeated scroll-ups don't build a debt of downs to undo.
	useEffect(() => {
		if (isControlled && offset > maxScroll) {
			onScrollChange(maxScroll);
		}
	}, [isControlled, offset, maxScroll, onScrollChange]);

	return (
		<Box
			flexDirection="column"
			height={viewport}
			overflow="hidden"
			onWheel={handleWheel}
		>
			<Box
				ref={contentRef}
				flexDirection="column"
				flexShrink={0}
				marginTop={-topSkip}
			>
				{children}
			</Box>
		</Box>
	);
}
