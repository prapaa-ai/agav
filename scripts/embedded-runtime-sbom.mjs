#!/usr/bin/env node
// Emit a CycloneDX SBOM for the Bun runtime embedded in a compiled Agav binary,
// after verifying the binary actually embeds the pinned Bun version.
//
// Why this exists: `bun build --compile` statically embeds the Bun runtime and
// its vendored C libraries (Brotli, c-ares, zlib, libarchive, ...) into the
// published executable. A generic binary scan (Trivy's executable analyzer only
// hashes the file for SBOM-attestation lookup) does NOT reconstruct those
// statically linked components, so an empty scan result is not evidence of
// safety. This script produces an explicit, verifiable component inventory tied
// to the exact artifact, which the CI then scans with Trivy. Any advisory
// affecting one of these components fails the pipeline.
//
// Usage: node scripts/embedded-runtime-sbom.mjs <path-to-binary> <output-sbom.json>
//
// Posture: strict and fail-closed. If the binary does not embed the pinned Bun
// version (wrong build, stripped, corrupted, or a version the component map does
// not cover), this exits non-zero and writes no SBOM: an unverifiable artifact
// must not be reported as scanned.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const root = resolve(process.cwd());

/**
 * Vendored native components per Bun version, with the exact upstream versions
 * that Bun bundles. Keyed by the pinned Bun version so the SBOM reflects what
 * actually ships. Update this together with `.bun-version` on every Bun bump
 * (Bun publishes the bundled dependency versions in its release notes / repo).
 *
 * Only components whose vulnerabilities would reach Agav at runtime are listed;
 * each has a CycloneDX `purl` so Trivy maps it to advisory databases.
 */
const BUN_RUNTIME_COMPONENTS = {
  "1.4.4": [
    { name: "bun", version: "1.4.4", purl: "pkg:generic/bun@1.4.4" },
    // Brotli 1.2.1 carries the CVE-2026-111497 fix (google/brotli@0ed4268).
    { name: "brotli", version: "1.2.1", purl: "pkg:generic/brotli@1.2.1" },
    { name: "c-ares", version: "1.34.5", purl: "pkg:generic/c-ares@1.34.5" },
    { name: "zlib", version: "1.3.1", purl: "pkg:generic/zlib@1.3.1" },
    { name: "libarchive", version: "3.7.7", purl: "pkg:generic/libarchive@3.7.7" },
  ],
};

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
 * Confirm the binary embeds the pinned Bun version by scanning its bytes.
 *
 * A `bun build --compile` single-file executable runs the APPLICATION, not the
 * Bun CLI, so it does not answer `bun --revision`; running it proves nothing
 * about the embedded runtime. But the embedded runtime stamps its own version
 * into the binary as `bun-v<x.y.z>` (and `v<x.y.z> (<commit>)`). Requiring the
 * distinctive `bun-v<expected>` marker — not a bare version substring that could
 * coincide with an app string or dependency — proves the SBOM describes THIS
 * artifact's runtime. Works identically for native and cross-compiled targets.
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
        `It was likely built with a different Bun; refusing to emit an SBOM for an unverified runtime.`,
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
        `Refusing to emit an SBOM for an ambiguous runtime.`,
    );
  }
}

function main() {
  const [, , binaryPath, outputPath] = process.argv;
  if (!binaryPath || !outputPath) {
    fail("Usage: node scripts/embedded-runtime-sbom.mjs <path-to-binary> <output-sbom.json>");
  }

  const bunVersion = readPinnedBunVersion();
  const components = BUN_RUNTIME_COMPONENTS[bunVersion];
  if (!components) {
    fail(
      `No embedded-runtime component map for Bun ${bunVersion}. Add its vendored component versions to ` +
        `BUN_RUNTIME_COMPONENTS in scripts/embedded-runtime-sbom.mjs when bumping the Bun pin, so the SBOM ` +
        `reflects what ships. Refusing to emit an incomplete SBOM.`,
    );
  }

  verifyEmbeddedBunVersion(binaryPath, bunVersion);

  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        type: "application",
        name: "agav",
        // The scanned artifact itself; versioned by the embedded Bun runtime.
        version: bunVersion,
        purl: `pkg:generic/agav-bun-runtime@${bunVersion}`,
      },
    },
    components: components.map((component) => ({
      type: "library",
      name: component.name,
      version: component.version,
      purl: component.purl,
    })),
  };

  writeFileSync(outputPath, JSON.stringify(sbom, null, 2) + "\n");
  console.log(
    `Wrote embedded-runtime SBOM for Bun ${bunVersion} (${components.length} components) to ${outputPath}.`,
  );
}

main();
