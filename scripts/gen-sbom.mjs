#!/usr/bin/env node
// Generate a CycloneDX software bill of materials for Agav's production
// dependency graph or, with --dev, for its dev/build graph (the build and test
// dependencies used to produce the binaries, which never ship in them).
// Deterministic and pnpm-native: it reads the resolved tree from `pnpm list`
// rather than reconstructing it with an npm-only tool, because this repository
// installs with pnpm and has no npm lockfile for @cyclonedx/cyclonedx-npm to
// walk. Its only import beyond Node is `yaml`, a production dependency, to read
// pnpm-lock.yaml. Each component is emitted with its exact version, a
// package-URL (purl), the integrity hash pnpm-lock.yaml records for its tarball,
// the tarball URL pnpm resolved, and — read from the installed package's own
// package.json — its declared license (an SPDX id or expression where it is
// one, else the text as written) and source repository. Its purl doubles as its
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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { parseAllDocuments } from "yaml";

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

function manifestAt(pkgPath) {
  // The installed package's own package.json; a package pnpm lists but did
  // not install on this platform has none.
  try {
    return JSON.parse(readFileSync(resolve(pkgPath, "package.json"), "utf8"));
  } catch {
    return {};
  }
}

// CycloneDX 1.5 accepts a license `id` only from its SPDX list, so read the
// list from the 1.5 schema itself (scripts/cyclonedx, vendored unchanged), keyed
// lowercase because SPDX ids match case-insensitively.
const spdxIds = new Map(
  JSON.parse(readFileSync(new URL("cyclonedx/spdx.schema.json", import.meta.url), "utf8")).enum.map((id) => [
    id.toLowerCase(),
    id,
  ]),
);

// An SPDX license expression (SPDX 2.3 Annex D) over the 1.5 list: ids with an
// optional "+", LicenseRef- / DocumentRef-:LicenseRef- references, a license
// WITH an exception, AND / OR and parentheses, such as "(MIT OR Apache-2.0)".
// Returns it with every id in its canonical casing, or undefined when the text
// is not one. The 1.5 list holds exception ids beside license ids without
// telling them apart, so WITH accepts any id on it.
const LICENSE_REF = /^(?:DocumentRef-[A-Za-z0-9.-]+:)?LicenseRef-[A-Za-z0-9.-]+$/;
function spdxLicense(token) {
  if (LICENSE_REF.test(token)) return token;
  const lower = token.toLowerCase();
  if (spdxIds.has(lower)) return spdxIds.get(lower);
  return lower.endsWith("+") && spdxIds.has(lower.slice(0, -1)) ? `${spdxIds.get(lower.slice(0, -1))}+` : undefined;
}
function spdxExpression(text) {
  // next: what the token must be — "license", "exception", or an operator
  // ("simple" right after a license, which WITH may follow; "compound" otherwise).
  let depth = 0;
  let next = "license";
  const canonical = [];
  for (const token of text.match(/[()]|[^\s()]+/g) ?? []) {
    if (token === "(" && next === "license") depth += 1;
    else if (token === ")" && next !== "license" && next !== "exception" && depth > 0) {
      depth -= 1;
      next = "compound";
    } else if (next === "license" && spdxLicense(token)) {
      canonical.push(spdxLicense(token));
      next = "simple";
    } else if (next === "exception" && spdxIds.has(token.toLowerCase())) {
      canonical.push(spdxIds.get(token.toLowerCase()));
      next = "compound";
    } else if (next === "simple" && token === "WITH") {
      canonical.push(token);
      next = "exception";
    } else if ((next === "simple" || next === "compound") && (token === "AND" || token === "OR")) {
      canonical.push(token);
      next = "license";
    } else return undefined;
  }
  if (depth !== 0 || (next !== "simple" && next !== "compound")) return undefined;
  let i = 0;
  return text.replace(/[^\s()]+/g, () => canonical[i++]);
}

function licensesFor(declared) {
  // Absent or non-string fields (deprecated array form, objects) are left out
  // rather than guessed; the postmerge license-check job is the gate, not this.
  // Text that is no SPDX id or expression ("SEE LICENSE IN ...", "BSD") is kept
  // verbatim as a license name, never mapped to an id it might not mean.
  if (typeof declared !== "string" || !declared.trim()) return undefined;
  const text = declared.trim();
  const id = spdxIds.get(text.toLowerCase());
  if (id) return [{ license: { id } }];
  const expression = spdxExpression(text);
  if (expression) return [{ expression }];
  return [{ license: { name: text } }];
}

// pnpm-lock.yaml's `packages` map (name@version -> resolution), from which a
// component gets the integrity pnpm verified its tarball against. Without a
// lockfile there are no hashes to give; an unreadable or malformed one fails the
// run rather than silently drop every hash. pnpm may lead the file with an env
// lockfile document (its own pinned version), so the project's lockfile is the
// last document. A lockfile of a project with no dependencies has no `packages`;
// that is only an error once a component needs it (undefined, see addComponent).
function lockedPackages() {
  const file = resolve(root, "pnpm-lock.yaml");
  if (!existsSync(file)) return {};
  let lock;
  try {
    const documents = Array.from(parseAllDocuments(readFileSync(file, "utf8")));
    const [error] = documents.flatMap((document) => document.errors);
    if (error) throw error;
    lock = documents.at(-1)?.toJS();
  } catch (error) {
    fail(`Could not parse pnpm-lock.yaml: ${error instanceof Error ? error.message : String(error)}`);
  }
  const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isMap(lock) || (lock.packages !== undefined && !isMap(lock.packages))) {
    fail("pnpm-lock.yaml is malformed: expected a mapping with a packages map.");
  }
  return lock.packages;
}

// SRI integrity ("sha512-<base64>", possibly several, space-separated) as
// CycloneDX hashes, whose content is hex. An entry with an unknown algorithm or
// a digest of the wrong length is left out rather than recorded wrong.
const SRI_ALGORITHMS = { sha1: ["SHA-1", 20], sha256: ["SHA-256", 32], sha384: ["SHA-384", 48], sha512: ["SHA-512", 64] };
function hashesFor(integrity) {
  if (typeof integrity !== "string") return [];
  return integrity.trim().split(/\s+/).flatMap((entry) => {
    const match = /^(sha\d+)-([A-Za-z0-9+/]+={0,2})$/.exec(entry);
    const algorithm = match && Object.hasOwn(SRI_ALGORITHMS, match[1]) ? SRI_ALGORITHMS[match[1]] : undefined;
    if (!algorithm) return [];
    const digest = Buffer.from(match[2], "base64");
    return digest.length === algorithm[1] ? [{ alg: algorithm[0], content: digest.toString("hex") }] : [];
  });
}

// package.json `repository` as a URL: the url as declared, with npm's
// "owner/repo" and "github:" / "gitlab:" / "bitbucket:" shorthands expanded.
const REPOSITORY_HOSTS = { github: "https://github.com", gitlab: "https://gitlab.com", bitbucket: "https://bitbucket.org" };
function repositoryUrl(repository) {
  const declared = typeof repository === "string" ? repository : repository?.url;
  if (typeof declared !== "string" || !declared.trim()) return undefined;
  const shorthand = /^(?:(github|gitlab|bitbucket):)?([\w.-]+\/[\w.-]+)$/.exec(declared.trim());
  return shorthand ? `${REPOSITORY_HOSTS[shorthand[1] ?? "github"]}/${shorthand[2]}` : declared.trim();
}

// bom-ref -> the bom-refs it depends on, for the CycloneDX dependency graph.
// A package's purl is unique per name@version, so it serves as its bom-ref.
const rootRef = purlFor(rootPkg.name, rootPkg.version);
const edges = new Map([[rootRef, new Set()]]);
const locked = lockedPackages();

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
  if (!locked) fail(`pnpm-lock.yaml has no packages map, so ${key} would get no hash.`);
  const hashes = Object.hasOwn(locked, key) ? hashesFor(locked[key]?.resolution?.integrity) : [];
  if (hashes.length) component.hashes = hashes;
  const manifest = node.path ? manifestAt(node.path) : {};
  const licenses = licensesFor(manifest.license);
  if (licenses) component.licenses = licenses;
  const references = [];
  if (typeof node.resolved === "string" && node.resolved) references.push({ type: "distribution", url: node.resolved });
  const vcs = repositoryUrl(manifest.repository);
  if (vcs) references.push({ type: "vcs", url: vcs });
  if (references.length) component.externalReferences = references;
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
  if (deps === undefined) return;
  // A present map that is not an object would drop its subtree from a BOM
  // that still looks complete, so fail instead.
  if (deps === null || typeof deps !== "object" || Array.isArray(deps)) {
    fail(`\`pnpm list --json\` returned a malformed dependency map under ${parentRef}.`);
  }
  for (const [name, node] of Object.entries(deps)) {
    const ref = addComponent(name, node);
    edges.get(parentRef).add(ref);
    if (node.path) {
      if (walked.has(node.path)) continue;
      walked.add(node.path);
    }
    walk(node.dependencies === undefined ? printed.get(node.path) : node.dependencies, ref);
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

const rootLicenses = licensesFor(rootPkg.license);
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
      ...(rootLicenses ? { licenses: rootLicenses } : {}),
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
