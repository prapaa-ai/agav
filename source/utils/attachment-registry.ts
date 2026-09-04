import type { Attachment } from "./attachments.js";
import { spoolImageToTempFile, cleanupSpooledImage, cleanupSpooledImages } from "./open-external.js";

/**
 * Session-scoped store of every attachment created this session, keyed by id.
 *
 * Unlike the pending-attachment list in `app.tsx` (which `submit` clears once
 * a turn is sent), this registry is never cleared on submit — a tile stays
 * clickable in the scrolled-back transcript long after the turn that created
 * it finished. It is cleared only when the whole session resets (`/clear`,
 * `/new`).
 */
const registry = new Map<number, Attachment>();

/** Insertion order, oldest first — used to evict the oldest record once the cap is hit. */
const insertionOrder: number[] = [];

/** Hard cap on how many attachment records the registry retains at once. */
const MAX_RECORDS = 200;

/** Ids evicted to make room, so a stale tile can report why it can't be opened. */
const evicted = new Set<number>();

/** Register a newly-created attachment, evicting the oldest record if the cap is exceeded. */
export function registerAttachment(attachment: Attachment): void {
  const existing = registry.get(attachment.id);
  const existingIndex = insertionOrder.indexOf(attachment.id);
  if (existingIndex !== -1) insertionOrder.splice(existingIndex, 1);
  registry.set(attachment.id, attachment);
  if (existing?.source.type === "image" && existing.source.spoolPath && existing !== attachment) {
    cleanupSpooledImage(existing.source.spoolPath).catch(() => {});
  }
  insertionOrder.push(attachment.id);
  evicted.delete(attachment.id);

  while (insertionOrder.length > MAX_RECORDS) {
    const oldestId = insertionOrder.shift();
    if (oldestId === undefined) break;
    // Never evict a record still in the process of being resolved by the id
    // we just inserted — this can't happen since attachment ids are
    // monotonic, but guard anyway for safety.
    if (oldestId === attachment.id) continue;
    const evictedAttachment = registry.get(oldestId);
    registry.delete(oldestId);
    evicted.add(oldestId);
    if (evictedAttachment?.source.type === "image" && evictedAttachment.source.spoolPath) {
      cleanupSpooledImage(evictedAttachment.source.spoolPath).catch(() => {});
    }
  }
}

/** Look up an attachment by id. Returns `undefined` if it was never registered or has been evicted. */
export function getAttachment(id: number): Attachment | undefined {
  return registry.get(id);
}

/**
 * Remove an attachment that never made it into a sent turn — e.g. a pasted
 * block whose tile was expanded back into literal text before being
 * submitted. Distinct from eviction: this id is simply forgotten, not marked
 * `wasEvicted`, since nothing was lost — there is no tile left anywhere
 * referring to it.
 */
export function unregisterAttachment(id: number): void {
  const attachment = registry.get(id);
  registry.delete(id);
  const index = insertionOrder.indexOf(id);
  if (index !== -1) insertionOrder.splice(index, 1);
  if (attachment?.source.type === "image" && attachment.source.spoolPath) {
    cleanupSpooledImage(attachment.source.spoolPath).catch(() => {});
  }
}

/** Whether `id` once existed in this session but was evicted to make room for newer attachments. */
export function wasEvicted(id: number): boolean {
  return evicted.has(id);
}

/** Drop every registered attachment. Used when the session itself resets. */
export function clearAttachmentRegistry(): void {
  registry.clear();
  insertionOrder.length = 0;
  evicted.clear();
  cleanupSpooledImages().catch(() => {});
}

/** All attachments currently registered, oldest first — used by `/open` to list targets. */
export function listAttachments(): Attachment[] {
  return insertionOrder.map((id) => registry.get(id)).filter((a): a is Attachment => a !== undefined);
}

/**
 * Spool an image attachment's bytes to a temp file and drop the base64 copy
 * from memory, keeping only the path needed to open or preview it later.
 *
 * Called once a turn is submitted — the base64 payload has already gone to
 * the provider by then, so retaining it in the registry only costs memory
 * for the rest of the session.
 */
export async function compactImageAttachment(id: number): Promise<void> {
  const attachment = registry.get(id);
  if (!attachment || attachment.kind !== "image" || attachment.source.type !== "image") return;
  if (attachment.source.spoolPath || !attachment.source.base64) return;

  try {
    const spoolPath = await spoolImageToTempFile(attachment.source.base64, attachment.source.mediaType);
    // The record may have been cleared, evicted, or replaced while the image
    // was being written. Do not retain an orphaned temp file in that case.
    if (registry.get(id) !== attachment) {
      await cleanupSpooledImage(spoolPath);
      return;
    }
    attachment.source = { ...attachment.source, base64: undefined, spoolPath };
    // `app.tsx` clones blocks into the submitted conversation, so this is only
    // the registry's duplicate payload and can be released after spooling.
    attachment.contentBlock.imageData = undefined;
  } catch {
    // Leave the base64 in place if spooling fails — still resolvable, just
    // not compacted.
  }
}

/** Compact every currently-pending image attachment once a turn has been submitted. */
export async function compactImageAttachments(ids: number[]): Promise<void> {
  await Promise.all(ids.map(compactImageAttachment));
}
