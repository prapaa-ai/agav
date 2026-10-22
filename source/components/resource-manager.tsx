import React, { useEffect, useRef, useState } from "react";
import { Box, Text, ScrollBox, useInput, usePaste, useStdout, measureElement } from "../ink/index.js";
import type { DOMElement, ScrollBoxControls } from "../ink/index.js";
import { subscribeClipboardCopy } from "../ink/termio/clipboard.js";
import type { ClipboardNotice } from "../ink/termio/clipboard.js";
import type { ResourceAdapter, ResourceItem } from "../resources/types.js";
import { filterResources, resourcePage } from "../resources/types.js";
import { useSearch, SearchBar } from "./agents-search.js";
import { wheelSelect, stepIndex } from "./wheel-select.js";

/** Returned by an action to open its own read-only view (e.g. a report) in the detail pane. */
export interface ResourceActionView {
  detail: string;
}

export interface ResourceAction {
  key: string;
  label: string;
  /** Hidden and ignored for items it returns false for (items are never passed when none is selected). */
  when?(item: ResourceItem): boolean;
  /** Also available from the detail view, acting on the inspected item. */
  inDetail?: boolean;
  /** Ask y/n with this text before running (for permanent operations). */
  confirm?: string;
  run(item: ResourceItem | undefined): void | string | ResourceActionView | Promise<void | string | ResourceActionView>;
}

export function ResourceManager({ adapter, onExit, actions = [], onBusyChange, height, prompt, promptDetails }: {
  adapter: ResourceAdapter;
  onExit(): void;
  actions?: ResourceAction[];
  onBusyChange?(busy: boolean): void;
  height?: number;
  /** Shown in place of "Working…" while a running action awaits a decision from the parent. */
  prompt?: string;
  /** Full terms for `prompt`; they scroll above the always-visible `controls` line, which replaces `prompt`. */
  promptDetails?: { lines: string[]; controls: string };
}) {
  const [items, setItems] = useState<ResourceItem[]>([]);
  const [index, setIndex] = useState(0);
  const [view, setView] = useState<"list" | "detail" | "create" | "edit" | "delete">("list");
  const [detail, setDetail] = useState<ResourceItem>();
  // What the y/n "delete" view will run; set by `d` or by an action that declares `confirm`.
  const [pendingConfirm, setPendingConfirm] = useState<{ label: string; text: string; run(): Promise<void | string>; doneLabel: string }>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [fieldIndex, setFieldIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const [status, setStatus] = useState("");
  const [copyNotice, setCopyNotice] = useState<ClipboardNotice | null>(null);
  const copyNoticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout.rows || 24);
  const scroll = useRef<ScrollBoxControls | null>(null);
  const [scrollOffset, setScrollOffset] = useState(Number.POSITIVE_INFINITY);
  const promptScroll = useRef<ScrollBoxControls | null>(null);
  const [promptOffset, setPromptOffset] = useState(Number.POSITIVE_INFINITY);
  const { searchQuery, searching, handleSearchKey, handleSearchPaste } = useSearch();
  const availableRows = height ?? Math.max(8, rows - 2);
  // Measure the actual slot Yoga allocates for the scrollable content instead of
  // subtracting a guessed header/footer. This keeps the viewport sensible when
  // prompts or notices add rows below the list/detail view.
  const scrollSlotRef = useRef<DOMElement | null>(null);
  const [scrollHeight, setScrollHeight] = useState(Math.max(2, availableRows - 8));
  const pageSize = Math.max(1, Math.floor(Math.max(0, scrollHeight - 1) / 2));
  const filtered = filterResources(items, searchQuery);
  const { selected, page, pages } = resourcePage(index, filtered.length, pageSize);
  const item = filtered[selected];
  const fields = adapter.fields ?? [];
  const field = fields[fieldIndex];
  const form = view === "create" || view === "edit";
  const canRemove = Boolean(adapter.remove && item && item.removable !== false);
  const removeLabel = adapter.removeLabel ?? "Delete";
  const actionApplies = (a: ResourceAction, target: ResourceItem | undefined) => !a.when || (target !== undefined && a.when(target));
  const detailTarget = detail && detail.id ? detail : undefined;
  const detailCanRemove = Boolean(adapter.remove && detailTarget && detailTarget.removable !== false);
  const detailActions = actions.filter((a) => a.inDetail && actionApplies(a, detailTarget));
  const removeConfirmation = (target: ResourceItem) => ({
    label: removeLabel,
    text: adapter.removeConfirm ?? "This cannot be undone.",
    run: () => adapter.remove!(target.id),
    doneLabel: `${adapter.removedLabel ?? "Deleted"}.`,
  });
  const actionConfirmation = (action: ResourceAction, target: ResourceItem) => ({
    label: action.label,
    text: action.confirm!,
    // Confirmed actions are operations; a returned report view is not shown from the confirm step.
    run: async () => {
      const result = await action.run(target);
      return typeof result === "string" ? result : undefined;
    },
    doneLabel: `${action.label} done.`,
  });
  const canToggle = Boolean(adapter.setEnabled && item?.enabled !== undefined);
  // Capped viewport keeps the controls line on screen.
  const detailLines = prompt && promptDetails ? promptDetails.lines : undefined;
  const promptContentRows = detailLines
    ? detailLines.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / Math.max(1, (stdout.columns || 80)))), 0)
    : 0;
  // Split remaining height between detail scroll (above) and controls line (below).
  const promptRows = detailLines ? Math.min(promptContentRows, Math.max(3, Math.floor((availableRows - 7) / 2))) : 0;
  const promptOverflows = promptContentRows > promptRows;
  const promptExtraRows = promptRows + (promptOverflows ? 1 : 0);
  const columns = Math.max(1, stdout.columns || 80);
  const detailContentRows = view === "detail" && detail?.detail
    ? detail.detail.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / columns)), 0)
    : 1;
  useEffect(() => {
    const availableContent = Math.max(2, availableRows - 7 - promptExtraRows - (copyNotice ? 1 : 0));
    const measuredHeight = measureElement(scrollSlotRef.current).height;
    const nextHeight = view === "detail"
      ? Math.max(2, Math.min(detailContentRows, availableContent))
      : Math.max(2, measuredHeight || availableContent);
    setScrollHeight((current) => current === nextHeight ? current : nextHeight);
  }, [availableRows, promptExtraRows, copyNotice, view, detailContentRows, columns, busy, status, searching, items.length]);
  useEffect(() => { setPromptOffset(Number.POSITIVE_INFINITY); }, [prompt]);

  const reload = async () => {
    const loaded = await adapter.list();
    if (mounted.current) { setItems(loaded); setIndex((i) => Math.min(i, Math.max(0, loaded.length - 1))); }
  };
  const run = async (operation: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setStatus("");
    try { await operation(); }
    catch (error) { if (mounted.current) setStatus(error instanceof Error ? error.message : String(error)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  useEffect(() => {
    mounted.current = true;
    void run(reload);
    return () => { mounted.current = false; };
  }, [adapter]);
  useEffect(() => {
    const unsubscribe = subscribeClipboardCopy((notice) => {
      setCopyNotice(notice);
      if (copyNoticeTimer.current) clearTimeout(copyNoticeTimer.current);
      copyNoticeTimer.current = setTimeout(() => setCopyNotice(null), 2000);
    });
    return () => {
      unsubscribe();
      if (copyNoticeTimer.current) clearTimeout(copyNoticeTimer.current);
    };
  }, []);
  useEffect(() => {
    const resize = () => setRows(stdout.rows || 24);
    stdout.on("resize", resize);
    return () => { stdout.off("resize", resize); };
  }, [stdout]);
  useEffect(() => {
    onBusyChange?.(busy || searching || view !== "list");
    return () => onBusyChange?.(false);
  }, [busy, searching, view, onBusyChange]);

  const append = (text: string) => {
    if (field) setValues((v) => ({ ...v, [field.name]: (v[field.name] ?? "") + text }));
  };
  usePaste((text) => {
    if (busyRef.current) return;
    if (form) append(text);
    else if (view === "list" && handleSearchPaste(text)) setIndex(0);
  });
  useInput((input, key) => {
    if (detailLines && busyRef.current) {
      if (key.upArrow) promptScroll.current?.scrollBy(1);
      else if (key.downArrow) promptScroll.current?.scrollBy(-1);
      return;
    }
    if (busyRef.current) return;
    if (view === "delete") {
      if (key.escape || input.toLowerCase() === "n") { setView("list"); return; }
      if (input.toLowerCase() === "y" && pendingConfirm) void run(async () => {
        const result = await pendingConfirm.run();
        await reload();
        setView("list");
        setStatus(typeof result === "string" ? result : pendingConfirm.doneLabel);
      });
      return;
    }
    if (form) {
      if (key.escape) { setView("list"); setStatus(""); return; }
      if (key.tab || key.downArrow) { setFieldIndex((i) => (i + 1) % fields.length); return; }
      if (key.upArrow) { setFieldIndex((i) => (i + fields.length - 1) % fields.length); return; }
      if (key.return) {
        void run(async () => {
          for (const f of fields) {
            if (f.required && !values[f.name]?.trim()) throw new Error(`${f.label} is required.`);
            if (f.options && !f.options.includes(values[f.name]!)) throw new Error(`${f.label}: choose ${f.options.join(", ")}.`);
          }
          const result = view === "create" ? await adapter.create!(values) : await adapter.update!(detail!.id, values);
          await reload();
          setView("list");
          setStatus(typeof result === "string" ? result : `Saved. ${adapter.notice ?? ""}`);
        });
      } else if ((key.backspace || key.delete) && field) setValues((v) => ({ ...v, [field.name]: (v[field.name] ?? "").slice(0, -1) }));
      else if (input && !key.ctrl && !key.meta) append(input);
      return;
    }
    if (view === "detail") {
      if (key.escape || input === "b") { setScrollOffset(Number.POSITIVE_INFINITY); setView("list"); }
      else if (key.upArrow) scroll.current?.scrollBy(1);
      else if (key.downArrow) scroll.current?.scrollBy(-1);
      else if (input === "d" && detailCanRemove && detailTarget) { setPendingConfirm(removeConfirmation(detailTarget)); setView("delete"); }
      else {
        const action = detailActions.find((a) => a.key === input);
        if (action && detailTarget && action.confirm) { setPendingConfirm(actionConfirmation(action, detailTarget)); setView("delete"); }
        else if (action && detailTarget) void run(async () => {
          const result = await action.run(detailTarget);
          if (typeof result === "string" && mounted.current) {
            await reload();
            setView("list");
            setStatus(result);
          }
        });
      }
      return;
    }
    if (handleSearchKey(input, key)) { setIndex(0); return; }
    if (key.escape) { onExit(); return; }
    if (key.upArrow) setIndex(Math.max(0, selected - 1));
    else if (key.downArrow) setIndex(Math.min(Math.max(0, filtered.length - 1), selected + 1));
    else if (key.leftArrow) setIndex(Math.max(0, (page - 1) * pageSize));
    else if (key.rightArrow) setIndex(Math.min(Math.max(0, filtered.length - 1), (page + 1) * pageSize));
    else if ((key.return || input === "i") && item) void run(async () => {
      const loaded = await adapter.get(item.id);
      if (!loaded) { await reload(); throw new Error("Resource no longer exists."); }
      setDetail(loaded); setScrollOffset(Number.POSITIVE_INFINITY); setView("detail");
    });
    else if (input === "r") void run(reload);
    else if (input === "t" && canToggle) void run(async () => {
      await adapter.setEnabled!(item!.id, !item!.enabled); await reload(); setStatus(adapter.notice ?? "Updated.");
    });
    else if (input === "d" && canRemove && item) { setDetail(item); setPendingConfirm(removeConfirmation(item)); setView("delete"); }
    else if (input === "n" && adapter.create) { setValues({}); setFieldIndex(0); setView("create"); setStatus(""); }
    else if (input === "e" && adapter.update && item) { setDetail(item); setValues(item.values ?? {}); setFieldIndex(0); setView("edit"); setStatus(""); }
    else {
      const action = actions.find((a) => (a.key === input || (a.key === "Tab" && key.tab)) && actionApplies(a, item));
      if (action && action.confirm && item) { setDetail(item); setPendingConfirm(actionConfirmation(action, item)); setView("delete"); }
      else if (action) void run(async () => {
        const result = await action.run(item);
        if (result && typeof result === "object" && mounted.current) {
          // A report, not the item itself: never offer delete/stop on it.
          setDetail({ ...(item ?? { id: "", title: "", description: "" }), detail: result.detail, removable: false, stoppable: false });
          setScrollOffset(Number.POSITIVE_INFINITY);
          setView("detail");
        } else if (typeof result === "string" && mounted.current) {
          await reload();
          setStatus(result);
        }
      });
    }
  });

  return <Box flexDirection="column" height={availableRows} onWheel={wheelSelect((delta) => {
    if (!busyRef.current && view === "list" && !searching) setIndex((i) => stepIndex(i, delta, filtered.length));
  })}>
    <Text bold color="cyan">{adapter.title} · {view === "list" ? "List" : view === "detail" ? "Inspect" : view}</Text>
    {view === "list" && <SearchBar query={searchQuery} searching={searching} resultCount={filtered.length} itemLabel="resource" />}
    <Box ref={scrollSlotRef} flexGrow={view === "detail" ? 0 : 1} flexShrink={1} flexDirection="column">
      <ScrollBox key={view} height={Math.max(2, Math.min(scrollHeight, view === "detail" ? detailContentRows : scrollHeight))} controls={scroll} scrollOffset={scrollOffset} onScrollChange={(offset) => {
        // A fresh viewport first measures zero rows. Keep the top sentinel until
        // its content is measured instead of pinning the new detail to the bottom.
        if (Number.isFinite(scrollOffset) || offset > 0) setScrollOffset(offset);
      }}>
        {view === "list" && (filtered.length ? filtered.slice(page * pageSize, (page + 1) * pageSize).map((entry, i) => <Box key={entry.id} flexDirection="column">
          <Text color={page * pageSize + i === selected ? "cyan" : undefined}>{page * pageSize + i === selected ? "→ " : "  "}{entry.title}{entry.enabled === undefined ? "" : entry.enabled ? " [enabled]" : " [disabled]"}</Text>
          <Text dimColor>  {entry.description.replace(/\s+/g, " ").slice(0, Math.max(20, (stdout.columns || 80) - 6))}</Text>
        </Box>) : <Text dimColor>No resources found.</Text>)}
        {view === "detail" && <Text>{detail?.detail}</Text>}
        {view === "delete" && <Text color="yellow">{pendingConfirm?.label} "{detail?.title}"? {pendingConfirm?.text} y: Confirm · n/ESC: Cancel</Text>}
        {form && fields.map((f, i) => <Box key={f.name} flexDirection="column">
          <Text color={i === fieldIndex ? "cyan" : undefined}>{i === fieldIndex ? "→ " : "  "}{f.label}{f.options ? ` (${f.options.join(" / ")})` : ""}: {values[f.name] ?? ""}{i === fieldIndex ? "█" : ""}</Text>
        </Box>)}
      </ScrollBox>
    </Box>
    {detailLines && <ScrollBox height={Math.max(0, Math.min(promptRows, scrollHeight - 2))} controls={promptScroll} scrollOffset={promptOffset} onScrollChange={(offset) => {
      if (Number.isFinite(promptOffset) || offset > 0) setPromptOffset(offset);
    }}>
      {detailLines.map((line, i) => <Text key={i} color="yellow">{line}</Text>)}
    </ScrollBox>}
    {detailLines && promptOverflows && <Text dimColor>↑↓: Scroll details</Text>}
    {prompt ? <Text color="yellow" wrap={detailLines ? "wrap" : "truncate-end"}>{detailLines ? promptDetails!.controls : prompt}</Text> : busy && <Text color="yellow">Working…</Text>}
    {status && <Text color="yellow">{status}</Text>}
    {view === "list" && <Text dimColor>Page {page + 1}/{pages}{adapter.notice ? ` · ${adapter.notice}` : ""}</Text>}
    {copyNotice && <Text color={copyNotice === "Copied to clipboard" ? "green" : "cyan"}>{copyNotice === "Copied to clipboard" ? "✓ " : ""}{copyNotice}</Text>}
    <Text dimColor>{form ? "Tab/↑↓: Field | ENTER: Save | ESC: Cancel" : view === "detail" ? [
      "↑↓: Scroll", "b/ESC: Back", detailCanRemove && `d: ${removeLabel}`,
      ...detailActions.map((a) => `${a.key}: ${a.label}`),
    ].filter(Boolean).join(" | ") : view === "delete" ? `y: ${pendingConfirm?.label ?? removeLabel} | n/ESC: Cancel` : [
      "↑↓: Navigate", "←→: Page", `ENTER/i: ${adapter.inspectLabel ?? "Inspect"}`, "s: Search", "r: Refresh",
      adapter.create && "n: Create", adapter.update && item && "e: Edit", canToggle && "t: Enable/disable", canRemove && `d: ${removeLabel}`,
      ...actions.filter((a) => actionApplies(a, item)).map((a) => `${a.key}: ${a.label}`), "ESC: Exit/clear",
    ].filter(Boolean).join(" | ")}</Text>
  </Box>;
}
