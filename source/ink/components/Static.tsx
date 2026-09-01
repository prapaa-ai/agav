import React, {useMemo, useState, useLayoutEffect} from "react";
import {type Styles} from "../types.js";

export type Props<T> = {
	/**
	 * Array of items of any type to render using a function you pass as a
	 * component child.
	 */
	readonly items: T[];
	/** Styles to apply to a container of child elements. */
	readonly style?: Styles;
	/**
	 * Function that is called to render every item in `items` array. First
	 * argument is an item itself and second argument is index of that item in
	 * `items` array. Note that `key` must be assigned to the root component.
	 */
	readonly children: (item: T, index: number) => React.ReactNode;
};

/**
 * `<Static>` component permanently renders its output above everything else.
 * It's useful for displaying activity like completed tasks or logs—things that
 * don't change after they're rendered (hence the name "Static").
 */
export default function Static<T>(props: Props<T>): React.ReactNode {
	const {items, children: render, style: customStyle} = props;
	const [index, setIndex] = useState(0);

	const itemsToRender = useMemo(() => {
		return items.slice(index);
	}, [items, index]);

	useLayoutEffect(() => {
		setIndex(items.length);
	}, [items.length]);

	const children = itemsToRender.map((item, itemIndex) => {
		return render(item, index + itemIndex);
	});

	const style = useMemo<Styles>(
		() => ({
			position: "absolute",
			flexDirection: "column",
			...customStyle,
		}),
		[customStyle],
	);

	return React.createElement(
		"ink-box",
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			internal_static: true,
			style,
		},
		children,
	);
}
