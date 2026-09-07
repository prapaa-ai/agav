import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index";

// Minimal fakes so the Worker can be exercised without the workers runtime.
// caches.default is stubbed to a no-op miss/put so the fallback path is testable.
function stubCaches() {
  (globalThis as unknown as { caches: unknown }).caches = {
    default: {
      match: async () => undefined,
      put: async () => undefined,
    },
  };
}

function makeR2(objects: Record<string, string>) {
  return {
    async head(key: string) {
      if (!(key in objects)) return null;
      return {
        httpEtag: `"${key}"`,
        writeHttpMetadata(h: Headers) {
          h.set("content-type", "application/octet-stream");
        },
      };
    },
    async get(key: string) {
      if (!(key in objects)) return null;
      return {
        httpEtag: `"${key}"`,
        body: objects[key],
        writeHttpMetadata(h: Headers) {
          h.set("content-type", "application/octet-stream");
        },
      };
    },
  };
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function req(path: string, method = "GET") {
  return new Request(`https://releases.agav.dev${path}`, { method });
}

describe("releases-worker: R2 primary + GitHub fallback", () => {
  beforeEach(() => stubCaches());
  afterEach(() => vi.unstubAllGlobals());

  it("serves from R2 when the object exists (primary)", async () => {
    const env = { RELEASES: makeR2({ "v0.2.1/agav-darwin-arm64.gz": "R2-BYTES" }) };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await worker.fetch(req("/v0.2.1/agav-darwin-arm64.gz"), env as never, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Agav-Origin")).toBe("r2");
    expect(await res.text()).toBe("R2-BYTES");
    expect(fetchSpy).not.toHaveBeenCalled(); // never touched GitHub
  });

  it("falls back to GitHub when the object is not in R2", async () => {
    const env = { RELEASES: makeR2({}) }; // empty bucket
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === "string" ? input : input.toString();
        expect(u).toBe(
          "https://github.com/prapaa-ai/agav/releases/download/v0.2.1/agav-darwin-arm64.gz",
        );
        return new Response("GH-BYTES", { status: 200 });
      }),
    );

    const res = await worker.fetch(req("/v0.2.1/agav-darwin-arm64.gz"), env as never, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Agav-Origin")).toBe("github-fallback");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(await res.text()).toBe("GH-BYTES");
  });

  it("returns 404 when absent from both R2 and GitHub (real miss)", async () => {
    const env = { RELEASES: makeR2({}) };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));

    const res = await worker.fetch(req("/v0.2.1/does-not-exist.gz"), env as never, ctx);
    expect(res.status).toBe(404);
  });

  it("HEAD on an R2 object returns 200 with no body", async () => {
    const env = { RELEASES: makeR2({ "v0.2.1/SHA256SUMS": "sums" }) };
    vi.stubGlobal("fetch", vi.fn());

    const res = await worker.fetch(req("/v0.2.1/SHA256SUMS", "HEAD"), env as never, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Agav-Origin")).toBe("r2");
    expect(await res.text()).toBe("");
  });

  it("rejects non-GET/HEAD methods with 405", async () => {
    const env = { RELEASES: makeR2({}) };
    vi.stubGlobal("fetch", vi.fn());
    const res = await worker.fetch(req("/v0.2.1/agav-darwin-arm64.gz", "POST"), env as never, ctx);
    expect(res.status).toBe(405);
  });

  it("rejects unsafe / malformed paths", async () => {
    const env = { RELEASES: makeR2({}) };
    vi.stubGlobal("fetch", vi.fn());
    expect((await worker.fetch(req("/"), env as never, ctx)).status).toBe(404);
    expect((await worker.fetch(req("/only-one"), env as never, ctx)).status).toBe(404);
    expect((await worker.fetch(req("/a/b/c"), env as never, ctx)).status).toBe(404);
    expect(
      (await worker.fetch(req("/v0.2.1/..%2F..%2Fetc%2Fpasswd"), env as never, ctx)).status,
    ).toBe(400);
  });
});
