// Clipboard support. Tries platform-native commands first (pbcopy on macOS,
// xclip/xsel/wl-copy on Linux, clip on Windows) and falls back to OSC 52 when
// no native tool is available.

import { platform } from "node:os";
import { spawn } from "node:child_process";

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
 * Resolve the clipboard command once at module load. The platform and
 * WAYLAND_DISPLAY are process-lifetime constants.
 */
const resolveClipboardCmd = (): { cmd: string; args: string[] } | null => {
	const os = platform();
	if (os === "darwin") return { cmd: "pbcopy", args: [] };
	if (os === "win32") return { cmd: "clip", args: [] };
	if (process.env["WAYLAND_DISPLAY"]) return { cmd: "wl-copy", args: [] };
	return { cmd: "xclip", args: ["-selection", "clipboard"] };
};

const clipboardCmd = resolveClipboardCmd();

/**
 * Try to copy text via a platform-native clipboard command.
 * Returns true if a command was spawned, false if none was available.
 */
const nativeCopy = (text: string): boolean => {
	if (!clipboardCmd) return false;
	try {
		const child = spawn(clipboardCmd.cmd, clipboardCmd.args, { stdio: ["pipe", "ignore", "ignore"] });
		child.stdin?.write(text);
		child.stdin?.end();
		child.on("error", () => {}); // swallow ENOENT
		return true;
	} catch {
		return false;
	}
};

/**
 * Copy text to the system clipboard. Tries a native clipboard command first
 * (pbcopy, xclip, etc.) and falls back to OSC 52 (which requires terminal
 * support — e.g. iTerm2, Alacritty, WezTerm — and does not work in macOS
 * Terminal.app or many SSH sessions).
 */
export const writeClipboard = (
	stream: NodeJS.WriteStream,
	text: string,
): void => {
	// Try native first — most reliable, works in all terminals.
	if (nativeCopy(text)) return;

	// Fallback to OSC 52.
	const sequence = osc52Copy(text);
	stream.write(process.env["TMUX"] ? wrapTmux(sequence) : sequence);
};
