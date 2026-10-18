// Clipboard support. Tries platform-native commands first (pbcopy on macOS,
// xclip/xsel/wl-copy or GTK on X11 Linux, PowerShell/clip on Windows) and falls
// back to OSC 52 when no native method is available.

import { platform } from "node:os";
import { execFile, execFileSync, spawn } from "node:child_process";

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
		// On X11 GNOME, GTK/Python GI can provide a clipboard without xclip/xsel.
		// The GTK helper has only been verified on X11; prefer wl-copy on Wayland.
		if (process.env["DISPLAY"] && !process.env["WAYLAND_DISPLAY"] && commandExists("python3")) {
			return { cmd: "python3-gtk", args: [] };
		}
	}

	return null;
};

const clipboardCmd = resolveClipboardCmd();
const GTK_STARTUP_TIMEOUT_MS = 2000;

export type ClipboardNotice = "Copied to clipboard" | "Copy sent to terminal";
const copyListeners = new Set<(notice: ClipboardNotice) => void>();

/** Subscribe to copy actions so the UI can show brief feedback. */
export const subscribeClipboardCopy = (listener: (notice: ClipboardNotice) => void): (() => void) => {
	copyListeners.add(listener);
	return () => copyListeners.delete(listener);
};

const notifyClipboardCopy = (notice: ClipboardNotice): void => {
	for (const listener of copyListeners) listener(notice);
};

// X11 clipboard data is owned by a running process. A short-lived GTK command
// loses the selection as soon as it exits when no clipboard manager is present.
// Keep the helper alive until a new owner takes the selection. The initial
// owner-change notification is processed before the listener is installed.
const gtkCopyScript = `
import sys
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib

if Gdk.Display.get_default() is None:
    sys.exit(1)
clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
clipboard.set_text(sys.stdin.read(), -1)
print("READY", flush=True)

def watch_owner():
    clipboard.connect("owner-change", lambda *_: Gtk.main_quit())
    return False

GLib.timeout_add(100, watch_owner)
Gtk.main()
`;

/**
 * Copy text via the platform-native clipboard command resolved at startup.
 * Returns true when a command was launched. onFailure is used only when the
 * native path cannot have completed a copy; stdin-pipe exit errors are
 * ambiguous and must not trigger a second clipboard write.
 *
 * On Windows, `clip.exe` reads stdin using the console's active code page
 * (usually CP437 or CP1252), not UTF-8, so non-ASCII characters like `•`,
 * `→`, and box-drawing symbols get garbled. We use PowerShell's
 * `Set-Clipboard` instead, which handles Unicode natively.
 */
const nativeCopy = (text: string, onSuccess: () => void, onFailure: () => void): boolean => {
	if (!clipboardCmd) return false;
	try {
		if (clipboardCmd.cmd === "python3-gtk") {
			const child = spawn("python3", ["-c", gtkCopyScript], {
				detached: true,
				stdio: ["pipe", "pipe", "ignore"],
			});
			let settled = false;
			let readiness = "";
			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				child.kill();
				onFailure();
			}, GTK_STARTUP_TIMEOUT_MS);
			timeout.unref();
			const fail = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				onFailure();
			};
			child.on("error", fail);
			// `close` runs after stdout is drained, so a late READY marker wins
			// over the exit status before we decide to use OSC 52.
			child.on("close", () => fail());
			child.stdout.on("data", data => {
				if (settled) return;
				readiness = (readiness + String(data)).slice(-32);
				if (!readiness.includes("READY")) return;
				settled = true;
				clearTimeout(timeout);
				onSuccess();
				child.stdout.destroy();
			});
			child.stdin.on("error", () => {});
			try {
				child.stdin.end(text);
			} catch {
				child.kill();
				fail();
			}
			child.unref();
			return true;
		}
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
				error => {
					if (error) onFailure();
					else onSuccess();
				},
			);
			child.on("error", () => {}); // swallow spawn failures (command missing, etc.)
			return true;
		}

		// pbcopy / xclip / xsel read the text from stdin, which must be written
		// and then closed with .end() so the tool sees EOF and exits. execFile
		// (over a bare spawn) gives us the completion callback that reaps the
		// child, but it has no `input` option for the async form — the payload
		// still has to go through child.stdin explicitly.
		const child = execFile(clipboardCmd.cmd, clipboardCmd.args, error => {
			// A nonzero exit can follow a partial or complete clipboard write.
			// Sending OSC 52 then could overwrite the text a native tool copied.
			if (!error) onSuccess();
		});
		let launched = false;
		child.once("spawn", () => { launched = true; });
		child.on("error", () => {
			// ChildProcess can also emit error after launch. Only a failed
			// spawn proves that no clipboard write occurred.
			if (!launched) onFailure();
		});
		child.stdin?.on("error", () => {}); // guard against EPIPE if the tool exits early
		try {
			child.stdin?.end(text); // write payload and signal EOF in one call
		} catch {
			// The tool was launched and may already have consumed bytes. Do not
			// send a second copy through OSC 52 after a possible partial write.
		}
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
	let fellBack = false;
	const fallback = () => {
		if (fellBack) return;
		fellBack = true;
		const sequence = osc52Copy(text);
		stream.write(process.env["TMUX"] ? wrapTmux(sequence) : sequence);
		notifyClipboardCopy("Copy sent to terminal");
	};
	// Try native first — most reliable, works in all terminals.
	if (nativeCopy(text, () => notifyClipboardCopy("Copied to clipboard"), fallback)) return;

	// Fallback to OSC 52.
	fallback();
};
