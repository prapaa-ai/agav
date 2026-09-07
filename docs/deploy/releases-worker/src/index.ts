/**
 * releases.agav.dev — R2-primary release mirror with GitHub Releases fallback.
 *
 *   GET https://releases.agav.dev/<tag>/<asset>
 *
 * Serving order:
 *   1. R2 (primary) — the bucket bound as `RELEASES` at key `<tag>/<asset>`.
 *   2. GitHub Releases (fallback) — proxied + edge-cached when the object is
 *      not yet mirrored to R2, so a release is downloadable the moment it is
 *      published on GitHub, before the R2 sync (Step 3) runs.
 *
 * A genuinely missing asset (absent from BOTH R2 and GitHub) returns 404, which
 * the installer's own fallback logic relies on.
 *
 * GitHub remains the source of truth; checksum verification happens in the
 * installer regardless of which tier served the bytes.
 */

interface Env {
  RELEASES: R2Bucket;
}

const REPO = "prapaa-ai/agav";

// Release paths are exactly two non-empty segments: <tag>/<asset>.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

function githubUrl(tag: string, asset: string): string {
  return `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
}

function methodNotAllowed(): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "GET, HEAD" },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed();
    }

    // Parse and validate the key: exactly <tag>/<asset>.
    const parts = url.pathname.replace(/^\/+/, "").split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return new Response("Not Found", { status: 404 });
    }

    let tag: string;
    let asset: string;
    try {
      tag = decodeURIComponent(parts[0]);
      asset = decodeURIComponent(parts[1]);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    if (!SAFE_SEGMENT.test(tag) || !SAFE_SEGMENT.test(asset)) {
      return new Response("Bad Request", { status: 400 });
    }

    const key = `${tag}/${asset}`;

    // ---- Tier 1: R2 (primary) ----
    const object =
      request.method === "HEAD"
        ? await env.RELEASES.head(key)
        : await env.RELEASES.get(key);

    if (object) {
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      if (!headers.has("Cache-Control")) {
        headers.set("Cache-Control", IMMUTABLE_CACHE);
      }
      headers.set("X-Agav-Origin", "r2");
      const body =
        request.method === "HEAD" ? null : (object as R2ObjectBody).body;
      return new Response(body, { status: 200, headers });
    }

    // ---- Tier 2: GitHub Releases (fallback), edge-cached ----
    const upstream = githubUrl(tag, asset);

    // Serve from the edge cache first to avoid re-hitting GitHub every time.
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) {
      return request.method === "HEAD"
        ? new Response(null, cached)
        : cached;
    }

    const ghResp = await fetch(upstream, {
      method: "GET",
      redirect: "follow",
      cf: { cacheEverything: true, cacheTtl: 31536000 },
    });

    if (!ghResp.ok) {
      // Absent from both R2 and GitHub — a real miss. Pass the status through.
      return new Response(`Not found: ${asset} (${ghResp.status})`, {
        status: ghResp.status === 404 ? 404 : 502,
      });
    }

    const response = new Response(ghResp.body, ghResp);
    response.headers.set("Cache-Control", IMMUTABLE_CACHE);
    response.headers.set("X-Agav-Origin", "github-fallback");

    ctx.waitUntil(cache.put(cacheKey, response.clone()));

    return request.method === "HEAD"
      ? new Response(null, response)
      : response;
  },
};
