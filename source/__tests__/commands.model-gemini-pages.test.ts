import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGeminiModels } from "../commands/model.js";

afterEach(() => vi.unstubAllGlobals());

describe("fetchGeminiModels", () => {
  it("follows nextPageToken and deduplicates ids", async () => {
    const pages = [
      { models: [
        { name: "models/gemini-a", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 100 },
        { name: "models/embed", supportedGenerationMethods: ["embedContent"] },
      ], nextPageToken: "p2" },
      { models: [
        { name: "models/gemini-b", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-a", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 100 },
      ], nextPageToken: "p2" },
    ];
    const fetchMock = vi.fn(async (url: string) => {
      const token = new URL(url).searchParams.get("pageToken");
      return new Response(JSON.stringify(token === "p2" ? pages[1] : pages[0]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const models = await fetchGeminiModels("key");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(models.map((m) => m.id)).toEqual(["gemini-a", "gemini-b"]);
    expect(models[0]?.contextWindow).toBe(100);
  });

  it("stops when a page repeats the same token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      models: [{ name: "models/gemini-a", supportedGenerationMethods: ["generateContent"] }],
      nextPageToken: "loop",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const models = await fetchGeminiModels("key");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(models.map((m) => m.id)).toEqual(["gemini-a"]);
  });
});
