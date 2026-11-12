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

/**
 * One complete OSC 8 control sequence, `ESC ] 8 ; params ; URI ST`, with ST as
 * `ESC \` or BEL. This matches openers and empty-URI resets alike, so each is
 * removed on its own and the text between them is never scanned for a partner.
 * Neither field can contain ESC or BEL, so every attempt stops at the next one
 * and the scan stays linear; an incomplete control is left as-is.
 */
const OSC8_CONTROL = /\x1b\]8;[^;\x1b\x07]*;[^\x1b\x07]*(?:\x1b\\|\x07)/g;

export function stripTerminalLinks(text: string): string {
  return text.replace(OSC8_CONTROL, "");
}
