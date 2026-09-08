import { describe, expect, it } from "vitest";

import { compressJsonToolResult } from "../agent/json-compressor.js";

function bigArray(n: number): string {
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push({ id: i, name: `item ${i}`, path: `src/file${i}.ts`, score: i % 7 });
  }
  return JSON.stringify(items);
}

describe("json tool-result compressor", () => {
  it("leaves non-JSON untouched", () => {
    const text = "just some log output ".repeat(300);
    const r = compressJsonToolResult(text);
    expect(r.compressed).toBe(false);
    expect(r.text).toBe(text);
  });

  it("leaves small payloads untouched", () => {
    const r = compressJsonToolResult(JSON.stringify([{ a: 1 }, { a: 2 }]));
    expect(r.compressed).toBe(false);
  });

  it("leaves invalid JSON untouched", () => {
    const text = "[{ broken json " + "x".repeat(3000);
    const r = compressJsonToolResult(text);
    expect(r.compressed).toBe(false);
    expect(r.text).toBe(text);
  });

  it("compresses a large array of objects and stays valid JSON", () => {
    const r = compressJsonToolResult(bigArray(200));
    expect(r.compressed).toBe(true);
    expect(r.compressedChars).toBeLessThan(r.originalChars);
    const parsed = JSON.parse(r.text);
    expect(Array.isArray(parsed)).toBe(true);
    // Contains the compression marker.
    const marker = parsed.find((x: any) => x && x.__compressed__);
    expect(marker).toBeDefined();
    expect(marker.droppedItems).toBeGreaterThan(0);
  });

  it("keeps first and last boundary items", () => {
    const r = compressJsonToolResult(bigArray(200));
    const parsed = JSON.parse(r.text);
    // First real item is id 0; last real item is id 199.
    const ids = parsed.filter((x: any) => !x.__compressed__).map((x: any) => x.id);
    expect(ids).toContain(0);
    expect(ids).toContain(199);
  });

  it("always keeps items that look like errors", () => {
    const items: any[] = [];
    for (let i = 0; i < 200; i++) {
      items.push({ id: i, name: `n${i}`, path: `p${i}`, ok: true });
    }
    items[100] = { id: 100, name: "boom", error: "ENOENT: missing file", path: "p100" };
    const r = compressJsonToolResult(JSON.stringify(items));
    expect(r.compressed).toBe(true);
    const parsed = JSON.parse(r.text);
    const errItem = parsed.find((x: any) => x && x.error === "ENOENT: missing file");
    expect(errItem).toBeDefined();
  });

  it("does not treat error:false as an error", () => {
    const items: any[] = [];
    for (let i = 0; i < 200; i++) items.push({ id: i, error: false, name: `n${i}`.repeat(2) });
    const r = compressJsonToolResult(JSON.stringify(items));
    expect(r.compressed).toBe(true);
    const parsed = JSON.parse(r.text);
    // Middle items (all error:false) should be dropped, not all kept.
    const realItems = parsed.filter((x: any) => !x.__compressed__);
    expect(realItems.length).toBeLessThan(200);
  });

  it("compresses the largest array field of a root object", () => {
    const payload = {
      query: "foo",
      total: 200,
      results: Array.from({ length: 200 }, (_, i) => ({ id: i, snippet: `match ${i}`.repeat(3) })),
    };
    const r = compressJsonToolResult(JSON.stringify(payload));
    expect(r.compressed).toBe(true);
    const parsed = JSON.parse(r.text);
    expect(parsed.query).toBe("foo"); // sibling fields preserved
    expect(parsed.total).toBe(200);
    const marker = parsed.results.find((x: any) => x && x.__compressed__);
    expect(marker.note).toContain("results");
  });

  it("keeps length outliers", () => {
    const items: any[] = Array.from({ length: 200 }, (_, i) => ({ id: i, v: "x" }));
    items[50] = { id: 50, v: "y".repeat(5000) }; // huge outlier in the middle
    const r = compressJsonToolResult(JSON.stringify(items));
    expect(r.compressed).toBe(true);
    const parsed = JSON.parse(r.text);
    const outlier = parsed.find((x: any) => typeof x.v === "string" && x.v.length === 5000);
    expect(outlier).toBeDefined();
  });

  it("never grows the payload", () => {
    // An array of objects that are all distinct and near boundary count.
    const r = compressJsonToolResult(bigArray(13));
    // Either it compressed (smaller) or it declined — never larger.
    expect(r.compressedChars).toBeLessThanOrEqual(r.originalChars);
  });
});
