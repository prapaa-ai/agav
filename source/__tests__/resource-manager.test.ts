import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import { ResourceManager } from "../components/resource-manager.js";
import type { ResourceAdapter, ResourceItem } from "../resources/types.js";
import { filterResources, resourcePage } from "../resources/types.js";

async function mount(overrides: Partial<ResourceAdapter> = {}) {
  let items: ResourceItem[] = Array.from({ length: 12 }, (_, i) => ({ id: String(i), title: `Item ${i}`, description: `Description ${i}`, detail: `Full detail ${i}`, enabled: true, removable: true }));
  const adapter: ResourceAdapter = {
    title: "Test resources",
    list: vi.fn(async () => items),
    get: vi.fn(async (id) => items.find((i) => i.id === id)),
    remove: vi.fn(async (id) => { items = items.filter((i) => i.id !== id); }),
    setEnabled: vi.fn(async () => {}),
    ...overrides,
  };
  const onExit = vi.fn();
  let output = "";
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: 120, rows: 24, write: (text: string) => { output += text; return true; } });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  const instance = render(h(ResourceManager, { adapter, onExit }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  const settle = async () => { await new Promise((r) => setTimeout(r, 50)); await instance.waitUntilRenderFlush(); };
  const key = async (text: string) => { output = ""; stdin.emit("data", Buffer.from(text)); await settle(); };
  await settle();
  return { instance, key, settle, adapter, onExit, output: () => output };
}

describe("shared resource manager", () => {
  it("searches incrementally, clears search before exiting, and pages consistently", async () => {
    const ui = await mount();
    try {
      expect(ui.output()).toContain("Page 1/2");
      await ui.key("\x1b[C");
      expect(ui.output()).toContain("Page 2/2");
      await ui.key("s");
      await ui.key("Item 11");
      expect(ui.output()).toContain("Search: Item 11");
      expect(ui.output()).toContain("Page 1/1");
      await ui.key("\r");
      await ui.key("\x1b");
      expect(ui.onExit).not.toHaveBeenCalled();
      await ui.key("\x1b");
      expect(ui.onExit).toHaveBeenCalledOnce();
    } finally { ui.instance.unmount(); }
  });

  it("appends bracketed paste to search, resets the page, and clears before exiting", async () => {
    const ui = await mount();
    try {
      await ui.key("\x1b[C");
      await ui.key("s");
      await ui.key("Item ");
      await ui.key("\x1b[200~11\x1b[201~");
      expect(ui.output()).toContain("Search: Item 11");
      expect(ui.output()).toContain("Page 1/1");
      await ui.key("\r");
      expect(ui.output()).toContain('matching "Item 11"');
      await ui.key("\x1b");
      expect(ui.onExit).not.toHaveBeenCalled();
      expect(ui.output()).toContain("Page 1/2");
      await ui.key("\x1b");
      expect(ui.onExit).toHaveBeenCalledOnce();
    } finally { ui.instance.unmount(); }
  });

  it("opens long details at the header and resets the viewport on every inspection", async () => {
    const entry = { id: "long", title: "Long", description: "desc", detail: ["DETAIL HEADER", ...Array.from({ length: 40 }, (_, i) => `Detail row ${i}`), "DETAIL END"].join("\n") };
    const ui = await mount({ list: vi.fn(async () => [entry]), get: vi.fn(async () => entry) });
    const frame = () => ui.output().replaceAll(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").split("Test resources · Inspect").at(-1) ?? "";
    try {
      await ui.key("\r");
      expect(frame()).toContain("DETAIL HEADER");
      expect(frame()).not.toContain("DETAIL END");
      await ui.key("\x1b[B");
      expect(frame()).not.toContain("DETAIL HEADER");
      expect(frame()).toContain("Detail row 0");
      await ui.key("\x1b[A");
      expect(frame()).toContain("DETAIL HEADER");
      await ui.key("\x1b[B");
      await ui.key("\x1b");
      await ui.key("\r");
      expect(frame()).toContain("DETAIL HEADER");
      expect(frame()).not.toContain("DETAIL END");
    } finally { ui.instance.unmount(); }
  });

  it("preserves bracketed paste in forms", async () => {
    const create = vi.fn(async () => {});
    const ui = await mount({ fields: [{ name: "name", label: "Name", required: true }], create });
    try {
      await ui.key("n");
      await ui.key("\x1b[200~pasted name\x1b[201~");
      await ui.key("\r");
      expect(create).toHaveBeenCalledWith({ name: "pasted name" });
    } finally { ui.instance.unmount(); }
  });

  it("inspects with Enter, backs out with ESC, and toggles explicitly", async () => {
    const ui = await mount();
    try {
      expect(ui.output()).toContain("t: Enable/disable");
      await ui.key("\r");
      expect(ui.adapter.get).toHaveBeenCalledWith("0");
      expect(ui.output()).toContain("Full detail 0");
      await ui.key("\x1b");
      expect(ui.onExit).not.toHaveBeenCalled();
      await ui.key("t");
      expect(ui.adapter.setEnabled).toHaveBeenCalledWith("0", false);
    } finally { ui.instance.unmount(); }
  });

  it("never deletes before confirmation and allows cancellation", async () => {
    const ui = await mount();
    try {
      await ui.key("d");
      expect(ui.output()).toContain('Delete "Item 0"?');
      expect(ui.adapter.remove).not.toHaveBeenCalled();
      await ui.key("\x1b");
      expect(ui.adapter.remove).not.toHaveBeenCalled();
      await ui.key("d");
      await ui.key("y");
      expect(ui.adapter.remove).toHaveBeenCalledWith("0");
      expect(ui.output()).toContain("Deleted.");
    } finally { ui.instance.unmount(); }
  });

  it("hides and ignores unsupported operations", async () => {
    const ui = await mount({ remove: undefined, setEnabled: undefined });
    try {
      expect(ui.output()).not.toContain("d: Delete");
      expect(ui.output()).not.toContain("t: Enable/disable");
      expect(ui.output()).not.toContain("n: Create");
      await ui.key("d"); await ui.key("y"); await ui.key("t");
      expect(ui.adapter.list).toHaveBeenCalledOnce();
    } finally { ui.instance.unmount(); }
  });

  it("validates forms, saves through the adapter and cancels without writing", async () => {
    const create = vi.fn(async () => {});
    const ui = await mount({ fields: [{ name: "name", label: "Name", required: true }], create });
    try {
      await ui.key("n");
      await ui.key("\r");
      expect(ui.output()).toContain("Name is required");
      expect(create).not.toHaveBeenCalled();
      await ui.key("example");
      await ui.key("\r");
      expect(create).toHaveBeenCalledWith({ name: "example" });
      await ui.key("n"); await ui.key("cancelled"); await ui.key("\x1b");
      expect(create).toHaveBeenCalledOnce();
    } finally { ui.instance.unmount(); }
  });

  it("edits existing values and enforces item-specific delete restrictions", async () => {
    const update = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    const entry = { id: "bundled", title: "Bundled", description: "desc", detail: "detail", removable: false, values: { name: "old" } };
    const ui = await mount({ list: vi.fn(async () => [entry]), fields: [{ name: "name", label: "Name", required: true }], update, remove });
    try {
      expect(ui.output()).not.toContain("d: Delete");
      await ui.key("d"); await ui.key("y");
      expect(remove).not.toHaveBeenCalled();
      await ui.key("e");
      expect(ui.output()).toContain("old");
      await ui.key("x"); await ui.key("\r");
      expect(update).toHaveBeenCalledWith("bundled", { name: "oldx" });
    } finally { ui.instance.unmount(); }
  });

  it("locks repeated mutations while an operation is pending", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const setEnabled = vi.fn(() => pending);
    const ui = await mount({ setEnabled });
    try {
      await ui.key("t"); await ui.key("t"); await ui.key("\x1b");
      expect(setEnabled).toHaveBeenCalledOnce();
      expect(ui.onExit).not.toHaveBeenCalled();
      finish(); await ui.settle(); await ui.key("\x1b");
      expect(ui.onExit).toHaveBeenCalledOnce();
    } finally { finish(); ui.instance.unmount(); }
  });

  it("surfaces failures and remains usable for refresh and ESC", async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue([]);
    const ui = await mount({ list });
    try {
      expect(ui.output()).toContain("offline");
      await ui.key("r");
      expect(list).toHaveBeenCalledTimes(2);
      expect(ui.output()).toContain("No resources found");
      await ui.key("\x1b");
      expect(ui.onExit).toHaveBeenCalledOnce();
    } finally { ui.instance.unmount(); }
  });

  it("filters full search text and clamps empty/stale page selection", () => {
    const items = [{ id: "a", title: "Title", description: "desc", detail: "detail", searchText: "OAuth token" }];
    expect(filterResources(items, "OAUTH")).toEqual(items);
    expect(filterResources(items, "absent")).toEqual([]);
    expect(resourcePage(99, 0, 5)).toEqual({ selected: 0, page: 0, pages: 1 });
    expect(resourcePage(99, 6, 5)).toEqual({ selected: 5, page: 1, pages: 2 });
  });
});
