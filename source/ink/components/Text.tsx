import React from "react";
import chalk from "chalk";
import colorize from "../colorize.js";
import {type Styles} from "../types.js";
import {type MouseHandlers} from "./Box.js";

export type Props = MouseHandlers & {
	/**
	 * Change text color. Ink uses Chalk under the hood, so all its
	 * functionality is supported.
	 */
	readonly color?: string;
	/** Same as `color`, but for the background. */
	readonly backgroundColor?: string;
	/** Dim the color (make it less bright). */
	readonly dimColor?: boolean;
	/** Make the text bold. */
	readonly bold?: boolean;
	/** Make the text italic. */
	readonly italic?: boolean;
	/** Make the text underlined. */
	readonly underline?: boolean;
	/** Make the text crossed out with a line. */
	readonly strikethrough?: boolean;
	/** Inverse background and foreground colors. */
	readonly inverse?: boolean;
	/**
	 * This property tells Ink to wrap or truncate text if its width is larger
	 * than the container.
	 */
	readonly wrap?: Styles["textWrap"];
	readonly children?: React.ReactNode;
};

/**
 * This component can display text and change its style to make it bold,
 * underlined, italic, or strikethrough.
 */
export default function Text({
	color,
	backgroundColor,
	dimColor = false,
	bold = false,
	italic = false,
	underline = false,
	strikethrough = false,
	inverse = false,
	wrap = "wrap",
	children,
	onClick,
	onMouseDown,
	onMouseUp,
	onMouseEnter,
	onMouseLeave,
	onWheel,
}: Props): React.ReactNode {
	if (children === undefined || children === null) {
		return null;
	}

	const transform = (children: string): string => {
		if (dimColor) {
			children = chalk.dim(children);
		}

		if (color) {
			children = colorize(children, color, "foreground");
		}

		if (backgroundColor) {
			children = colorize(children, backgroundColor, "background");
		}

		if (bold) {
			children = chalk.bold(children);
		}

		if (italic) {
			children = chalk.italic(children);
		}

		if (underline) {
			children = chalk.underline(children);
		}

		if (strikethrough) {
			children = chalk.strikethrough(children);
		}

		if (inverse) {
			children = chalk.inverse(children);
		}

		return children;
	};

	return React.createElement(
		"ink-text",
		{
			style: {
				flexGrow: 0,
				flexShrink: 1,
				flexDirection: "row",
				textWrap: wrap,
			},
			// eslint-disable-next-line @typescript-eslint/naming-convention
			internal_transform: transform,
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
}
