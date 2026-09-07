import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// downloadBinary streams to ~/.agav, resolved once at import time, and builds
// the asset name from os.platform()/os.arch(). Pin both to a temp home and a
// known platform (linux/x64 -> agav-linux-x64) before the module loads.
const home = await mkdtemp(join(tmpdir(), "agav-dl-home-"));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: actual,
    homedir: () => home,
    platform: () => "linux",
    arch: () => "x64",
  };
});

const { downloadBinary } = await import("../utils/auto-update.js");

const VERSION = "v0.2.1-beta.8";
const ASSET = "agav-linux-x64";
const MIRROR = "https://releases.agav.dev";
const GITHUB = "https://github.com/prapaa-ai/agav/releases/download";

// The bytes a correct release would serve, and their true digest.
const BINARY = Buffer.from("the real agav binary bytes");
const GZ = gzipSync(BINARY);
const DIGEST = createHash("sha256").update(BINARY).digest("hex");

/** A minimal Response-like object backed by a Node stream, enough for the
 * pieces of fetch() that streamAssetToFile / verifyChecksum use. */
function makeResponse(body: Buffer | string, ok = true): Response {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  return {
    ok,
    body: ok ? (Readable.from(buf) as unknown as ReadableStream) : null,
    headers: new Map([["content-length", String(buf.length)]]) as unknown as Headers,
    async text() {
      return buf.toString("utf8");
    },
  } as unknown as Response;
}

// A 404-style failure.
const NOT_FOUND = { ok: false, body: null, headers: new Map(), async text() { return ""; } } as unknown as Response;

/**
 * Install a fetch stub from a routing table: an ordered list of
 * [matcher, responder]. First match wins. Records every requested URL.
 */
type Route = [(url: string) => boolean, (url: string) => Response];
let requested: string[] = [];
function installFetch(routes: Route[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      requested.push(url);
      for (const [match, respond] of routes) {
        if (match(url)) return respond(url);
      }
      return NOT_FOUND;
    }),
  );
}

// Serve a full, correct set of assets (gz + raw + sha256) under one base.
function healthyRoutes(base: string): Route[] {
  return [
    [(u) => u === `${base}/${VERSION}/${ASSET}.gz`, () => makeResponse(GZ)],
    [(u) => u === `${base}/${VERSION}/${ASSET}`, () => makeResponse(BINARY)],
    [(u) => u === `${base}/${VERSION}/${ASSET}.sha256`, () => makeResponse(`${DIGEST}  ${ASSET}`)],
  ];
}

beforeEach(() => {
  requested = [];
  delete process.env.AGAV_MIRROR_BASE;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("downloadBinary origin fallback", () => {
  it("downloads from the mirror when it is healthy, never touching GitHub", async () => {
    installFetch(healthyRoutes(MIRROR));

    const path = await downloadBinary(VERSION);

    expect(path).not.toBeNull();
    expect(await readFile(path as string)).toEqual(BINARY);
    // Mirror .gz was fetched; no GitHub URL was ever requested.
    expect(requested.some((u) => u.startsWith(MIRROR))).toBe(true);
    expect(requested.some((u) => u.startsWith(GITHUB))).toBe(false);
    await rm(path as string, { force: true });
  });

  it("falls back to GitHub when the mirror serves nothing", async () => {
    // Mirror 404s everything; GitHub is healthy.
    installFetch([
      [(u) => u.startsWith(MIRROR), () => NOT_FOUND],
      ...healthyRoutes(GITHUB),
    ]);

    const path = await downloadBinary(VERSION);

    expect(path).not.toBeNull();
    expect(await readFile(path as string)).toEqual(BINARY);
    // It tried the mirror first, then succeeded on GitHub.
    expect(requested.some((u) => u.startsWith(MIRROR))).toBe(true);
    expect(requested.some((u) => u.startsWith(GITHUB))).toBe(true);
    await rm(path as string, { force: true });
  });

  it("falls through to GitHub when the mirror binary fails its own checksum", async () => {
    // Mirror serves a *corrupt* binary (and a sha256 that will not match it),
    // so verifyChecksum rejects the mirror and GitHub's good copy is used.
    const badBinary = Buffer.from("tampered mirror payload");
    const badGz = gzipSync(badBinary);
    installFetch([
      [(u) => u === `${MIRROR}/${VERSION}/${ASSET}.gz`, () => makeResponse(badGz)],
      [(u) => u === `${MIRROR}/${VERSION}/${ASSET}`, () => makeResponse(badBinary)],
      // Mirror's published digest is the *real* one, so the corrupt bytes fail.
      [(u) => u === `${MIRROR}/${VERSION}/${ASSET}.sha256`, () => makeResponse(`${DIGEST}  ${ASSET}`)],
      ...healthyRoutes(GITHUB),
    ]);

    const path = await downloadBinary(VERSION);

    expect(path).not.toBeNull();
    // The installed bytes are GitHub's correct ones, not the mirror's tampered ones.
    expect(await readFile(path as string)).toEqual(BINARY);
    expect(requested.some((u) => u === `${GITHUB}/${VERSION}/${ASSET}.sha256`)).toBe(true);
    await rm(path as string, { force: true });
  });

  it("returns null (installs nothing) when every origin fails", async () => {
    installFetch([[() => true, () => NOT_FOUND]]);

    const path = await downloadBinary(VERSION);

    expect(path).toBeNull();
  });

  it("returns null when no origin has a matching checksum (fail closed)", async () => {
    // Every origin serves a binary but a mismatched digest -> nothing installs.
    const wrongDigest = "0".repeat(64);
    installFetch([
      [(u) => u.endsWith(`${ASSET}.gz`), () => makeResponse(GZ)],
      [(u) => u.endsWith(`${ASSET}`), () => makeResponse(BINARY)],
      [(u) => u.endsWith(`${ASSET}.sha256`), () => makeResponse(`${wrongDigest}  ${ASSET}`)],
    ]);

    const path = await downloadBinary(VERSION);

    expect(path).toBeNull();
  });

  it("uses GitHub only when AGAV_MIRROR_BASE is empty", async () => {
    process.env.AGAV_MIRROR_BASE = "";
    installFetch(healthyRoutes(GITHUB));

    const path = await downloadBinary(VERSION);

    expect(path).not.toBeNull();
    // No request should ever go to the default mirror host.
    expect(requested.some((u) => u.startsWith(MIRROR))).toBe(false);
    expect(requested.some((u) => u.startsWith(GITHUB))).toBe(true);
    await rm(path as string, { force: true });
  });
});
