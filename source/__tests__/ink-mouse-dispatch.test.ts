import {describe, it, expect, vi} from "vitest";
import {
	createNode,
	appendChildNode,
	setStyle,
	type DOMElement,
} from "../ink/dom.js";
import {hitTest} from "../ink/hit-test.js";
import {
	dispatchClick,
	dispatchWheel,
} from "../ink/events/dispatcher.js";
import {parseMouseEvent} from "../ink/parse-mouse.js";
import {
	type MouseEventData,
	type WheelEventData,
} from "../ink/types.js";

// Manually place a node's absolute layout rectangle. In a live render this is
// set by render-node-to-output.ts; here we set it directly so hit-testing has
// concrete rectangles to work with.
const setRect = (
	node: DOMElement,
	x: number,
	y: number,
	width: number,
	height: number,
): void => {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	node.internal_x = x;
	// eslint-disable-next-line @typescript-eslint/naming-convention
	node.internal_y = y;
	// eslint-disable-next-line @typescript-eslint/naming-convention
	node.internal_width = width;
	// eslint-disable-next-line @typescript-eslint/naming-convention
	node.internal_height = height;
};

/**
 * Build a small tree:
 *   root  (0,0 40x20)
 *     parent (2,2 30x10)
 *       child (5,5 10x3)
 */
const buildTree = (): {
	root: DOMElement;
	parent: DOMElement;
	child: DOMElement;
} => {
	const root = createNode("ink-root");
	const parent = createNode("ink-box");
	const child = createNode("ink-box");

	setStyle(root, {});
	setStyle(parent, {});
	setStyle(child, {});

	appendChildNode(root, parent);
	appendChildNode(parent, child);

	setRect(root, 0, 0, 40, 20);
	setRect(parent, 2, 2, 30, 10);
	setRect(child, 5, 5, 10, 3);

	return {root, parent, child};
};

describe("hit-test + dispatch integration", () => {
	it("hitTest finds the deepest node containing the point", () => {
		const {root, parent, child} = buildTree();

		// Point inside child.
		expect(hitTest(root, 6, 6)).toBe(child);
		// Point inside parent but outside child.
		expect(hitTest(root, 3, 3)).toBe(parent);
		// Point only inside root.
		expect(hitTest(root, 0, 0)).toBe(root);
		// Point outside everything.
		expect(hitTest(root, 100, 100)).toBeNull();
	});

	it("dispatchClick fires the child's onClick with correct coordinates", () => {
		const {root, child} = buildTree();

		const onClick = vi.fn();
		child.onClick = onClick;

		const target = hitTest(root, 7, 6);
		expect(target).toBe(child);

		const event: MouseEventData = {
			x: 7,
			y: 6,
			button: 0,
			ctrl: false,
			alt: false,
			shift: false,
		};

		dispatchClick(target!, event);

		expect(onClick).toHaveBeenCalledTimes(1);
		const received = onClick.mock.calls[0]![0] as MouseEventData;
		expect(received.x).toBe(7);
		expect(received.y).toBe(6);
		expect(received.button).toBe(0);
	});

	it("dispatchClick bubbles from child up to parent", () => {
		const {root, parent, child} = buildTree();

		const order: string[] = [];
		child.onClick = () => order.push("child");
		parent.onClick = () => order.push("parent");
		root.onClick = () => order.push("root");

		const target = hitTest(root, 6, 6);
		dispatchClick(target!, {
			x: 6,
			y: 6,
			button: 0,
			ctrl: false,
			alt: false,
			shift: false,
		});

		expect(order).toEqual(["child", "parent", "root"]);
	});

	it("stopPropagation halts bubbling", () => {
		const {root, parent, child} = buildTree();

		const parentClick = vi.fn();
		child.onClick = (event: MouseEventData & {stopPropagation?: () => void}) => {
			event.stopPropagation?.();
		};
		parent.onClick = parentClick;

		const target = hitTest(root, 6, 6);
		dispatchClick(target!, {
			x: 6,
			y: 6,
			button: 0,
			ctrl: false,
			alt: false,
			shift: false,
		});

		expect(parentClick).not.toHaveBeenCalled();
	});

	it("dispatchWheel fires onWheel with direction and coordinates", () => {
		const {root, child} = buildTree();

		const onWheel = vi.fn();
		child.onWheel = onWheel;

		const target = hitTest(root, 6, 6);
		dispatchWheel(target!, {
			x: 6,
			y: 6,
			direction: "up",
			ctrl: false,
			alt: false,
			shift: false,
		});

		expect(onWheel).toHaveBeenCalledTimes(1);
		const received = onWheel.mock.calls[0]![0] as WheelEventData;
		expect(received.direction).toBe("up");
		expect(received.x).toBe(6);
		expect(received.y).toBe(6);
	});

	it("dispatchWheel bubbles and respects stopPropagation", () => {
		const {root, parent, child} = buildTree();

		const rootWheel = vi.fn();
		child.onWheel = (
			event: WheelEventData & {stopPropagation?: () => void},
		) => {
			event.stopPropagation?.();
		};
		root.onWheel = rootWheel;

		const target = hitTest(root, 6, 6);
		dispatchWheel(target!, {
			x: 6,
			y: 6,
			direction: "down",
			ctrl: false,
			alt: false,
			shift: false,
		});

		expect(rootWheel).not.toHaveBeenCalled();
	});
});

describe("parseMouseEvent + hitTest end to end", () => {
	it("parses an SGR wheel-up sequence and hit-tests to the right node", () => {
		const {root, child} = buildTree();

		// SGR wheel-up: button field 64 (0x40, wheel, low bit 0 = up). The child
		// sits at (5,5)..(14,7). Target column 7, row 6 -> 1-indexed col 8, row 7.
		const sequence = "\x1b[<64;8;7M";
		const parsed = parseMouseEvent(sequence);

		expect(parsed).not.toBeNull();
		expect(parsed!.wheel).toBe("up");
		expect(parsed!.x).toBe(7);
		expect(parsed!.y).toBe(6);

		const target = hitTest(root, parsed!.x, parsed!.y);
		expect(target).toBe(child);

		const onWheel = vi.fn();
		child.onWheel = onWheel;

		dispatchWheel(target!, {
			x: parsed!.x,
			y: parsed!.y,
			direction: parsed!.wheel!,
			ctrl: parsed!.ctrl,
			alt: parsed!.alt,
			shift: parsed!.shift,
		});

		expect(onWheel).toHaveBeenCalledTimes(1);
		expect((onWheel.mock.calls[0]![0] as WheelEventData).direction).toBe(
			"up",
		);
	});

	it("parses an SGR press sequence and hit-tests to parent when outside child", () => {
		const {root, parent} = buildTree();

		// Press (button 0) at 1-indexed col 4, row 4 -> 0-indexed (3,3), which is
		// inside parent but outside child.
		const sequence = "\x1b[<0;4;4M";
		const parsed = parseMouseEvent(sequence);

		expect(parsed).not.toBeNull();
		expect(parsed!.action).toBe("press");
		expect(parsed!.button).toBe(0);
		expect(parsed!.x).toBe(3);
		expect(parsed!.y).toBe(3);

		const target = hitTest(root, parsed!.x, parsed!.y);
		expect(target).toBe(parent);
	});
});
