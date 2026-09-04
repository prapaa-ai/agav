import { readFile, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { execFileSync } from "node:child_process";
import type { ContentBlock } from "../providers/types.js";
import { registerAttachment } from "./attachment-registry.js";

export type AttachmentKind = "paste" | "image" | "file";

export type AttachmentSource =
  | { type: "text"; text: string }
  | { type: "image"; base64?: string; mediaType: string; width?: number; height?: number; spoolPath?: string }
  | { type: "file"; absPath: string };

export interface Attachment {
  /** Session-unique, monotonic. Never `Date.now()` — two attachments created in
   * the same millisecond must still resolve to distinct records. */
  id: number;
  kind: AttachmentKind;
  /** Short human-readable description shown in the tile, e.g. "2k chars, 40 lines" or "800x600". */
  summary: string;
  source: AttachmentSource;
  /** What the model sees when this attachment is sent as part of a turn. */
  contentBlock: ContentBlock;
  createdAt: number;
  /** The `<<...>>` placeholder rendered in the prompt / transcript for this attachment. */
  label: string;
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

/** Allocate the next session-unique attachment id. */
export function nextAttachmentId(): number {
  return ++counter;
}

/**
 * Matches a single attachment tile placeholder: `<<Pasted #1 · ...>>`,
 * `<<Image #2 · ...>>`, or `<<File #3 · ...>>`.
 *
 * `[^>]*` stops at the first `>` rather than lazily matching past it, so a
 * filename containing `>` can never make the match run into (or past) the
 * tile's own closing `>>` — such characters are substituted at tile-build
 * time instead (see `sanitizeTileSummary`). Two adjacent tiles with no space
 * between them still match separately for the same reason.
 */
export const ATTACHMENT_TILE_RE = /<<(?:Pasted|Image|File) #(\d+) · [^>]*>>/;

/** A fresh global copy of `ATTACHMENT_TILE_RE`, for scanning every tile in a string. */
export function attachmentTileScanner(): RegExp {
  return new RegExp(ATTACHMENT_TILE_RE.source, "g");
}

/** Matches the specific tile for attachment `id`, wherever it sits in a string. */
export function attachmentTileForId(id: number): RegExp {
  return new RegExp(`<<(?:Pasted|Image|File) #${id} · [^>]*>>`);
}

/** Display-only substitution so a summary can never contain the tile's own closing delimiter. */
function sanitizeTileSummary(summary: string): string {
  return summary.replace(/>/g, "?");
}

const KIND_LABEL: Record<AttachmentKind, string> = {
  paste: "Pasted",
  image: "Image",
  file: "File",
};

function buildLabel(kind: AttachmentKind, id: number, summary: string): string {
  return `<<${KIND_LABEL[kind]} #${id} · ${sanitizeTileSummary(summary)}>>`;
}

export function createTextAttachment(text: string): Attachment {
  const id = nextAttachmentId();
  const chars = text.length;
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n").length;
  const charsStr = chars >= 1000 ? `${(chars / 1000).toFixed(0)}k` : String(chars);
  const summary = `${charsStr} chars, ${lines} lines`;

  const attachment: Attachment = {
    id,
    kind: "paste",
    summary,
    source: { type: "text", text: normalized },
    contentBlock: { type: "text", text: normalized },
    createdAt: Date.now(),
    label: buildLabel("paste", id, summary),
  };
  registerAttachment(attachment);
  return attachment;
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

    const id = nextAttachmentId();
    const dimStr = width && height ? `${width}x${height}` : "unknown size";

    const attachment: Attachment = {
      id,
      kind: "image",
      summary: dimStr,
      source: { type: "image", base64, mediaType, width: width || undefined, height: height || undefined },
      contentBlock: {
        type: "image",
        imageData: base64,
        imageMediaType: mediaType,
        imageWidth: width,
        imageHeight: height,
      },
      createdAt: Date.now(),
      label: buildLabel("image", id, dimStr),
    };
    registerAttachment(attachment);
    return attachment;
  } catch {
    return null;
  }
}

/**
 * Build an image attachment straight from already-decoded data — used for a
 * clipboard screenshot, which arrives as bytes rather than a path on disk.
 *
 * This is also the fix for the id bug in the old `handleClipboardImage`: that
 * code minted its own id via `Date.now()`, which collided with attachments
 * created in the same millisecond and was never in the shared counter, so a
 * clipboard image's tile could never be resolved back to a record.
 */
export function createImageAttachmentFromData(
  base64: string,
  mediaType: string,
  width?: number,
  height?: number,
): Attachment {
  const id = nextAttachmentId();
  const dimStr = width && height ? `${width}x${height}` : "image";

  const attachment: Attachment = {
    id,
    kind: "image",
    summary: dimStr,
    source: { type: "image", base64, mediaType, width, height },
    contentBlock: {
      type: "image",
      imageData: base64,
      imageMediaType: mediaType,
      imageWidth: width,
      imageHeight: height,
    },
    createdAt: Date.now(),
    label: buildLabel("image", id, dimStr),
  };
  registerAttachment(attachment);
  return attachment;
}

/**
 * Build a file attachment for a resolved `@mention`, so the tile shown for it
 * can be resolved back to a record and opened.
 *
 * File mentions inline their content directly into the prompt text via
 * `expandFileMentions` — the attachment here is a display/open record, not a
 * message payload, so `contentBlock` is a lightweight text marker rather than
 * a duplicate of the (potentially large) file content already sent.
 */
export function createFileAttachment(absPath: string, relPath: string): Attachment {
  const id = nextAttachmentId();

  const attachment: Attachment = {
    id,
    kind: "file",
    summary: relPath,
    source: { type: "file", absPath },
    contentBlock: { type: "text", text: absPath },
    createdAt: Date.now(),
    label: buildLabel("file", id, relPath),
  };
  registerAttachment(attachment);
  return attachment;
}

const LARGE_TEXT_THRESHOLD = 500;

export function isLargeText(text: string): boolean {
  return text.length > LARGE_TEXT_THRESHOLD || text.split("\n").length > 10;
}
