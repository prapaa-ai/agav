import React, { useEffect, useRef, useState } from "react";
import { Box, Text, ScrollBox, useInput, usePaste, useStdout } from "../ink/index.js";
import type { ScrollBoxControls } from "../ink/index.js";
import type { ResourceAdapter, ResourceItem } from "../resources/types.js";
import { filterResources, resourcePage } from "../resources/types.js";
import { useSearch, SearchBar } from "./agents-search.js";
import { wheelSelect, stepIndex } from "./wheel-select.js";

export interface ResourceAction {
  key: string;
  label: string;
  run(item: ResourceItem | undefined): void | string | Promise<void | string>;
}

export function ResourceManager({ adapter, onExit, actions = [], onBusyChange, height }: {
  adapter: ResourceAdapter;
  onExit(): void;
  actions?: ResourceAction[];
  onBusyChange?(busy: boolean): void;
  height?: number;
}) {
  const [items, setItems] = useState<ResourceItem[]>([]);
  const [index, setIndex] = useState(0);
  const [view, setView] = useState<"list" | "detail" | "create" | "edit" | "delete">("list");
  const [detail, setDetail] = useState<ResourceItem>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [fieldIndex, setFieldIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const [status, setStatus] = useState("");
  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout.rows || 24);
  const scroll = useRef<ScrollBoxControls | null>(null);
  const [scrollOffset, setScrollOffset] = useState(Number.POSITIVE_INFINITY);
  const { searchQuery, searching, handleSearchKey, handleSearchPaste } = useSearch();
  const availableRows = height ?? Math.max(8, rows - 2);
  const pageSize = Math.max(1, Math.floor((availableRows - 8) / 2));
  const filtered = filterResources(items, searchQuery);
  const { selected, page, pages } = resourcePage(index, filtered.length, pageSize);
  const item = filtered[selected];
  const fields = adapter.fields ?? [];
  const field = fields[fieldIndex];
  const form = view === "create" || view === "edit";
  const canRemove = Boolean(adapter.remove && item && item.removable !== false);
  const canToggle = Boolean(adapter.setEnabled && item?.enabled !== undefined);

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
    if (busyRef.current) return;
    if (view === "delete") {
      if (key.escape || input.toLowerCase() === "n") { setView("list"); return; }
      if (input.toLowerCase() === "y" && detail && adapter.remove) void run(async () => {
        await adapter.remove!(detail.id);
        await reload();
        setView("list");
        setStatus("Deleted.");
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
    else if (input === "d" && canRemove) { setDetail(item); setView("delete"); }
    else if (input === "n" && adapter.create) { setValues({}); setFieldIndex(0); setView("create"); setStatus(""); }
    else if (input === "e" && adapter.update && item) { setDetail(item); setValues(item.values ?? {}); setFieldIndex(0); setView("edit"); setStatus(""); }
    else {
      const action = actions.find((a) => a.key === input || (a.key === "Tab" && key.tab));
      if (action) void run(async () => {
        const result = await action.run(item);
        if (typeof result === "string" && mounted.current) {
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
    <Box flexGrow={1} flexShrink={1} flexDirection="column">
      <ScrollBox key={view} height={Math.max(2, availableRows - 7)} controls={scroll} scrollOffset={scrollOffset} onScrollChange={(offset) => {
        // A fresh viewport first measures zero rows. Keep the top sentinel until
        // its content is measured instead of pinning the new detail to the bottom.
        if (Number.isFinite(scrollOffset) || offset > 0) setScrollOffset(offset);
      }}>
        {view === "list" && (filtered.length ? filtered.slice(page * pageSize, (page + 1) * pageSize).map((entry, i) => <Box key={entry.id} flexDirection="column">
          <Text color={page * pageSize + i === selected ? "cyan" : undefined}>{page * pageSize + i === selected ? "→ " : "  "}{entry.title}{entry.enabled === undefined ? "" : entry.enabled ? " [enabled]" : " [disabled]"}</Text>
          <Text dimColor>  {entry.description.replace(/\s+/g, " ").slice(0, Math.max(20, (stdout.columns || 80) - 6))}</Text>
        </Box>) : <Text dimColor>No resources found.</Text>)}
        {view === "detail" && <Text>{detail?.detail}</Text>}
        {view === "delete" && <Text color="yellow">Delete "{detail?.title}"? This cannot be undone. y: Confirm · n/ESC: Cancel</Text>}
        {form && fields.map((f, i) => <Box key={f.name} flexDirection="column">
          <Text color={i === fieldIndex ? "cyan" : undefined}>{i === fieldIndex ? "→ " : "  "}{f.label}{f.options ? ` (${f.options.join(" / ")})` : ""}: {values[f.name] ?? ""}{i === fieldIndex ? "█" : ""}</Text>
        </Box>)}
      </ScrollBox>
    </Box>
    {busy && <Text color="yellow">Working…</Text>}
    {status && <Text color="yellow">{status}</Text>}
    {view === "list" && <Text dimColor>Page {page + 1}/{pages}{adapter.notice ? ` · ${adapter.notice}` : ""}</Text>}
    <Text dimColor>{form ? "Tab/↑↓: Field | ENTER: Save | ESC: Cancel" : view === "detail" ? "↑↓: Scroll | b/ESC: Back" : view === "delete" ? "y: Delete | n/ESC: Cancel" : [
      "↑↓: Navigate", "←→: Page", "ENTER/i: Inspect", "s: Search", "r: Refresh",
      adapter.create && "n: Create", adapter.update && item && "e: Edit", canToggle && "t: Toggle", canRemove && "d: Delete",
      ...actions.map((a) => `${a.key}: ${a.label}`), "ESC: Exit/clear",
    ].filter(Boolean).join(" | ")}</Text>
  </Box>;
}
