// OSC 52 clipboard support. OSC 52 lets a terminal application set the system
// clipboard without shelling out to pbcopy/xclip:
//
//   \x1b]52;c;<base64>\x07
//
// When running inside tmux, the sequence must be wrapped in a DCS passthrough
// so tmux forwards it to the outer terminal instead of consuming it.

/** Build the OSC 52 escape sequence that sets the system clipboard. */
export const osc52Copy = (text: string): string => {
	const base64 = Buffer.from(text).toString("base64");
	return `\x1b]52;c;${base64}\x07`;
};

/**
 * Wrap a control sequence in a tmux DCS passthrough. Inside the wrapper, any
 * ESC bytes must be doubled so tmux emits a single ESC to the outer terminal.
 *
 *   \x1bPtmux;\x1b<escaped-seq>\x1b\\
 */
const wrapTmux = (sequence: string): string => {
	const escaped = sequence.replaceAll("\x1b", "\x1b\x1b");
	return `\x1bPtmux;\x1b${escaped}\x1b\\`;
};

/**
 * Write an OSC 52 clipboard-set sequence for `text` to `stream`. If running
 * inside tmux (TMUX env var set), the sequence is wrapped in DCS passthrough.
 */
export const writeClipboard = (
	stream: NodeJS.WriteStream,
	text: string,
): void => {
	const sequence = osc52Copy(text);
	stream.write(process.env["TMUX"] ? wrapTmux(sequence) : sequence);
};
