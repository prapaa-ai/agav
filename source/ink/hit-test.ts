import {type DOMElement, type DOMNode} from "./dom.js";

// After render, each DOMElement carries its absolute layout rectangle via
// internal_x / internal_y / internal_width / internal_height (see
// render-node-to-output.ts). Hit-testing walks the tree to find the deepest
// element whose rectangle contains a point.

const isElement = (node: DOMNode): node is DOMElement =>
	node.nodeName !== "#text";

/** Returns true if (x, y) falls inside the node's absolute rectangle. */
const containsPoint = (
	node: DOMElement,
	x: number,
	y: number,
): boolean => {
	const nx = node.internal_x;
	const ny = node.internal_y;
	const width = node.internal_width;
	const height = node.internal_height;

	if (
		nx === undefined ||
		ny === undefined ||
		width === undefined ||
		height === undefined
	) {
		return false;
	}

	return x >= nx && x < nx + width && y >= ny && y < ny + height;
};

/**
 * Return the deepest DOMElement whose rectangle contains (x, y).
 *
 * Sibling precedence follows painter's order: later children in `childNodes`
 * are drawn on top, so they win over earlier siblings (topmost-sibling-wins).
 * Returns null if no element contains the point.
 */
export const hitTest = (
	root: DOMElement,
	x: number,
	y: number,
): DOMElement | null => {
	if (!containsPoint(root, x, y)) {
		return null;
	}

	// Search children from last to first so the topmost sibling wins. The first
	// child that contains the point (and its deepest descendant) takes priority.
	for (let index = root.childNodes.length - 1; index >= 0; index--) {
		const child = root.childNodes[index]!;

		if (!isElement(child)) {
			continue;
		}

		const hit = hitTest(child, x, y);
		if (hit) {
			return hit;
		}
	}

	// No child contained the point; the root itself is the deepest match.
	return root;
};
