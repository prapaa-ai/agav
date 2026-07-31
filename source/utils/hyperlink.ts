import { pathToFileURL } from "node:url";

export function terminalLink(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export function fileLink(text: string, filePath: string): string {
  return terminalLink(text, pathToFileURL(filePath).href);
}

export function stripTerminalLinks(text: string): string {
  return text.replace(/\x1b\]8;;[^\x1b]*\x1b\\([^\x1b]*)\x1b\]8;;\x1b\\/g, "$1");
}
