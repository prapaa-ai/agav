// These type aliases mirror the ones Ink pulls in from `cli-boxes`,
// `type-fest`, and `ansi-styles`. Those packages are not hoisted as direct
// dependencies of this project, so we inline the shapes here to keep the fork
// self-contained while preserving identical runtime behavior.

/** A named box style (e.g. `'single'`, `'round'`, `'double'`) or a custom set of border characters. */
type BorderStyle =
	| string
	| {
			readonly topLeft: string;
			readonly top: string;
			readonly topRight: string;
			readonly right: string;
			readonly bottomRight: string;
			readonly bottom: string;
			readonly bottomLeft: string;
			readonly left: string;
	  };

/** A color name (e.g. `'red'`, `'green'`) or any string accepted by chalk. */
type ColorName = string;

/**
 * Data passed to mouse handlers (`onClick`, `onMouseDown`, etc.).
 *
 * Coordinates are terminal cell offsets relative to the top-left of the
 * element that the event is dispatched to.
 */
export type MouseEventData = {
	x: number;
	y: number;
	button: number;
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
	/**
	 * Stop the event bubbling to ancestor handlers. Always supplied by the
	 * dispatcher; optional so handlers can be called directly in tests.
	 */
	stopPropagation?: () => void;
};

/** Data passed to `onWheel` handlers. */
export type WheelEventData = {
	x: number;
	y: number;
	direction: "up" | "down";
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
	/** See {@link MouseEventData.stopPropagation}. */
	stopPropagation?: () => void;
};

/**
 * Style properties applied to a node. Ported from Ink's `styles.d.ts` so the
 * fork stays a drop-in replacement.
 */
export type Styles = {
	readonly textWrap?:
		| "wrap"
		| "hard"
		| "truncate-end"
		| "truncate"
		| "truncate-middle"
		| "truncate-start";

	/**
	 * Controls how the element is positioned.
	 *
	 * When `position` is `static`, `top`, `right`, `bottom`, and `left` are
	 * ignored.
	 */
	readonly position?: "absolute" | "relative" | "static";

	/** Top offset for positioned elements. */
	readonly top?: number | string;

	/** Right offset for positioned elements. */
	readonly right?: number | string;

	/** Bottom offset for positioned elements. */
	readonly bottom?: number | string;

	/** Left offset for positioned elements. */
	readonly left?: number | string;

	/** Size of the gap between an element's columns. */
	readonly columnGap?: number;

	/** Size of the gap between an element's rows. */
	readonly rowGap?: number;

	/**
	 * Size of the gap between an element's columns and rows. A shorthand for
	 * `columnGap` and `rowGap`.
	 */
	readonly gap?: number;

	/**
	 * Margin on all sides. Equivalent to setting `marginTop`, `marginBottom`,
	 * `marginLeft`, and `marginRight`.
	 */
	readonly margin?: number;

	/** Horizontal margin. Equivalent to setting `marginLeft` and `marginRight`. */
	readonly marginX?: number;

	/** Vertical margin. Equivalent to setting `marginTop` and `marginBottom`. */
	readonly marginY?: number;

	/** Top margin. */
	readonly marginTop?: number;

	/** Bottom margin. */
	readonly marginBottom?: number;

	/** Left margin. */
	readonly marginLeft?: number;

	/** Right margin. */
	readonly marginRight?: number;

	/**
	 * Padding on all sides. Equivalent to setting `paddingTop`, `paddingBottom`,
	 * `paddingLeft`, and `paddingRight`.
	 */
	readonly padding?: number;

	/**
	 * Horizontal padding. Equivalent to setting `paddingLeft` and
	 * `paddingRight`.
	 */
	readonly paddingX?: number;

	/** Vertical padding. Equivalent to setting `paddingTop` and `paddingBottom`. */
	readonly paddingY?: number;

	/** Top padding. */
	readonly paddingTop?: number;

	/** Bottom padding. */
	readonly paddingBottom?: number;

	/** Left padding. */
	readonly paddingLeft?: number;

	/** Right padding. */
	readonly paddingRight?: number;

	/** This property defines the ability for a flex item to grow if necessary. */
	readonly flexGrow?: number;

	/**
	 * It specifies the "flex shrink factor", which determines how much the flex
	 * item will shrink relative to the rest of the flex items in the flex
	 * container when there isn't enough space on the row.
	 */
	readonly flexShrink?: number;

	/**
	 * It establishes the main-axis, thus defining the direction flex items are
	 * placed in the flex container.
	 */
	readonly flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";

	/**
	 * It specifies the initial size of the flex item, before any available space
	 * is distributed according to the flex factors.
	 */
	readonly flexBasis?: number | string;

	/**
	 * It defines whether the flex items are forced in a single line or can be
	 * flowed into multiple lines.
	 */
	readonly flexWrap?: "nowrap" | "wrap" | "wrap-reverse";

	/**
	 * The align-items property defines the default behavior for how items are
	 * laid out along the cross axis (perpendicular to the main axis).
	 */
	readonly alignItems?:
		| "flex-start"
		| "center"
		| "flex-end"
		| "stretch"
		| "baseline";

	/** It makes possible to override the align-items value for specific flex items. */
	readonly alignSelf?:
		| "flex-start"
		| "center"
		| "flex-end"
		| "auto"
		| "stretch"
		| "baseline";

	/**
	 * It defines the alignment along the cross axis when there are multiple lines
	 * of flex items (when using flex-wrap).
	 */
	readonly alignContent?:
		| "flex-start"
		| "flex-end"
		| "center"
		| "stretch"
		| "space-between"
		| "space-around"
		| "space-evenly";

	/** It defines the alignment along the main axis. */
	readonly justifyContent?:
		| "flex-start"
		| "flex-end"
		| "space-between"
		| "space-around"
		| "space-evenly"
		| "center";

	/**
	 * Width of the element in spaces. You can also set it as a percentage, which
	 * will calculate the width based on the width of the parent element.
	 */
	readonly width?: number | string;

	/**
	 * Height of the element in lines (rows). You can also set it as a percentage,
	 * which will calculate the height based on the height of the parent element.
	 */
	readonly height?: number | string;

	/** Sets a minimum width of the element. */
	readonly minWidth?: number | string;

	/** Sets a minimum height of the element in lines (rows). */
	readonly minHeight?: number | string;

	/** Sets a maximum width of the element. */
	readonly maxWidth?: number | string;

	/** Sets a maximum height of the element in lines (rows). */
	readonly maxHeight?: number | string;

	/** Defines the aspect ratio (width/height) for the element. */
	readonly aspectRatio?: number;

	/** Set this property to `none` to hide the element. */
	readonly display?: "flex" | "none";

	/**
	 * Add a border with a specified style. If `borderStyle` is `undefined` (the
	 * default), no border will be added.
	 */
	readonly borderStyle?: BorderStyle;

	/** Determines whether the top border is visible. */
	readonly borderTop?: boolean;

	/** Determines whether the bottom border is visible. */
	readonly borderBottom?: boolean;

	/** Determines whether the left border is visible. */
	readonly borderLeft?: boolean;

	/** Determines whether the right border is visible. */
	readonly borderRight?: boolean;

	/** Change border color. */
	readonly borderColor?: ColorName;

	/** Change the top border color. */
	readonly borderTopColor?: ColorName;

	/** Change the bottom border color. */
	readonly borderBottomColor?: ColorName;

	/** Change the left border color. */
	readonly borderLeftColor?: ColorName;

	/** Change the right border color. */
	readonly borderRightColor?: ColorName;

	/** Dim the border color. */
	readonly borderDimColor?: boolean;

	/** Dim the top border color. */
	readonly borderTopDimColor?: boolean;

	/** Dim the bottom border color. */
	readonly borderBottomDimColor?: boolean;

	/** Dim the left border color. */
	readonly borderLeftDimColor?: boolean;

	/** Dim the right border color. */
	readonly borderRightDimColor?: boolean;

	/** Change border background color. */
	readonly borderBackgroundColor?: ColorName;

	/** Change top border background color. */
	readonly borderTopBackgroundColor?: ColorName;

	/** Change bottom border background color. */
	readonly borderBottomBackgroundColor?: ColorName;

	/** Change left border background color. */
	readonly borderLeftBackgroundColor?: ColorName;

	/** Change right border background color. */
	readonly borderRightBackgroundColor?: ColorName;

	/** Behavior for an element's overflow in both directions. */
	readonly overflow?: "visible" | "hidden";

	/** Behavior for an element's overflow in the horizontal direction. */
	readonly overflowX?: "visible" | "hidden";

	/** Behavior for an element's overflow in the vertical direction. */
	readonly overflowY?: "visible" | "hidden";

	/** Background color for the element. */
	readonly backgroundColor?: ColorName;
};
