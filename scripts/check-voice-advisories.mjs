#!/usr/bin/env node
// Validate the native voice helper's statically-linked C/C++ components against a
// maintained advisory floor.
//
// Why this exists: the voice-enabled release binary (`build:binary:voice` /
// `build:binary:all`) compiles native/voice/ with CMake, which FetchContent-pulls
// whisper.cpp (and the ggml it bundles) and miniaudio and statically links them
// into the published `agav-voice` helper embedded in the CLI. Those C/C++ sources
// are NOT npm dependencies and NOT part of the Bun runtime, so `pnpm audit`, the
// CycloneDX SBOM (npm graph only), Semgrep, and scripts/check-bun-advisories.mjs
// (Bun + its own vendored libs) never see them. A whisper.cpp or miniaudio
// advisory would therefore ship to voice users with every green run unless
// something explicitly maps the pinned versions to known advisories. This is that
// gate — the native-component analogue of check-bun-advisories.mjs.
//
// Single source of truth: versions are read from native/voice/CMakeLists.txt
// (the FetchContent URLs), never duplicated here, so a version bump cannot drift
// from what actually builds. Only the advisory FLOOR is maintained in this file.
//
// Posture: strict and fail-closed. A missing/unparseable CMakeLists, a component
// whose pinned version cannot be read, or a pinned version below its advisory
// floor is a hard error (exit 1). There is no warn-only path.
//
// ggml is vendored INSIDE the whisper.cpp tarball at the pinned tag (CMakeLists
// sets GGML_BUILD_COMMIT to the whisper tag); it has no independent version in the
// build config, so it is covered transitively by the whisper.cpp version/floor and
// its upstream advisory feed. This is recorded, not silently ignored.
//
// Maintenance: on a whisper.cpp or miniaudio bump, update the FetchContent URL +
// URL_HASH in native/voice/CMakeLists.txt, then review upstream advisories and the
// floor below. The pinned version must be >= the floor.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const CMAKE_PATH = "native/voice/CMakeLists.txt";

/**
 * Per-component advisory floor: the lowest version free of known, Agav-relevant
 * advisories. A pinned version below its floor fails closed. Bump a floor only
 * after reviewing the component's upstream advisories. `current` is NOT stored
 * here — it is read from CMakeLists.txt so the two cannot diverge.
 *
 * `cmakeName` is the FetchContent_Declare name in CMakeLists; `repo` is the
 * upstream GitHub repo whose security-advisory feed the live monitor queries.
 */
const components = [
  {
    name: "whisper.cpp",
    cmakeName: "whisper",
    repo: "ggml-org/whisper.cpp",
    floor: "1.7.6",
    note:
      "1.7.6 is the reviewed baseline; no known Agav-relevant advisory above it. " +
      "Bundles ggml at the same tag (covered transitively).",
  },
  {
    name: "miniaudio",
    cmakeName: "miniaudio",
    repo: "mackron/miniaudio",
    floor: "0.11.22",
    note: "0.11.22 is the reviewed baseline; no known Agav-relevant advisory above it.",
  },
];

/** Semantic-version string -> comparable tuple. Rejects anything non-numeric. */
function parseVersion(label, raw) {
  const value = String(raw).trim();
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error(`${label} is not a plain x.y.z version: ${JSON.stringify(raw)}`);
  return { value, parts: [Number(match[1]), Number(match[2]), Number(match[3])] };
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
  return 0;
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

/**
 * Read the pinned version of a FetchContent dependency from CMakeLists.txt. The
 * version is the final path segment of the tag URL, e.g.
 *   .../whisper.cpp/tar.gz/refs/tags/v1.7.6   -> 1.7.6
 *   .../miniaudio/tar.gz/refs/tags/0.11.22    -> 0.11.22
 * A leading `v` is tolerated. Fails closed if the declare block or its URL
 * cannot be located, so a refactor of CMakeLists cannot silently disable the gate.
 */
function readPinnedVersion(cmake, cmakeName) {
  // Isolate THIS component's declare block first — from `FetchContent_Declare(<name>`
  // up to the next `FetchContent_Declare(` (or end of file) — so a removed/malformed
  // URL cannot make the version match leak into the next component's block. Then read
  // the tag URL within that slice only.
  const start = new RegExp(`FetchContent_Declare\\(\\s*${cmakeName}\\b`, "m").exec(cmake);
  let declare = null;
  if (start) {
    const rest = cmake.slice(start.index + start[0].length);
    const nextDeclare = /FetchContent_Declare\s*\(/.exec(rest);
    const block = nextDeclare ? rest.slice(0, nextDeclare.index) : rest;
    declare = /URL\s+\S*?\/refs\/tags\/(v?\d+\.\d+\.\d+)/.exec(block);
  }
  if (!declare) {
    fail(
      `Could not read the pinned ${cmakeName} version from ${CMAKE_PATH}. ` +
        `The FetchContent_Declare(${cmakeName} ... URL .../refs/tags/<version>) form is required so this gate ` +
        `tracks what actually builds. Refusing to pass blind.`,
    );
  }
  return declare[1].replace(/^v/, "");
}

function main() {
  let cmake;
  try {
    cmake = readFileSync(join(root, CMAKE_PATH), "utf8");
  } catch (error) {
    fail(`Cannot read ${CMAKE_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const inventory = {};
  for (const component of components) {
    const current = parseVersion(`${component.name} current`, readPinnedVersion(cmake, component.cmakeName));
    const floor = parseVersion(`${component.name} floor`, component.floor);
    inventory[component.name] = current.value;
    if (compareVersions(current, floor) < 0) {
      fail(
        `native voice helper pins ${component.name} ${current.value}, below its advisory floor ${floor.value}. ` +
          `This C/C++ library is statically linked into every voice-enabled release binary. Bump the FetchContent ` +
          `pin in ${CMAKE_PATH} to a patched release, or correct the recorded floor after review.`,
      );
    }
  }

  if (process.argv.includes("--inventory-json")) {
    console.log(JSON.stringify(inventory));
    return;
  }

  console.log(
    `Native voice components meet their advisory floors ` +
      `(${components.map((c) => `${c.name}@${inventory[c.name]}`).join(", ")}). ` +
      `ggml is bundled within whisper.cpp at the same tag (covered transitively).`,
  );
}

main();
