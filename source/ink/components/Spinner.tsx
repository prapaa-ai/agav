import React, {useEffect, useState} from "react";
import Text from "./Text.js";

// The braille "dots" spinner from cli-spinners, inlined. The previous
// `ink-spinner` dependency imported `Text` from the npm `ink` package, which
// pulled a second copy of Ink — reconciler, yoga instance and all — into the
// bundle just to animate one character, and rendered that foreign `Text`
// through this fork's reconciler.
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL = 80;

/** An animated single-character spinner. Inherits color from its parent. */
export default function Spinner(): React.ReactNode {
	const [frame, setFrame] = useState(0);

	useEffect(() => {
		const timer = setInterval(() => {
			setFrame(previous => (previous + 1) % FRAMES.length);
		}, INTERVAL);

		return () => {
			clearInterval(timer);
		};
	}, []);

	return React.createElement(Text, null, FRAMES[frame]);
}
