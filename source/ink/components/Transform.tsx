import React from "react";

export type Props = {
	/**
	 * Function which transforms children output. It accepts children and must
	 * return transformed children too.
	 */
	readonly transform: (children: string, index: number) => string;
	readonly children?: React.ReactNode;
};

/**
 * Transform a string representation of React components before they're written
 * to output. For example, you might want to apply a gradient to text, add a
 * clickable link, or create some text effects. These use cases can't accept
 * React nodes as input; they expect a string. That's what the <Transform>
 * component does: it gives you an output string of its child components and
 * lets you transform it in any way.
 */
export default function Transform({
	children,
	transform,
}: Props): React.ReactNode {
	if (children === undefined || children === null) {
		return null;
	}

	return React.createElement(
		"ink-text",
		{
			style: {flexGrow: 0, flexShrink: 1, flexDirection: "row"},
			// eslint-disable-next-line @typescript-eslint/naming-convention
			internal_transform: transform,
		},
		children,
	);
}
