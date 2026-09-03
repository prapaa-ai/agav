import widestLine from "widest-line";
import indentString from "indent-string";
import Yoga from "yoga-layout";
import {type DOMElement} from "./dom.js";
import wrapText from "./wrap-text.js";
import getMaxWidth from "./get-max-width.js";
import squashTextNodes from "./squash-text-nodes.js";
import renderBorder from "./render-border.js";
import renderBackground from "./render-background.js";
import type Output from "./output.js";

export type OutputTransformer = (s: string, index: number) => string;

// If parent container is `<Box>`, text nodes will be treated as separate nodes
// in the tree and will have their own coordinates in the layout.
// To ensure text nodes are aligned correctly, take X and Y of the first text
// node and use it as offset for the rest of the nodes.
// Only first node is taken into account, because other text nodes can't have
// margin or padding, so their coordinates will be relative to the first node
// anyway.
const applyPaddingToText = (node: DOMElement, text: string): string => {
	const yogaNode = node.childNodes[0]?.yogaNode;

	if (yogaNode) {
		const offsetX = yogaNode.getComputedLeft();
		const offsetY = yogaNode.getComputedTop();
		text = "\n".repeat(offsetY) + indentString(text, offsetX);
	}

	return text;
};

export const renderNodeToScreenReaderOutput = (
	node: DOMElement,
	options: {
		parentRole?: string;
		skipStaticElements?: boolean;
	} = {},
): string => {
	if (options.skipStaticElements && node.internal_static) {
		return "";
	}

	if (node.yogaNode?.getDisplay() === Yoga.DISPLAY_NONE) {
		return "";
	}

	let output = "";

	if (node.nodeName === "ink-text") {
		output = squashTextNodes(node);
	} else if (node.nodeName === "ink-box" || node.nodeName === "ink-root") {
		const separator =
			node.style.flexDirection === "row" ||
			node.style.flexDirection === "row-reverse"
				? " "
				: "\n";

		const childNodes =
			node.style.flexDirection === "row-reverse" ||
			node.style.flexDirection === "column-reverse"
				? [...node.childNodes].reverse()
				: [...node.childNodes];

		output = childNodes
			.map(childNode => {
				const screenReaderOutput = renderNodeToScreenReaderOutput(
					childNode as DOMElement,
					{
						parentRole: node.internal_accessibility?.role,
						skipStaticElements: options.skipStaticElements,
					},
				);

				return screenReaderOutput;
			})
			.filter(Boolean)
			.join(separator);
	}

	if (node.internal_accessibility) {
		const {role, state} = node.internal_accessibility;

		if (state) {
			const stateKeys = Object.keys(state) as Array<keyof typeof state>;
			const stateDescription = stateKeys
				.filter(key => state[key])
				.join(", ");

			if (stateDescription) {
				output = `(${stateDescription}) ${output}`;
			}
		}

		if (role && role !== options.parentRole) {
			output = `${role}: ${output}`;
		}
	}

	return output;
};

// Vertical clip bounds threaded through the render tree so subtrees that fall
// entirely outside the visible viewport can be skipped early — avoiding
// expensive squashTextNodes / widestLine / wrapText work for off-screen nodes.
type ClipY = {y1: number; y2: number} | undefined;

// After nodes are laid out, render each to output object, which later gets
// rendered to terminal
const renderNodeToOutput = (
	node: DOMElement,
	output: Output,
	options: {
		offsetX?: number;
		offsetY?: number;
		transformers?: OutputTransformer[];
		skipStaticElements: boolean;
		clipY?: ClipY;
	},
): void => {
	const {
		offsetX = 0,
		offsetY = 0,
		transformers = [],
		skipStaticElements,
		clipY,
	} = options;

	if (skipStaticElements && node.internal_static) {
		return;
	}

	const {yogaNode} = node;

	if (yogaNode) {
		if (yogaNode.getDisplay() === Yoga.DISPLAY_NONE) {
			return;
		}

		// Left and top positions in Yoga are relative to their parent node
		const x = offsetX + yogaNode.getComputedLeft();
		const y = offsetY + yogaNode.getComputedTop();
		const nodeHeight = yogaNode.getComputedHeight();

		// Store absolute coordinates and dimensions on the node so mouse
		// events can be hit-tested against the rendered tree later.
		node.internal_x = x;
		node.internal_y = y;
		node.internal_width = yogaNode.getComputedWidth();
		node.internal_height = nodeHeight;

		// Early-exit: if this node is entirely outside the active vertical
		// clip bounds it will never produce visible output. Skip the expensive
		// text processing (squashTextNodes, widestLine, wrapText) and the
		// entire subtree walk. The internal_* coordinates are already stored
		// above so hit-testing for mouse events still works for nodes that sit
		// just outside the viewport.
		if (clipY && nodeHeight > 0) {
			const nodeBottom = y + nodeHeight;
			if (nodeBottom <= clipY.y1 || y >= clipY.y2) {
				return;
			}
		}

		// Transformers are functions that transform final text output of each
		// component. See Output class for logic that applies transformers.
		let newTransformers = transformers;

		if (typeof node.internal_transform === "function") {
			newTransformers = [node.internal_transform, ...transformers];
		}

		if (node.nodeName === "ink-text") {
			let text = squashTextNodes(node);

			if (text.length > 0) {
				const currentWidth = widestLine(text);
				const maxWidth = getMaxWidth(yogaNode);

				if (currentWidth > maxWidth) {
					const textWrap = node.style.textWrap ?? "wrap";
					text = wrapText(text, maxWidth, textWrap);
				}

				text = applyPaddingToText(node, text);
				output.write(x, y, text, {transformers: newTransformers});
			}

			return;
		}

		let clipped = false;
		let childClipY = clipY;

		if (node.nodeName === "ink-box") {
			renderBackground(x, y, node, output);
			renderBorder(x, y, node, output);

			const clipHorizontally =
				node.style.overflowX === "hidden" || node.style.overflow === "hidden";

			const clipVertically =
				node.style.overflowY === "hidden" || node.style.overflow === "hidden";

			if (clipHorizontally || clipVertically) {
				const x1 = clipHorizontally
					? x + yogaNode.getComputedBorder(Yoga.EDGE_LEFT)
					: undefined;

				const x2 = clipHorizontally
					? x +
						yogaNode.getComputedWidth() -
						yogaNode.getComputedBorder(Yoga.EDGE_RIGHT)
					: undefined;

				const y1 = clipVertically
					? y + yogaNode.getComputedBorder(Yoga.EDGE_TOP)
					: undefined;

				const y2 = clipVertically
					? y +
						yogaNode.getComputedHeight() -
						yogaNode.getComputedBorder(Yoga.EDGE_BOTTOM)
					: undefined;

				output.clip({x1, x2, y1, y2});
				clipped = true;

				// Tighten the vertical clip for children. If the parent
				// already established a clip, intersect with it.
				if (y1 !== undefined && y2 !== undefined) {
					if (childClipY) {
						childClipY = {
							y1: Math.max(childClipY.y1, y1),
							y2: Math.min(childClipY.y2, y2),
						};
					} else {
						childClipY = {y1, y2};
					}
				}
			}
		}

		if (node.nodeName === "ink-root" || node.nodeName === "ink-box") {
			const children = node.childNodes;
			if (childClipY && children.length > 8) {
				// Fast path: when a vertical clip is active and there are many
				// children (typical for the message list inside ScrollBox),
				// pre-check each child's position against the clip bounds and
				// skip off-screen ones without the overhead of a recursive call.
				// This turns the per-frame child iteration from O(n) recursive
				// calls into O(n) cheap comparisons + O(visible) recursive calls.
				for (let ci = 0; ci < children.length; ci++) {
					const child = children[ci] as DOMElement;
					const childYoga = child.yogaNode;
					if (childYoga) {
						const childTop = y + childYoga.getComputedTop();
						const childHeight = childYoga.getComputedHeight();
						// Store layout coordinates so mouse hit-testing still
						// works for off-screen nodes.
						child.internal_x = x + childYoga.getComputedLeft();
						child.internal_y = childTop;
						child.internal_width = childYoga.getComputedWidth();
						child.internal_height = childHeight;

						if (childHeight > 0) {
							const childBottom = childTop + childHeight;
							if (childBottom <= childClipY.y1 || childTop >= childClipY.y2) {
								continue;
							}
						}
					}

					renderNodeToOutput(child, output, {
						offsetX: x,
						offsetY: y,
						transformers: newTransformers,
						skipStaticElements,
						clipY: childClipY,
					});
				}
			} else {
				for (const childNode of node.childNodes) {
					renderNodeToOutput(childNode as DOMElement, output, {
						offsetX: x,
						offsetY: y,
						transformers: newTransformers,
						skipStaticElements,
						clipY: childClipY,
					});
				}
			}

			if (clipped) {
				output.unclip();
			}
		}
	}
};

export default renderNodeToOutput;
