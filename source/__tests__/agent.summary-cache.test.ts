import { describe, expect, it } from "vitest";

import { SummaryCache, hashSummaryInput } from "../agent/summary-cache.js";
import type { Message } from "../providers/types.js";

const msgs = (text: string): Message[] => [
  { role: "user", content: [{ type: "text", text }] },
];

describe("summary cache", () => {
  it("same messages + model produce the same signature", () => {
    const a = hashSummaryInput("m", msgs("hello world"));
    const b = hashSummaryInput("m", msgs("hello world"));
    expect(a).toBe(b);
  });

  it("different content produces a different signature", () => {
    expect(hashSummaryInput("m", msgs("a"))).not.toBe(hashSummaryInput("m", msgs("b")));
  });

  it("different model produces a different signature", () => {
    expect(hashSummaryInput("m1", msgs("x"))).not.toBe(hashSummaryInput("m2", msgs("x")));
  });

  it("caches and returns a stored summary", () => {
    const cache = new SummaryCache();
    const key = hashSummaryInput("m", msgs("x"));
    expect(cache.get(key)).toBeUndefined();
    cache.set(key, "the summary");
    expect(cache.get(key)).toBe("the summary");
  });

  it("never caches an empty or whitespace-only summary", () => {
    const cache = new SummaryCache();
    const key = hashSummaryInput("m", msgs("x"));
    cache.set(key, "");
    cache.set(key, "   \n\t ");
    expect(cache.get(key)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the oldest entry past capacity", () => {
    const cache = new SummaryCache(2);
    cache.set("k1", "s1");
    cache.set("k2", "s2");
    cache.set("k3", "s3"); // evicts k1
    expect(cache.get("k1")).toBeUndefined();
    expect(cache.get("k2")).toBe("s2");
    expect(cache.get("k3")).toBe("s3");
    expect(cache.size).toBe(2);
  });

  it("get refreshes recency so a used entry survives eviction", () => {
    const cache = new SummaryCache(2);
    cache.set("k1", "s1");
    cache.set("k2", "s2");
    cache.get("k1"); // k1 now newest
    cache.set("k3", "s3"); // should evict k2, not k1
    expect(cache.get("k1")).toBe("s1");
    expect(cache.get("k2")).toBeUndefined();
  });
});
