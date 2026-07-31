import { readFile, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { execFileSync } from "node:child_process";
import type { ContentBlock } from "../providers/types.js";

export interface Attachment {
  id: number;
  type: "text" | "image";
  label: string;
  contentBlock: ContentBlock;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const IMAGE_MEDIA: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

let counter = 0;

export function resetAttachmentCounter(): void {
  counter = 0;
}

export function createTextAttachment(text: string): Attachment {
  const id = ++counter;
  const chars = text.length;
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n").length;
  const charsStr = chars >= 1000 ? `${(chars / 1000).toFixed(0)}k` : String(chars);

  return {
    id,
    type: "text",
    label: `<<(${text.slice(0, 10).replace(/[\r\n]/g, " ")}...) Pasted #${id}: ${charsStr} chars and ${lines} lines>>`,
    contentBlock: { type: "text", text: normalized },
  };
}

export async function createImageAttachment(filePath: string): Promise<Attachment | null> {
  const resolved = resolve(filePath);
  const ext = extname(resolved).toLowerCase();

  if (!IMAGE_EXTS.has(ext)) return null;

  try {
    const info = await stat(resolved);
    if (info.size > 20 * 1024 * 1024) return null;

    const data = await readFile(resolved);
    const base64 = data.toString("base64");
    const mediaType = IMAGE_MEDIA[ext] ?? "image/png";

    let width = 0;
    let height = 0;
    try {
      // Try to get dimensions via `file` command
      const out = execFileSync("file", [resolved], { timeout: 3000 }).toString();
      const match = out.match(/(\d+)\s*x\s*(\d+)/);
      if (match) {
        width = parseInt(match[1]!, 10);
        height = parseInt(match[2]!, 10);
      }
    } catch {}

    const id = ++counter;
    const dimStr = width && height ? `${width}x${height}` : "unknown size";

    return {
      id,
      type: "image",
      label: `<<Image #${id}: ${dimStr}>>`,
      contentBlock: {
        type: "image",
        imageData: base64,
        imageMediaType: mediaType,
        imageWidth: width,
        imageHeight: height,
      },
    };
  } catch {
    return null;
  }
}

const LARGE_TEXT_THRESHOLD = 500;

export function isLargeText(text: string): boolean {
  return text.length > LARGE_TEXT_THRESHOLD || text.split("\n").length > 10;
}
