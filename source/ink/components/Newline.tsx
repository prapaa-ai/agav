import React from "react";

export type Props = {
	/** Number of newlines to insert. */
	readonly count?: number;
};

/**
 * Adds one or more newline (`\n`) characters. Must be used within `<Text>`
 * components.
 */
export default function Newline({count = 1}: Props): React.ReactNode {
	return React.createElement("ink-text", null, "\n".repeat(count));
}
