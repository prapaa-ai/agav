import process from "node:process";
import createReconciler from "react-reconciler";
import {
	DefaultEventPriority,
	NoEventPriority,
} from "react-reconciler/constants.js";
import * as Scheduler from "scheduler";
import Yoga from "yoga-layout";
import {createContext, version as reactVersion} from "react";
import {
	type TextNode,
	type DOMElement,
	type ElementNames,
	createTextNode,
	appendChildNode,
	insertBeforeNode,
	removeChildNode,
	emitLayoutListeners,
	setStyle,
	setTextNodeValue,
	createNode,
	setAttribute,
} from "./dom.js";
import applyStyles from "./styles.js";
import {type MouseEventData, type WheelEventData} from "./types.js";

// React DevTools integration from upstream Ink is intentionally omitted from
// this fork. It required a `./devtools.js` module and a top-level `await import`
// that `bun build --compile` cannot statically resolve. It is dev-only and adds
// no runtime value in the shipped binary.

// Props passed to host elements.
type Props = Record<string, unknown>;

// Mouse handler prop keys that must be assigned directly to the node rather
// than stored on `node.attributes` via `setAttribute`.
const mouseHandlerKeys = new Set([
	"onClick",
	"onMouseDown",
	"onMouseUp",
	"onMouseMove",
	"onMouseEnter",
	"onMouseLeave",
	"onWheel",
]);

type MouseHandlerKey =
	| "onClick"
	| "onMouseDown"
	| "onMouseUp"
	| "onMouseEnter"
	| "onMouseLeave";

const isMouseHandlerKey = (key: string): key is MouseHandlerKey => {
	return (
		key === "onClick" ||
		key === "onMouseDown" ||
		key === "onMouseUp" ||
		key === "onMouseEnter" ||
		key === "onMouseLeave"
	);
};

const assignMouseHandler = (
	node: DOMElement,
	key: string,
	value: unknown,
): void => {
	if (key === "onWheel") {
		node.onWheel = value as (event: WheelEventData) => void;
		return;
	}

	if (isMouseHandlerKey(key)) {
		node[key] = value as (event: MouseEventData) => void;
	}
};

const diff = (
	before: Props | undefined,
	after: Props | undefined,
): Props | undefined => {
	if (before === after) {
		return;
	}

	if (!before) {
		return after;
	}

	const changed: Props = {};
	let isChanged = false;

	for (const key of Object.keys(before)) {
		const isDeleted = after ? !Object.hasOwn(after, key) : true;

		if (isDeleted) {
			changed[key] = undefined;
			isChanged = true;
		}
	}

	if (after) {
		for (const key of Object.keys(after)) {
			if (after[key] !== before[key]) {
				changed[key] = after[key];
				isChanged = true;
			}
		}
	}

	return isChanged ? changed : undefined;
};

const cleanupYogaNode = (node?: DOMElement["yogaNode"]): void => {
	node?.unsetMeasureFunc();
	node?.freeRecursive();
};

let currentUpdatePriority = NoEventPriority;
let currentRootNode: DOMElement | undefined;

// Renderer metadata reported to React. Upstream Ink read this from package.json
// at runtime for DevTools; the fork uses a static value so the compiled binary
// has nothing to resolve at startup.
const packageInfo = {
	name: "ink",
	version: reactVersion,
};

type HostContext = {
	isInsideText: boolean;
};

export default createReconciler<
	ElementNames,
	Props,
	DOMElement,
	DOMElement,
	TextNode,
	DOMElement,
	unknown,
	unknown,
	DOMElement,
	HostContext,
	unknown,
	NodeJS.Timeout,
	number,
	unknown
>({
	getRootHostContext: () => ({
		isInsideText: false,
	}),
	prepareForCommit: () => null,
	preparePortalMount: () => null,
	clearContainer: () => false,
	resetAfterCommit(rootNode) {
		if (typeof rootNode.onComputeLayout === "function") {
			rootNode.onComputeLayout();
		}

		emitLayoutListeners(rootNode);

		/*
		Fire `onStaticChange` BEFORE `onImmediateRender` so ink resets
		accumulated static output before the new instance emits. Without this,
		items from a replaced/removed <Static> stay in `fullStaticOutput` and
		get replayed on rewrites.
		*/
		if (rootNode.staticNode !== rootNode.previousStaticNode) {
			rootNode.previousStaticNode = rootNode.staticNode;

			if (typeof rootNode.onStaticChange === "function") {
				rootNode.onStaticChange();
			}
		}

		// Since renders are throttled at the instance level and <Static>
		// component children are rendered only once and then get deleted, we
		// need an escape hatch to trigger an immediate render to ensure
		// <Static> children are written to output before they get erased
		if (rootNode.isStaticDirty) {
			rootNode.isStaticDirty = false;

			if (typeof rootNode.onImmediateRender === "function") {
				rootNode.onImmediateRender();
			}

			return;
		}

		if (typeof rootNode.onRender === "function") {
			rootNode.onRender();
		}
	},
	getChildHostContext(parentHostContext, type) {
		const previousIsInsideText = parentHostContext.isInsideText;
		const isInsideText = type === "ink-text" || type === "ink-virtual-text";

		if (previousIsInsideText === isInsideText) {
			return parentHostContext;
		}

		return {isInsideText};
	},
	shouldSetTextContent: () => false,
	createInstance(originalType, newProps, rootNode, hostContext) {
		if (hostContext.isInsideText && originalType === "ink-box") {
			throw new Error(`<Box> can’t be nested inside <Text> component`);
		}

		const type =
			originalType === "ink-text" && hostContext.isInsideText
				? "ink-virtual-text"
				: originalType;

		const node = createNode(type);

		for (const [key, value] of Object.entries(newProps)) {
			if (key === "children") {
				continue;
			}

			if (key === "style") {
				setStyle(node, value as DOMElement["style"]);

				if (node.yogaNode) {
					applyStyles(node.yogaNode, value as DOMElement["style"]);
				}

				continue;
			}

			if (key === "internal_transform") {
				node.internal_transform =
					value as DOMElement["internal_transform"];
				continue;
			}

			if (key === "internal_static") {
				currentRootNode = rootNode;
				node.internal_static = true;
				rootNode.isStaticDirty = true;
				// Save reference to <Static> node to skip traversal of entire
				// node tree to find it
				rootNode.staticNode = node;
				continue;
			}

			if (mouseHandlerKeys.has(key)) {
				assignMouseHandler(node, key, value);
				continue;
			}

			setAttribute(node, key, value as string | number | boolean);
		}

		return node;
	},
	createTextInstance(text, _root, hostContext) {
		if (!hostContext.isInsideText) {
			throw new Error(
				`Text string "${text}" must be rendered inside <Text> component`,
			);
		}

		return createTextNode(text);
	},
	resetTextContent() {},
	hideTextInstance(node) {
		setTextNodeValue(node, "");
	},
	unhideTextInstance(node, text) {
		setTextNodeValue(node, text);
	},
	getPublicInstance: instance => instance as DOMElement,
	hideInstance(node) {
		node.yogaNode?.setDisplay(Yoga.DISPLAY_NONE);
	},
	unhideInstance(node) {
		node.yogaNode?.setDisplay(Yoga.DISPLAY_FLEX);
	},
	appendInitialChild: appendChildNode,
	appendChild: appendChildNode,
	insertBefore: insertBeforeNode,
	finalizeInitialChildren() {
		return false;
	},
	isPrimaryRenderer: true,
	supportsMutation: true,
	supportsPersistence: false,
	supportsHydration: false,
	// Scheduler integration for concurrent mode
	supportsMicrotasks: true,
	scheduleMicrotask: queueMicrotask,
	// @ts-expect-error @types/react-reconciler is outdated and doesn't include scheduleCallback
	scheduleCallback: Scheduler.unstable_scheduleCallback,
	cancelCallback: Scheduler.unstable_cancelCallback,
	shouldYield: Scheduler.unstable_shouldYield,
	now: Scheduler.unstable_now,
	scheduleTimeout: setTimeout,
	cancelTimeout: clearTimeout,
	noTimeout: -1,
	beforeActiveInstanceBlur() {},
	afterActiveInstanceBlur() {},
	detachDeletedInstance() {},
	getInstanceFromNode: () => null,
	prepareScopeUpdate() {},
	getInstanceFromScope: () => null,
	appendChildToContainer: appendChildNode,
	insertInContainerBefore: insertBeforeNode,
	removeChildFromContainer(node, removeNode) {
		removeChildNode(node, removeNode);
		cleanupYogaNode(removeNode.yogaNode);

		// Only clear staticNode if it still points at the removed node. On
		// key-driven remounts, `createInstance` already registered the new node
		// before this removal fires.
		if (
			removeNode.internal_static &&
			currentRootNode?.staticNode === removeNode
		) {
			currentRootNode.staticNode = undefined;
		}
	},
	commitUpdate(node, _type, oldProps, newProps) {
		if (currentRootNode && node.internal_static) {
			currentRootNode.isStaticDirty = true;
		}

		const props = diff(oldProps, newProps);
		const style = diff(
			oldProps["style"] as Props | undefined,
			newProps["style"] as Props | undefined,
		);

		if (!props && !style) {
			return;
		}

		if (props) {
			for (const [key, value] of Object.entries(props)) {
				if (key === "style") {
					setStyle(node, value as DOMElement["style"]);
					continue;
				}

				if (key === "internal_transform") {
					node.internal_transform =
						value as DOMElement["internal_transform"];
					continue;
				}

				if (key === "internal_static") {
					node.internal_static = true;
					continue;
				}

				if (mouseHandlerKeys.has(key)) {
					assignMouseHandler(node, key, value);
					continue;
				}

				setAttribute(node, key, value as string | number | boolean);
			}
		}

		if (style && node.yogaNode) {
			applyStyles(
				node.yogaNode,
				style as DOMElement["style"],
				(newProps["style"] ?? {}) as DOMElement["style"],
			);
		}
	},
	commitTextUpdate(node, _oldText, newText) {
		setTextNodeValue(node, newText);
	},
	removeChild(node, removeNode) {
		removeChildNode(node, removeNode);
		cleanupYogaNode(removeNode.yogaNode);

		// Same guard as removeChildFromContainer: only clear if this is still
		// the active static node.
		if (
			removeNode.internal_static &&
			currentRootNode?.staticNode === removeNode
		) {
			currentRootNode.staticNode = undefined;
		}
	},
	setCurrentUpdatePriority(newPriority) {
		currentUpdatePriority = newPriority;
	},
	getCurrentUpdatePriority: () => currentUpdatePriority,
	resolveUpdatePriority() {
		if (currentUpdatePriority !== NoEventPriority) {
			return currentUpdatePriority;
		}

		return DefaultEventPriority;
	},
	maySuspendCommit() {
		// Return true to enable Suspense resource preloading
		return true;
	},
	// eslint-disable-next-line @typescript-eslint/naming-convention
	NotPendingTransition: undefined,
	// The @types/react-reconciler `ReactContext` type is an internal React
	// shape that our `createContext` return value doesn't structurally satisfy.
	// eslint-disable-next-line @typescript-eslint/naming-convention, @typescript-eslint/no-explicit-any
	HostTransitionContext: createContext(null) as any,
	resetFormInstance() {},
	requestPostPaintCallback() {},
	shouldAttemptEagerTransition() {
		return false;
	},
	trackSchedulerEvent() {},
	resolveEventType() {
		return null;
	},
	resolveEventTimeStamp() {
		return -1.1;
	},
	preloadInstance() {
		return true;
	},
	startSuspendingCommit() {},
	suspendInstance() {},
	waitForCommitToBeReady() {
		return null;
	},
	rendererPackageName: packageInfo.name,
	rendererVersion: packageInfo.version,
});
