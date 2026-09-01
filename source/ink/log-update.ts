import ansiEscapes from "ansi-escapes";
import cliCursor from "cli-cursor";

// A minimal port of Ink's log-update. Repaints a block of text in place by
// erasing the previously written lines and writing the new content. The
// standard (non-incremental) variant is enough for the agav fork.

export type LogUpdate = {
	(str: string): void;
	clear: () => void;
	done: () => void;
	sync: (str: string) => void;
	reset: () => void;
};

type Options = {
	showCursor?: boolean;
};

const createStandard = (
	stream: NodeJS.WriteStream,
	{showCursor = false}: Options = {},
): LogUpdate => {
	let previousLineCount = 0;
	let previousOutput = "";
	let hasHiddenCursor = false;

	const render = ((str: string): void => {
		if (!showCursor && !hasHiddenCursor) {
			cliCursor.hide(stream);
			hasHiddenCursor = true;
		}

		if (str === previousOutput) {
			return;
		}

		previousOutput = str;
		stream.write(ansiEscapes.eraseLines(previousLineCount) + str);
		previousLineCount = str.split("\n").length;
	}) as LogUpdate;

	render.clear = () => {
		stream.write(ansiEscapes.eraseLines(previousLineCount));
		previousOutput = "";
		previousLineCount = 0;
	};

	render.done = () => {
		previousOutput = "";
		previousLineCount = 0;

		if (!showCursor) {
			cliCursor.show(stream);
			hasHiddenCursor = false;
		}
	};

	// Forget the frame on screen without writing anything, for callers that
	// have already erased the terminal themselves. `clear()` would emit an
	// eraseLines() for lines that are no longer there.
	render.reset = () => {
		previousOutput = "";
		previousLineCount = 0;
	};

	// Sync internal state to `str` without writing anything. Used so a
	// subsequent render of the same content is treated as a no-op.
	render.sync = (str: string) => {
		previousOutput = str;
		previousLineCount = str.split("\n").length;
	};

	return render;
};

const create = (
	stream: NodeJS.WriteStream,
	options: Options = {},
): LogUpdate => createStandard(stream, options);

const logUpdate = {create};

export default logUpdate;
