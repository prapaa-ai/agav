// Clipboard support. Tries platform-native commands first (pbcopy on macOS,
// xclip/xsel/wl-copy on Linux, clip on Windows) and falls back to OSC 52 when
// no native tool is available.

import { platform } from "node:os";
import { execFile, execFileSync } from "node:child_process";

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

/** Check whether a command is available on the system PATH. */
const commandExists = (cmd: string): boolean => {
	try {
		// `which` on POSIX, `where` on Windows — both exit non-zero when
		// the command is not found, which makes execFileSync throw.
		const checker = platform() === "win32" ? "where" : "which";
		execFileSync(checker, [cmd], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

/**
 * Resolve the clipboard command once at module load. The platform and
 * WAYLAND_DISPLAY are process-lifetime constants. Returns null when no
 * native clipboard tool is installed so the caller falls back to OSC 52.
 */
const resolveClipboardCmd = (): { cmd: string; args: string[] } | null => {
	const os = platform();

	if (os === "darwin" && commandExists("pbcopy")) {
		return { cmd: "pbcopy", args: [] };
	}

	if (os === "win32") {
		// Prefer PowerShell's Set-Clipboard over clip.exe — clip reads stdin
		// in the console's active code page (CP437/CP1252), garbling any
		// non-ASCII characters like bullets, arrows, or box-drawing symbols.
		// PowerShell handles Unicode natively.
		if (commandExists("powershell")) {
			return { cmd: "powershell", args: [] };
		}
		if (commandExists("clip")) {
			return { cmd: "clip", args: [] };
		}
	}

	// Linux / FreeBSD: try clipboard tools in preference order.
	if (os !== "darwin" && os !== "win32") {
		if (process.env["WAYLAND_DISPLAY"] && commandExists("wl-copy")) {
			return { cmd: "wl-copy", args: [] };
		}
		if (commandExists("xclip")) {
			return { cmd: "xclip", args: ["-selection", "clipboard"] };
		}
		if (commandExists("xsel")) {
			return { cmd: "xsel", args: ["--clipboard", "--input"] };
		}
	}

	return null;
};

const clipboardCmd = resolveClipboardCmd();

/**
 * Copy text via the platform-native clipboard command resolved at startup.
 * Returns true only when a verified command was spawned successfully.
 *
 * On Windows, `clip.exe` reads stdin using the console's active code page
 * (usually CP437 or CP1252), not UTF-8, so non-ASCII characters like `•`,
 * `→`, and box-drawing symbols get garbled. We use PowerShell's
 * `Set-Clipboard` instead, which handles Unicode natively.
 */
const nativeCopy = (text: string): boolean => {
	if (!clipboardCmd) return false;
	try {
		if (clipboardCmd.cmd === "powershell") {
			// PowerShell path: pass text as a Base64-encoded UTF-16LE string
			// baked into the command itself, so this path takes no stdin.
			// execFile buffers and reaps the child via its callback, so the
			// process handle is released the moment PowerShell exits — no
			// long-lived child accumulates over a session.
			const utf16 = Buffer.from(text, "utf16le").toString("base64");
			const ps = `[System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${utf16}')) | Set-Clipboard`;
			const child = execFile(
				"powershell",
				["-NoProfile", "-Command", ps],
				{ windowsHide: true },
				() => {},
			);
			child.on("error", () => {}); // swallow spawn failures (command missing, etc.)
			return true;
		}

		// pbcopy / xclip / xsel read the text from stdin, which must be written
		// and then closed with .end() so the tool sees EOF and exits. execFile
		// (over a bare spawn) gives us the completion callback that reaps the
		// child, but it has no `input` option for the async form — the payload
		// still has to go through child.stdin explicitly.
		const child = execFile(clipboardCmd.cmd, clipboardCmd.args, () => {});
		child.on("error", () => {}); // swallow unexpected runtime errors
		child.stdin?.on("error", () => {}); // guard against EPIPE if the tool exits early
		child.stdin?.end(text); // write payload and signal EOF in one call
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
