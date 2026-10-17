/**
 * Status bar (footer) customization model.
 *
 * The footer is composed of a fixed set of named segments. Users choose which
 * segments appear and in what order via `/customize`; the result is persisted as
 * `statusBar` in config.json. This module is the single source of truth for the
 * available segments, their labels, and the default layout, so the renderer and
 * the customization UI never drift apart.
 *
 * Designed to tolerate schema evolution: a saved layout is always reconciled
 * against the current catalog, so newly added segments appear (disabled, in
 * their default position) and removed segments are dropped — a stored layout
 * from an older or newer build can never corrupt the footer.
 */

/** Stable identifiers for the customizable footer segments. */
export type StatusBarItemId =
  | "model"
  | "effort"
  | "messages"
  | "usage"
  | "duration"
  | "sandbox"
  | "session"
  | "hint";

/**
 * Segments rendered inline on the first footer line, joined by " · ". The hint
 * is excluded: it is a full line of its own, so the layout controls only its
 * visibility, not its position among the inline segments.
 */
export const INLINE_STATUS_BAR_ITEMS: readonly StatusBarItemId[] = [
  "model", "effort", "messages", "usage", "duration", "sandbox", "session",
];

/** One segment's on/off state within an ordered layout. */
export interface StatusBarItem {
  id: StatusBarItemId;
  enabled: boolean;
}

export type StatusBarLayout = StatusBarItem[];

/** Human-facing metadata for a footer segment, shown in the customization UI. */
export interface StatusBarItemMeta {
  id: StatusBarItemId;
  /** Short label shown in the customization list. */
  label: string;
  /** One-line description of what the segment shows. */
  description: string;
}

/**
 * The canonical catalog in default display order. The order here also defines
 * the default layout and the position new/unknown saved items fall back to.
 */
export const STATUS_BAR_ITEMS: readonly StatusBarItemMeta[] = [
  { id: "model", label: "Model", description: "Provider and model (e.g. anthropic/claude-…)" },
  { id: "effort", label: "Reasoning effort", description: "Current reasoning effort level" },
  { id: "messages", label: "Message count", description: "Number of user messages this session" },
  { id: "usage", label: "Token usage", description: "Input/output/cache token counters" },
  { id: "duration", label: "Turn duration", description: "Elapsed or last turn time" },
  { id: "sandbox", label: "Sandbox", description: "Active sandbox backend" },
  { id: "session", label: "Session", description: "Session name or id" },
  { id: "hint", label: "Tips", description: "Rotating 💡 tip line below the status" },
];

const ITEM_IDS: readonly StatusBarItemId[] = STATUS_BAR_ITEMS.map((item) => item.id);
const ITEM_ID_SET = new Set<string>(ITEM_IDS);

/** The default footer layout: every segment enabled, in catalog order. This
 * reproduces the footer's historical appearance when no customization exists. */
export function defaultStatusBarLayout(): StatusBarLayout {
  return STATUS_BAR_ITEMS.map((item) => ({ id: item.id, enabled: true }));
}

/** Look up a segment's display metadata. */
export function statusBarItemMeta(id: StatusBarItemId): StatusBarItemMeta {
  // ITEM_IDS is exhaustive, so this find never fails for a valid id.
  return STATUS_BAR_ITEMS.find((item) => item.id === id)!;
}

function isItemId(value: unknown): value is StatusBarItemId {
  return typeof value === "string" && ITEM_ID_SET.has(value);
}

/**
 * Reconcile a possibly-partial or stale saved layout against the current
 * catalog:
 *
 * - Keep recognized items in their saved order, de-duplicated (first wins).
 * - Drop unknown/removed ids and malformed entries.
 * - Append any catalog items the saved layout never mentioned, in catalog
 *   order, enabled by default so a newly shipped segment is visible.
 *
 * Returns a fresh default layout for anything that isn't a usable array, so a
 * corrupt config value can never wedge the footer.
 */
export function normalizeStatusBarLayout(raw: unknown): StatusBarLayout {
  if (!Array.isArray(raw)) return defaultStatusBarLayout();

  const result: StatusBarLayout = [];
  const seen = new Set<StatusBarItemId>();

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, enabled } = entry as Record<string, unknown>;
    if (!isItemId(id) || seen.has(id)) continue;
    result.push({ id, enabled: enabled !== false });
    seen.add(id);
  }

  // A layout that recognized nothing is treated as absent.
  if (result.length === 0) return defaultStatusBarLayout();

  // Surface any catalog segment the saved layout predates.
  for (const id of ITEM_IDS) {
    if (!seen.has(id)) result.push({ id, enabled: true });
  }

  return result;
}

/** The ordered ids of the enabled segments, ready for the renderer. */
export function enabledStatusBarItems(layout: StatusBarLayout): StatusBarItemId[] {
  return layout.filter((item) => item.enabled).map((item) => item.id);
}

/**
 * Whether a specific segment is enabled in a layout. Used for line-level
 * segments (the hint line) that are gated by visibility rather than rendered
 * inline. Unknown ids default to enabled so a missing entry never hides a
 * segment that should show.
 */
export function isStatusBarItemEnabled(layout: StatusBarLayout, id: StatusBarItemId): boolean {
  const normalized = normalizeStatusBarLayout(layout);
  const item = normalized.find((entry) => entry.id === id);
  return item ? item.enabled : true;
}

/** True when a layout matches the default (same order, all enabled). */
export function isDefaultStatusBarLayout(layout: StatusBarLayout): boolean {
  if (layout.length !== ITEM_IDS.length) return false;
  return layout.every((item, index) => item.id === ITEM_IDS[index] && item.enabled);
}
