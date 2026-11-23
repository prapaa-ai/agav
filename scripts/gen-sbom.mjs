#!/usr/bin/env node
// Generate a CycloneDX software bill of materials for Agav's production
// dependency graph or, with --dev, for its dev/build graph (the build and test
// dependencies used to produce the binaries, which never ship in them).
// Deterministic, pnpm-native, and dependency-free: it reads the resolved tree
// from `pnpm list` rather than reconstructing it with an npm-only tool, because
// this repository installs with pnpm and has no npm lockfile for
// @cyclonedx/cyclonedx-npm to walk. Each component is emitted with
// its exact version, a package-URL (purl), and — read from the installed
// package's own package.json — its declared license. Its purl doubles as its
// bom-ref, and the `dependencies` section records what each package, and the
// application itself, directly depends on.
//
// Scope and caveat: each BOM covers the npm dependency graph only. Agav ships a
// compiled binary that statically embeds the Bun runtime and its vendored C
// libraries (Brotli, c-ares, zlib, libarchive); those are invisible to the npm
// graph and are tracked separately by scripts/check-bun-advisories.mjs. The
// build BOM likewise leaves out the Bun compiler and the voice helper's native
// toolchain. The caveat is also recorded in the BOM's metadata.properties so a
// consumer reading the file alone is not misled into thinking it is exhaustive.
// Both BOMs list every optional platform package the lockfile resolves, such as
// esbuild's binary for each OS, whether or not this machine installed it.
//
// Usage: node scripts/gen-sbom.mjs [--dev] <output-file.cdx.json>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);

// Deterministic RFC 4122 v5 (SHA-1, name-based) UUID. A BOM's serialNumber is
// mandatory for the attestation action's CycloneDX detector, but a random one
// would break reproducibility, so derive it from the BOM's own content. Uses
// the URL namespace (6ba7b811-9dad-11d1-80b4-00c04fd430c8).
function uuidV5(name) {
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const hash = createHash("sha1").update(namespace).update(name, "utf8").digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const dev = process.argv[2] === "--dev";
const outFile = process.argv[dev ? 3 : 2];
if (!outFile || outFile.startsWith("-") || process.argv.length > (dev ? 4 : 3)) fail("Usage: node scripts/gen-sbom.mjs [--dev] <output-file.cdx.json>");

const root = process.cwd();
const rootPkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

// Resolve the dependency tree with pnpm. --depth Infinity walks the full
// transitive graph; --prod drops devDependencies, which is the surface that
// actually reaches users. The dev BOM lists without a filter and walks only the
// root's devDependencies, because --dev also drops optional edges, such as
// esbuild's platform binary.
let listRaw;
try {
  listRaw = execFileSync(
    "pnpm",
    ["list", ...(dev ? [] : ["--prod"]), "--depth", "Infinity", "--json"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
} catch (error) {
  fail(`pnpm list failed: ${error instanceof Error ? error.message : String(error)}`);
}

let projects;
try {
  projects = JSON.parse(listRaw);
} catch {
  fail("Could not parse `pnpm list --json` output.");
}

// Collect unique components keyed by name@version so a package appearing many
// times in the tree is emitted once. Walk every project and recurse through the
// nested `dependencies` maps pnpm produces.
const components = new Map();

function purlFor(name, version) {
  // pkg:npm/<name>@<version>; a scoped name keeps its leading @ but the slash is
  // percent-encoded per the purl spec.
  const encodedName = name.startsWith("@")
    ? `%40${encodeURIComponent(name.slice(1)).replace(/%2F/gi, "/")}`
    : encodeURIComponent(name).replace(/%2F/gi, "/");
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function licenseFor(pkgPath) {
  // Read the installed package's own package.json for its declared license.
  // Absent or non-string fields (deprecated array form, objects) are left out
  // rather than guessed; the postmerge license-check job is the gate, not this.
  try {
    const pkg = JSON.parse(readFileSync(resolve(pkgPath, "package.json"), "utf8"));
    if (typeof pkg.license === "string" && pkg.license.trim()) return pkg.license.trim();
  } catch {
    // Unreadable package.json: emit the component without a license entry.
  }
  return null;
}

// bom-ref -> the bom-refs it depends on, for the CycloneDX dependency graph.
// A package's purl is unique per name@version, so it serves as its bom-ref.
const rootRef = purlFor(rootPkg.name, rootPkg.version);
const edges = new Map([[rootRef, new Set()]]);

function addComponent(name, node) {
  // A listed package without a version is an incomplete tree, not one to skip.
  if (!node || typeof node.version !== "string") fail(`pnpm list gave no version for ${name}.`);
  const key = `${name}@${node.version}`;
  if (components.has(key)) return components.get(key).purl;
  const purl = purlFor(name, node.version);
  const component = {
    type: "library",
    "bom-ref": purl,
    name,
    version: node.version,
    purl,
  };
  const license = node.path ? licenseFor(node.path) : null;
  if (license) component.licenses = [{ license: { name: license } }];
  components.set(key, component);
  edges.set(purl, new Set());
  return purl;
}

// pnpm prints a package's subtree once per run and marks later copies
// `deduped`, without children; unfiltered, the printed copy may sit under the
// production graph. Index printed subtrees by install path (a peer variant has
// its own) so a deduped copy is followed, and walk each path once.
const printed = new Map();
function index(deps) {
  for (const node of Object.values(deps ?? {})) {
    if (node?.path && node.dependencies && !printed.has(node.path)) {
      printed.set(node.path, node.dependencies);
      index(node.dependencies);
    }
  }
}

const walked = new Set();
function walk(deps, parentRef) {
  if (!deps || typeof deps !== "object") return;
  for (const [name, node] of Object.entries(deps)) {
    const ref = addComponent(name, node);
    edges.get(parentRef).add(ref);
    if (node.path) {
      if (walked.has(node.path)) continue;
      walked.add(node.path);
    }
    walk(node.dependencies ?? printed.get(node.path), ref);
  }
}

const projectList = Array.isArray(projects) ? projects : [projects];
if (projectList.length === 0 || projectList.some((p) => !p || typeof p !== "object")) {
  fail("`pnpm list --json` returned no project.");
}
// pnpm list puts the root's optionalDependencies and devDependencies under
// their own keys.
const declaredKey = dev ? "devDependencies" : "dependencies";
for (const project of projectList) {
  for (const key of ["dependencies", "optionalDependencies", "devDependencies"]) index(project[key]);
}
for (const project of projectList) {
  walk(project[declaredKey], rootRef);
  if (!dev) walk(project.optionalDependencies, rootRef);
}

// pnpm list leaves out a declared dependency that is not installed, so check
// the root's own list against package.json rather than emit a partial BOM.
// Optional ones may be absent (skipped on this platform); a name in both maps
// is optional, as npm reads it, and pnpm lists it under optionalDependencies.
const listed = new Set(projectList.flatMap((p) => Object.keys(p[declaredKey] ?? {})));
const optional = rootPkg.optionalDependencies ?? {};
const missing = Object.keys(rootPkg[declaredKey] ?? {}).filter(
  (name) => !listed.has(name) && !Object.hasOwn(optional, name),
);
if (missing.length) {
  fail(`pnpm list is missing declared ${declaredKey}: ${missing.join(", ")}. Run pnpm install --frozen-lockfile first.`);
}

// Deterministic ordering so the same input always yields byte-identical output.
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortedComponents = [...components.values()].sort((a, b) => byString(a.purl, b.purl));
const dependencies = [...edges]
  .map(([ref, dependsOn]) => ({ ref, dependsOn: [...dependsOn].sort(byString) }))
  .sort((a, b) => byString(a.ref, b.ref));

const cyclonedxVersion = (() => {
  try {
    return require("@cyclonedx/cyclonedx-library/package.json").version;
  } catch {
    return undefined;
  }
})();

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: "", // Set below, from the rest of the document.
  version: 1,
  metadata: {
    // A reproducible BOM must not embed a wall-clock timestamp; omitting it
    // keeps the output byte-identical for a given dependency tree.
    tools: [
      {
        vendor: "agav",
        name: "gen-sbom.mjs",
        ...(cyclonedxVersion ? { version: cyclonedxVersion } : {}),
      },
    ],
    component: {
      type: "application",
      name: rootPkg.name,
      version: rootPkg.version,
      ...(rootPkg.description ? { description: rootPkg.description } : {}),
      ...(typeof rootPkg.license === "string" && rootPkg.license.trim()
        ? { licenses: [{ license: { name: rootPkg.license.trim() } }] }
        : {}),
      "bom-ref": rootRef,
      purl: rootRef,
    },
    ...(dev ? { lifecycles: [{ phase: "build" }] } : {}),
    properties: dev
      ? [
          {
            name: "agav:scope",
            value: "dev/build npm dependency graph only (devDependencies; not shipped in the binaries)",
          },
          {
            name: "agav:excludes",
            value: "the Bun compiler and the voice helper's native build toolchain (CMake, C/C++ compiler)",
          },
        ]
      : [
          {
            name: "agav:scope",
            value: "production npm dependency graph only",
          },
          {
            name: "agav:excludes",
            value:
              "embedded Bun runtime and vendored C libraries (Brotli, c-ares, zlib, libarchive) — tracked by scripts/check-bun-advisories.mjs",
          },
        ],
  },
  components: sortedComponents,
  dependencies,
};
// Derived from the whole document, so the same input always yields the same
// urn:uuid and the BOM stays byte-for-byte reproducible, while BOMs that differ
// only in mode or metadata (production vs build) never share one.
bom.serialNumber = `urn:uuid:${uuidV5(JSON.stringify(bom))}`;

writeFileSync(outFile, `${JSON.stringify(bom, null, 2)}\n`, "utf8");
console.log(
  `Wrote ${outFile}: ${sortedComponents.length} ${dev ? "dev/build" : "production"} components (CycloneDX ${bom.specVersion}).`,
);
