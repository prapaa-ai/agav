#!/usr/bin/env node
// Validate the pinned Bun toolchain version against a maintained advisory floor.
//
// Why this exists: Agav ships release binaries built with `bun build --compile`,
// which embeds the Bun runtime (and its vendored C libraries such as Brotli and
// c-ares) INTO the published executable. That runtime is not an npm dependency,
// so `pnpm audit`, the SBOM, and Semgrep never see it. A Bun-level CVE — for
// example CVE-2026-111497, the Brotli decoder out-of-bounds write reachable from
// fetch() on a `Content-Encoding: br` response — therefore ships to users with
// every green CI run unless something explicitly maps the pinned Bun version to
// known advisories. This script is that gate.
//
// Posture: strict and fail-closed. Any parse failure, malformed pin, workflow
// drift, or pin below the advisory floor is a hard error (exit 1). There is no
// warn-only path: a runtime CVE is a shipped-product vulnerability, not advice.
//
// Maintenance: when a new Bun advisory lands, raise `minimumSafeVersion` and add
// an entry to `advisories`. The pinned `.bun-version` must be >= the floor.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Resolve against the working directory, not this file's location: CI always
// invokes `node scripts/check-bun-advisories.mjs` from the repository root, and
// that is the checkout whose `.bun-version` and workflows actually ship. Reading
// from cwd also lets the gate be exercised against an isolated copy in tests.
const root = resolve(process.cwd());

/**
 * The minimum Bun version considered free of known, Agav-relevant advisories.
 * Raise this whenever a new Bun security release fixes a CVE that affects the
 * embedded runtime. Keep the rationale in `advisories` below.
 */
const minimumSafeVersion = "1.4.4";

/**
 * Known advisories that forced the floor upward, newest first. Documentation
 * only — the gate compares against `minimumSafeVersion` — but it records WHY the
 * floor is where it is so a future bump is never a mystery and a careless
 * downgrade is self-evidently wrong in review.
 */
const advisories = [
  {
    id: "CVE-2026-111497",
    aliases: ["Node2Shell", "HTTP2Shell"],
    severity: "CRITICAL",
    component: "brotli (vendored into the Bun runtime)",
    affected: "Bun <= 1.4.3 (builds Brotli <= 1.2.0)",
    fixedIn: "1.4.4",
    reference: "https://github.com/oven-sh/bun/issues/46352",
    note:
      "Out-of-bounds write in the Brotli decoder, reachable by default from " +
      "fetch() on a Content-Encoding: br response and from node:zlib / " +
      "DecompressionStream('brotli'). Remote code execution demonstrated on an " +
      "unpatched Node.js build sharing the same decoder source.",
  },
];

/** Every workflow that pins a Bun version, so drift cannot reintroduce a hole. */
const pinnedWorkflows = [
  ".github/workflows/pr-checks.yml",
  ".github/workflows/postmerge-ci.yml",
  ".github/workflows/release.yml",
];

/** Semantic-version string -> comparable tuple. Rejects anything non-numeric. */
function parseVersion(label, raw) {
  const value = String(raw).trim();
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`${label} is not a plain x.y.z version: ${JSON.stringify(raw)}`);
  }
  return { value, parts: [Number(match[1]), Number(match[2]), Number(match[3])] };
}

/** Returns negative/zero/positive like a comparator for two parsed versions. */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
  }
  return 0;
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function readPinnedVersion() {
  let raw;
  try {
    raw = readFileSync(join(root, ".bun-version"), "utf8");
  } catch (error) {
    fail(`Cannot read .bun-version: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Fail closed on stray content (multiple lines, comments, trailing text):
  // the pin must be exactly one version so there is nothing to misread.
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length !== 1) {
    fail(`.bun-version must contain exactly one version line; found ${lines.length}.`);
  }
  try {
    return parseVersion(".bun-version", lines[0]);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Every workflow must pin the exact `.bun-version` value for `oven-sh/setup-bun`.
 * A workflow that sets a different literal, or omits the pin while still using
 * Bun, is drift that could ship an unscanned runtime — so it fails closed.
 */
function verifyWorkflowsMatch(pinned) {
  const bunVersionLine = /bun-version:\s*["']?([^"'\s#]+)["']?/g;
  for (const relative of pinnedWorkflows) {
    let content;
    try {
      content = readFileSync(join(root, relative), "utf8");
    } catch (error) {
      fail(`Cannot read ${relative}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const usesSetupBun = content.includes("oven-sh/setup-bun");
    const matches = [...content.matchAll(bunVersionLine)];

    if (!usesSetupBun && matches.length === 0) continue;
    if (usesSetupBun && matches.length === 0) {
      fail(`${relative} uses oven-sh/setup-bun but pins no bun-version. Pin it to ${pinned.value}.`);
    }

    for (const match of matches) {
      let workflowVersion;
      try {
        workflowVersion = parseVersion(`${relative} bun-version`, match[1]);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
      if (compareVersions(workflowVersion, pinned) !== 0) {
        fail(
          `${relative} pins bun-version ${workflowVersion.value}, but .bun-version is ${pinned.value}. ` +
            `Keep every workflow pin equal to .bun-version (single source of truth).`,
        );
      }
    }
  }
}

function main() {
  const pinned = readPinnedVersion();
  const floor = parseVersion("minimumSafeVersion", minimumSafeVersion);

  if (compareVersions(pinned, floor) < 0) {
    const relevant = advisories.filter((item) => item.fixedIn && compareVersions(floor, parseVersion("fixedIn", item.fixedIn)) >= 0);
    const detail = relevant
      .map((item) => `  - ${item.id} (${item.severity}) in ${item.component}; fixed in Bun ${item.fixedIn}. ${item.reference}`)
      .join("\n");
    fail(
      `Pinned Bun ${pinned.value} is below the advisory floor ${floor.value}. ` +
        `The embedded runtime ships with every release binary, so this is a product vulnerability.\n` +
        (detail ? `Known advisories requiring the floor:\n${detail}\n` : "") +
        `Raise .bun-version (and matching workflow pins) to ${floor.value} or newer.`,
    );
  }

  verifyWorkflowsMatch(pinned);

  console.log(
    `Pinned Bun ${pinned.value} meets the advisory floor ${floor.value}; ` +
      `all workflow pins match. Advisories tracked: ${advisories.map((item) => item.id).join(", ") || "none"}.`,
  );
}

main();
