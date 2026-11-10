import { pathToFileURL } from "node:url";

/**
 * C0 controls (incl. ESC, BEL, CR/LF), DEL and C1 controls (incl. the 8-bit
 * ST/OSC introducers). Any of these inside the URL could end the OSC 8
 * sequence early and let the rest reach the terminal as raw escapes. A valid
 * URL never contains them unencoded, so removing them leaves real URLs as-is.
 */
const OSC_UNSAFE = /[\x00-\x1f\x7f-\x9f]/g;

export function terminalLink(text: string, url: string): string {
  const safeUrl = url.replace(OSC_UNSAFE, "");
  return `\x1b]8;;${safeUrl}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export function fileLink(text: string, filePath: string): string {
  return terminalLink(text, pathToFileURL(filePath).href);
}

export function stripTerminalLinks(text: string): string {
  return text.replace(/\x1b\]8;;[^\x1b]*\x1b\\([^\x1b]*)\x1b\]8;;\x1b\\/g, "$1");
}
