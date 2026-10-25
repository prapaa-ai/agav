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
// It also validates the native C libraries Bun statically links (Brotli,
// c-ares, zlib, libarchive) against per-component advisory floors. Trivy cannot
// advisory-match those from an SBOM — its CycloneDX decoder keys on PURL
// ecosystem, has no CPE path, and classifies `pkg:generic` as Unknown and skips
// it — so this maintained floor, not a scanner, is their enforceable gate.
//
// Posture: strict and fail-closed. Any parse failure, malformed pin, workflow
// drift, a pin below the advisory floor, a vendored component below its floor, or
// a Bun version with no recorded component map is a hard error (exit 1). There is
// no warn-only path: a runtime CVE is a shipped-product vulnerability, not advice.
//
// Maintenance: on a Bun bump, update `.bun-version`, the workflow pins,
// `minimumSafeVersion`/`advisories`, and the `vendoredComponents` map (bundled
// versions + floors). The pinned `.bun-version` must be >= the floor.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Dependency-free by design: this gate runs on clean runners BEFORE
// `pnpm install` (PR runtime-audit, release check-version, postmerge pre-build),
// so it must not import any npm package. Workflow parsing below uses only Node
// built-ins and a small purpose-built scanner for setup-bun steps.

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

/**
 * Vendored native components statically linked into the compiled binary by the
 * pinned Bun, with the exact upstream versions that Bun source bundles, and a
 * per-component advisory floor. Trivy cannot advisory-match these statically
 * linked C libraries from an SBOM (its CycloneDX decoder keys on PURL ecosystem
 * and has no CPE path; `pkg:generic` is classified Unknown and skipped), so this
 * maintained floor — not a scanner — is the enforceable gate for them.
 *
 * Versions are traced from Bun's `scripts/build/deps/*.ts` at the pinned tag and
 * their upstream version headers. Update together with `.bun-version`:
 *   - c-ares: include/ares_version.h at Bun's pinned commit
 *   - zlib: Bun bundles zlib-ng in zlib-compat mode (its own release tag)
 *   - libarchive: build/version at Bun's pinned commit
 *   - brotli: the google/brotli tag at Bun's pinned commit
 *
 * `floor` is the lowest version free of known Agav-relevant advisories for that
 * component. `current` below the `floor` fails closed.
 */
const vendoredComponents = {
  "1.4.4": [
    {
      name: "brotli",
      current: "1.2.1",
      floor: "1.2.1",
      note: "1.2.1 carries the CVE-2026-111497 fix (google/brotli@0ed4268).",
    },
    { name: "c-ares", current: "1.34.8", floor: "1.34.8" },
    // Bun bundles zlib-ng (zlib-compatible ABI), pinned to its 2.3.3 tag.
    { name: "zlib-ng", current: "2.3.3", floor: "2.3.3" },
    { name: "libarchive", current: "3.8.9", floor: "3.8.9" },
  ],
};

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

/** Leading-space count; a line that is only whitespace has no meaningful indent. */
function indentOf(line) {
  return line.length - line.replace(/^ +/, "").length;
}

/** A comment line (first non-space char is `#`) carries no YAML key/value. */
function isComment(line) {
  return /^\s*#/.test(line);
}

/**
 * Parse one `key: value` line into `{ indent, key, value }`, or `null` when the
 * line is not a mapping entry. Handles quoted keys (`"uses":`) and strips an
 * unquoted trailing `# comment` from the value. Quoted values keep their quotes
 * for the caller to unwrap, so a `#` inside quotes is preserved.
 */
function parseKeyValue(line) {
  const indent = indentOf(line);
  const body = line.slice(indent);
  // key: optionally quoted, then a colon.
  const m = /^(?:"([^"]+)"|'([^']+)'|([^\s:#][^:]*?))\s*:(?:\s+(.*))?$/.exec(body);
  if (!m) return null;
  const key = (m[1] ?? m[2] ?? m[3]).trim();
  let value = (m[4] ?? "").trim();
  // Strip an inline comment only when it is OUTSIDE quotes. A quoted scalar
  // keeps everything between the quotes; otherwise a ` #...` tail is a comment.
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    const end = value.indexOf(quote, 1);
    value = end >= 0 ? value.slice(1, end) : value.slice(1);
  } else {
    value = value.replace(/\s+#.*$/, "").trim();
  }
  return { indent, key, value };
}

/**
 * Find every `oven-sh/setup-bun` step in a workflow and return the `bun-version`
 * value its `with:` block pins, or `null` when the step pins none there.
 *
 * Dependency-free (this gate runs before `pnpm install`), but strict about YAML
 * structure: it unwraps quoted keys/values, ignores comment lines and inline
 * comments, and — critically — only accepts `bun-version` nested under this
 * step's `with:` mapping. A `bun-version` placed under `env:` (or anywhere else)
 * is NOT a pin, because setup-bun only reads `with.bun-version`.
 */
function findSetupBunPins(content) {
  const lines = content.split(/\r?\n/);
  const pins = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || isComment(line)) continue;
    // A list item line, e.g. `      - uses: oven-sh/setup-bun@v2`.
    const marker = /^(\s*)-\s+(.*)$/.exec(line);
    if (!marker) continue;
    const markerIndent = marker[1].length;
    // The content after `- ` sits at column markerIndent + 2. Every block entry
    // is normalized to { indent, text } where `text` is a reconstructed, evenly
    // indented `key: value` line, so parseKeyValue sees a consistent shape.
    const firstContentIndent = markerIndent + 2;
    const block = [{ indent: firstContentIndent, text: `${" ".repeat(firstContentIndent)}${marker[2]}` }];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const next = lines[j];
      if (next.trim() === "") continue;
      const nextIndent = indentOf(next);
      if (nextIndent <= markerIndent) break; // sibling item or dedent ends the step
      block.push({ indent: nextIndent, text: next });
    }

    // Is this a setup-bun step? Check the `uses:` key value (quoted or not).
    const isSetupBun = block.some((b) => {
      if (isComment(b.text)) return false;
      const kv = parseKeyValue(b.text);
      return kv && kv.key === "uses" && /^oven-sh\/setup-bun(@|$)/.test(kv.value);
    });

    if (isSetupBun) {
      // Find the `with:` mapping and read `bun-version` nested directly under it.
      let pin = null;
      let withIndent = -1;
      for (const b of block) {
        if (isComment(b.text)) continue;
        const kv = parseKeyValue(b.text);
        if (!kv) continue;
        if (withIndent === -1) {
          if (kv.key === "with" && kv.value === "") withIndent = kv.indent;
          continue;
        }
        // Inside `with:`: a dedent to/under `with:` ends the mapping; a new
        // `with:` there reopens it.
        if (kv.indent <= withIndent) {
          withIndent = kv.key === "with" && kv.value === "" ? kv.indent : -1;
          continue;
        }
        if (kv.key === "bun-version") { pin = kv.value; break; }
      }
      pins.push(pin);
    }
    i = j - 1; // resume after this step's block
  }
  return pins;
}

/**
 * Every `oven-sh/setup-bun` step must pin `bun-version` to the exact
 * `.bun-version` value. A commented pin reads as absent, and each setup step is
 * checked on its own — both drift vectors a naive text match missed. Fails
 * closed on any mismatch, missing pin, or non-version pin.
 */
function verifyWorkflowsMatch(pinned) {
  for (const relative of pinnedWorkflows) {
    let content;
    try {
      content = readFileSync(join(root, relative), "utf8");
    } catch (error) {
      fail(`Cannot read ${relative}: ${error instanceof Error ? error.message : String(error)}`);
    }

    for (const pin of findSetupBunPins(content)) {
      if (pin === null || pin === "") {
        fail(
          `${relative} has an oven-sh/setup-bun step that pins no bun-version. ` +
            `Pin bun-version to ${pinned.value} (single source of truth: .bun-version).`,
        );
      }
      let workflowVersion;
      try {
        workflowVersion = parseVersion(`${relative} bun-version`, pin);
      } catch {
        fail(`${relative} has an oven-sh/setup-bun step whose bun-version is not a plain version: ${JSON.stringify(pin)}.`);
      }
      if (compareVersions(workflowVersion, pinned) !== 0) {
        fail(
          `${relative} pins bun-version ${workflowVersion.value}, but .bun-version is ${pinned.value}. ` +
            `Keep every oven-sh/setup-bun pin equal to .bun-version (single source of truth).`,
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

  // Validate the vendored native components statically linked by this Bun. A
  // Bun that meets the top-level floor can still bundle a vulnerable C library,
  // so each component is checked against its own floor. Missing map => fail
  // closed: a Bun bump must record what it ships.
  const components = vendoredComponents[pinned.value];
  if (!components) {
    fail(
      `No vendored-component map for Bun ${pinned.value}. Add its bundled component versions and advisory ` +
        `floors to vendoredComponents in scripts/check-bun-advisories.mjs when bumping the Bun pin, so the ` +
        `statically linked C libraries (Brotli, c-ares, zlib, libarchive, ...) remain gated. Refusing to pass blind.`,
    );
  }
  for (const component of components) {
    const current = parseVersion(`${component.name} current`, component.current);
    const componentFloor = parseVersion(`${component.name} floor`, component.floor);
    if (compareVersions(current, componentFloor) < 0) {
      fail(
        `Bun ${pinned.value} vendors ${component.name} ${current.value}, below its advisory floor ${componentFloor.value}. ` +
          `This C library is statically linked into every release binary. Bump Bun to a build that vendors a patched ` +
          `${component.name}, or correct the recorded version.`,
      );
    }
  }

  console.log(
    `Pinned Bun ${pinned.value} meets the advisory floor ${floor.value}; all workflow pins match; ` +
      `vendored components OK (${components.map((c) => `${c.name}@${c.current}`).join(", ")}). ` +
      `Advisories tracked: ${advisories.map((item) => item.id).join(", ") || "none"}.`,
  );
}

main();
