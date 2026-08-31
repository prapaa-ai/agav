import { execFile } from "node:child_process";

/**
 * Read text from the system clipboard using platform-specific commands.
 *
 * - macOS:   `pbpaste`
 * - Windows: `powershell.exe -NoProfile -Command Get-Clipboard`
 * - Linux:   `xsel --clipboard --output` → `xclip -selection clipboard -o` → `wl-paste --no-newline`
 *
 * Returns `null` if the clipboard is empty, unreadable, or the command is not
 * available.  Never throws.
 */
export async function getClipboardText(): Promise<string | null> {
  const commands = clipboardCommands();

  for (const [cmd, args] of commands) {
    const text = await tryCommand(cmd, args);
    if (text !== null) return text;
  }

  return null;
}

function clipboardCommands(): Array<[string, string[]]> {
  switch (process.platform) {
    case "darwin":
      return [["pbpaste", []]];
    case "win32":
      return [["powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard"]]];
    default:
      // Linux / FreeBSD — try multiple clipboard managers in order of preference.
      return [
        ["xsel", ["--clipboard", "--output"]],
        ["xclip", ["-selection", "clipboard", "-o"]],
        ["wl-paste", ["--no-newline"]],
      ];
  }
}

function tryCommand(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const text = stdout.toString();
      resolve(text.length > 0 ? text : null);
    });
  });
}
