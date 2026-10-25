#!/usr/bin/env node
// Verify a compiled Agav binary embeds the pinned Bun runtime.
//
// Why this exists: `bun build --compile` statically embeds the Bun runtime (and
// its vendored C libraries: Brotli, c-ares, zlib, libarchive) into the published
// executable. The ADVISORY gate for those components is scripts/check-bun-advisories.mjs,
// which maps the pinned Bun version and its vendored component versions to a
// maintained advisory floor. That gate only means something if the artifact that
// ships actually embeds the Bun version it claims — otherwise a stale or wrong
// build could slip a different, unvetted runtime past a green advisory check.
// This script closes that gap: it proves the compiled binary embeds exactly the
// pinned Bun, per artifact, before release.
//
// It deliberately does NOT emit an SBOM or run a scanner: Trivy cannot
// advisory-match statically linked C libraries from an SBOM (its CycloneDX
// decoder keys on PURL ecosystem, has no CPE path, and skips `pkg:generic`), so
// such a scan would pass while scanning nothing. Component advisories are gated
// by check-bun-advisories.mjs instead.
//
// Usage: node scripts/verify-embedded-runtime.mjs <path-to-binary>
//
// Posture: strict and fail-closed. A binary that does not embed the pinned Bun
// marker, or that embeds a conflicting one, exits non-zero.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function readPinnedBunVersion() {
  let raw;
  try {
    raw = readFileSync(join(root, ".bun-version"), "utf8");
  } catch (error) {
    fail(`Cannot read .bun-version: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length !== 1 || !/^\d+\.\d+\.\d+$/.test(lines[0].trim())) {
    fail(`.bun-version must contain exactly one x.y.z version line.`);
  }
  return lines[0].trim();
}

/**
 * A `bun build --compile` single-file executable runs the APPLICATION, not the
 * Bun CLI, so it does not answer `bun --revision`; running it proves nothing
 * about the embedded runtime. But the embedded runtime stamps its own version
 * into the binary as `bun-v<x.y.z>`. Requiring the distinctive `bun-v<expected>`
 * marker — not a bare version substring that could coincide with an app string —
 * proves the artifact embeds exactly the pinned runtime. Works identically for
 * native and cross-compiled targets.
 */
function verifyEmbeddedBunVersion(binaryPath, expected) {
  let bytes;
  try {
    bytes = readFileSync(binaryPath);
  } catch (error) {
    fail(`Cannot read ${binaryPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const marker = Buffer.from(`bun-v${expected}`, "utf8");
  if (!bytes.includes(marker)) {
    fail(
      `Compiled binary ${binaryPath} does not embed the pinned Bun runtime marker "bun-v${expected}". ` +
        `It was likely built with a different Bun; refusing to accept an unverified runtime.`,
    );
  }
  // Defense in depth: reject a binary that ALSO carries a different bun-v marker,
  // which would mean the artifact is ambiguous about its runtime.
  const strayMarker = /bun-v(\d+\.\d+\.\d+)/g;
  const text = bytes.toString("latin1");
  const seen = new Set();
  let match;
  while ((match = strayMarker.exec(text)) !== null) seen.add(match[1]);
  const others = [...seen].filter((version) => version !== expected);
  if (others.length > 0) {
    fail(
      `Compiled binary ${binaryPath} embeds conflicting Bun runtime markers (${[expected, ...others].join(", ")}). ` +
        `Refusing to accept an ambiguous runtime.`,
    );
  }
}

function main() {
  const [, , binaryPath] = process.argv;
  if (!binaryPath) {
    fail("Usage: node scripts/verify-embedded-runtime.mjs <path-to-binary>");
  }
  const bunVersion = readPinnedBunVersion();
  verifyEmbeddedBunVersion(binaryPath, bunVersion);
  console.log(`Verified: ${binaryPath} embeds the pinned Bun ${bunVersion}.`);
}

main();
