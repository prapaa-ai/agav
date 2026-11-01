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
// Workflow pins are validated with a REAL YAML parser (the `yaml` package, a
// production dependency). A handwritten scanner repeatedly mis-handled valid YAML
// — flow mappings, block scalars, comments after `with:` — so each workflow
// gate installs `yaml` before invoking this script (see the "Validate ... against
// advisory floor" steps). If `yaml` is unavailable the gate fails closed rather
// than silently skipping validation.
//
// Maintenance: on a Bun bump, update `.bun-version`, the workflow pins,
// `minimumSafeVersion`/`advisories`, and the `vendoredComponents` map (bundled
// versions + floors). The pinned `.bun-version` must be >= the floor.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Resolve against the working directory, not this file's location: CI always
// invokes `node scripts/check-bun-advisories.mjs` from the repository root, and
// that is the checkout whose `.bun-version` and workflows actually ship. Reading
// from cwd also lets the gate be exercised against an isolated copy in tests.
const root = resolve(process.cwd());

/** Load the real YAML parser, failing closed if it is not installed. */
async function loadYamlParser() {
  try {
    return (await import("yaml")).parse;
  } catch {
    fail(
      "The `yaml` package is required to validate workflow Bun pins but is not installed. " +
        "Install dependencies (or at least `yaml`) before running this gate; refusing to validate workflows with a fragile fallback.",
    );
  }
}

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

/** Every step across all jobs of a parsed workflow document. */
function* workflowSteps(doc) {
  const jobs = doc && typeof doc === "object" && !Array.isArray(doc) ? doc.jobs : undefined;
  if (!jobs || typeof jobs !== "object") return;
  for (const job of Object.values(jobs)) {
    const steps = job && typeof job === "object" ? job.steps : undefined;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (step && typeof step === "object" && !Array.isArray(step)) yield step;
    }
  }
}

/** `uses:` value that names the setup-bun action (any ref). */
function isSetupBunUses(uses) {
  return typeof uses === "string" && /^oven-sh\/setup-bun(@|$)/.test(uses.trim());
}

/**
 * Every `oven-sh/setup-bun` step must pin `with.bun-version` to the exact
 * `.bun-version` value. Uses a real YAML parser, so flow mappings, block
 * scalars, quoted keys, and comments are all handled correctly. `bun-version`
 * is read ONLY from the step's `with` mapping — setup-bun ignores it anywhere
 * else (e.g. under `env:`), so a pin elsewhere is no pin. Fails closed on any
 * mismatch, missing pin, non-version pin, or unparseable workflow.
 */
function verifyWorkflowsMatch(pinned, parseYaml) {
  for (const relative of pinnedWorkflows) {
    let content;
    try {
      content = readFileSync(join(root, relative), "utf8");
    } catch (error) {
      fail(`Cannot read ${relative}: ${error instanceof Error ? error.message : String(error)}`);
    }

    let doc;
    try {
      doc = parseYaml(content);
    } catch (error) {
      fail(`Cannot parse ${relative} as YAML: ${error instanceof Error ? error.message : String(error)}`);
    }

    for (const step of workflowSteps(doc)) {
      if (!isSetupBunUses(step.uses)) continue;
      const withBlock = step.with && typeof step.with === "object" && !Array.isArray(step.with) ? step.with : {};
      const pin = withBlock["bun-version"];
      if (pin === undefined || pin === null || pin === "") {
        fail(
          `${relative} has an oven-sh/setup-bun step that pins no with.bun-version. ` +
            `Pin bun-version to ${pinned.value} (single source of truth: .bun-version).`,
        );
      }
      if (typeof pin !== "string" && typeof pin !== "number") {
        fail(`${relative} has an oven-sh/setup-bun step whose bun-version is not a plain version: ${JSON.stringify(pin)}.`);
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

async function main() {
  const parseYaml = await loadYamlParser();
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

  verifyWorkflowsMatch(pinned, parseYaml);

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

  if (process.argv.includes("--inventory-json")) {
    console.log(JSON.stringify({ bun: pinned.value, ...Object.fromEntries(components.map(c => [c.name, c.current])) }));
    return;
  }

  console.log(
    `Pinned Bun ${pinned.value} meets the advisory floor ${floor.value}; all workflow pins match; ` +
      `vendored components OK (${components.map((c) => `${c.name}@${c.current}`).join(", ")}). ` +
      `Advisories tracked: ${advisories.map((item) => item.id).join(", ") || "none"}.`,
  );
}

main();
