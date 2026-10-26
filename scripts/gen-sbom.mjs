#!/usr/bin/env node
// Generate a CycloneDX software bill of materials for Agav's production
// dependency graph. Deterministic, pnpm-native, and dependency-free: it reads
// the resolved tree from `pnpm list --prod` rather than reconstructing it with
// an npm-only tool, because this repository installs with pnpm and has no npm
// lockfile for @cyclonedx/cyclonedx-npm to walk. Each component is emitted with
// its exact version, a package-URL (purl), and — read from the installed
// package's own package.json — its declared license.
//
// Scope and caveat: this BOM covers the npm dependency graph only. Agav ships a
// compiled binary that statically embeds the Bun runtime and its vendored C
// libraries (Brotli, c-ares, zlib, libarchive); those are invisible to the npm
// graph and are tracked separately by scripts/check-bun-advisories.mjs. The
// caveat is also recorded in the BOM's metadata.properties so a consumer
// reading the file alone is not misled into thinking it is exhaustive.
//
// Usage: node scripts/gen-sbom.mjs <output-file.cdx.json>
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);

function fail(message) {
  console.error(message);
  process.exit(1);
}

const outFile = process.argv[2];
if (!outFile) fail("Usage: node scripts/gen-sbom.mjs <output-file.cdx.json>");

const root = process.cwd();
const rootPkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

// Resolve the production dependency tree with pnpm. --depth Infinity walks the
// full transitive graph; --prod drops devDependencies, which is the surface
// that actually reaches users.
let listRaw;
try {
  listRaw = execFileSync(
    "pnpm",
    ["list", "--prod", "--depth", "Infinity", "--json"],
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

function addComponent(name, node) {
  if (!name || !node || typeof node.version !== "string") return;
  const key = `${name}@${node.version}`;
  if (components.has(key)) return;
  const component = {
    type: "library",
    name,
    version: node.version,
    purl: purlFor(name, node.version),
  };
  const license = node.path ? licenseFor(node.path) : null;
  if (license) component.licenses = [{ license: { name: license } }];
  components.set(key, component);
}

function walk(deps) {
  if (!deps || typeof deps !== "object") return;
  for (const [name, node] of Object.entries(deps)) {
    addComponent(name, node);
    if (node && typeof node === "object") walk(node.dependencies);
  }
}

for (const project of Array.isArray(projects) ? projects : [projects]) {
  walk(project.dependencies);
}

// Deterministic ordering so the same input always yields byte-identical output.
const sortedComponents = [...components.values()].sort((a, b) =>
  a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0,
);

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
      purl: purlFor(rootPkg.name, rootPkg.version),
    },
    properties: [
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
};

writeFileSync(outFile, `${JSON.stringify(bom, null, 2)}\n`, "utf8");
console.log(
  `Wrote ${outFile}: ${sortedComponents.length} production components (CycloneDX ${bom.specVersion}).`,
);
