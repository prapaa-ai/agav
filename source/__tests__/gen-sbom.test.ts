import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { Ajv } from "ajv";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// gen-sbom.mjs turns `pnpm list --prod --depth Infinity --json` into the
// CycloneDX BOM the release attests, and with --dev turns the root's
// devDependencies in plain `pnpm list` into the separate build-dependency BOM.
// These tests run it against fixture trees through a fake `pnpm` first on PATH,
// then check the BOM against the CycloneDX 1.5 schema. The schemas in
// scripts/cyclonedx are copied unchanged from CycloneDX/specification at tag
// 1.5 (Apache-2.0); the generator reads its SPDX license ids from the same copy.
//
// The fake pnpm is a shebang script, which Windows cannot exec, so the suite
// runs on POSIX only; CI runs it on ubuntu.

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts/gen-sbom.mjs");
const schemaDir = join(root, "scripts/cyclonedx");

type Node = { version?: string; path?: string; resolved?: string; dependencies?: Record<string, Node> };

function validateBom(bom: unknown) {
  // Format keywords (iri-reference, idn-email) need ajv-formats, which is not a
  // direct dependency; the structure, types and required fields are checked.
  // The BOM uses no field with a format keyword.
  const ajv = new Ajv({ strict: false, validateFormats: false });
  for (const name of ["spdx.schema.json", "jsf-0.82.schema.json"]) {
    ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, name), "utf8")));
  }
  const validate = ajv.compile(JSON.parse(readFileSync(join(schemaDir, "bom-1.5.schema.json"), "utf8")));
  return { valid: validate(bom), errors: validate.errors };
}

describe.skipIf(process.platform === "win32")("gen-sbom", () => {
  let repo: string;
  let bin: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "agav-sbom-"));
    bin = join(repo, "bin");
    mkdirSync(bin);
    // Prints the fixture the test wrote, or fails like pnpm when told to.
    writeFileSync(
      join(bin, "pnpm"),
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'if (process.env.FAKE_PNPM_EXIT) { console.error("pnpm: broken"); process.exit(Number(process.env.FAKE_PNPM_EXIT)); }',
        'if (process.env.FAKE_PNPM_ARGS) fs.writeFileSync(process.env.FAKE_PNPM_ARGS, process.argv.slice(2).join(" "));',
        'process.stdout.write(fs.readFileSync(process.env.FAKE_PNPM_LIST, "utf8"));',
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "pnpm"), 0o755);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  // A package directory with its own package.json, as pnpm's `path` points at;
  // `peers` is the suffix pnpm adds to the folder of a package with peers.
  function pkg(name: string, version: string, license?: string, peers = "", fields: Record<string, unknown> = {}): string {
    const dir = join(repo, "store", `${name.replace("/", "+")}@${version}${peers}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, ...(license ? { license } : {}), ...fields }));
    return dir;
  }

  // pnpm-lock.yaml as pnpm 10 writes it: one `packages` entry per name@version,
  // its resolution carrying the SRI integrity of the registry tarball.
  function writeLock(integrity: Record<string, string>) {
    const entries = Object.entries(integrity).map(([key, sri]) => `  '${key}':\n    resolution: {integrity: ${sri}}\n`);
    writeFileSync(join(repo, "pnpm-lock.yaml"), `lockfileVersion: '9.0'\n\npackages:\n\n${entries.join("\n")}`);
  }

  // An SRI string and the hex digest CycloneDX records for it.
  function sri(alg: "sha1" | "sha512", content: string) {
    const hash = () => createHash(alg).update(content);
    return { integrity: `${alg}-${hash().digest("base64")}`, hex: hash().digest("hex") };
  }

  function writeRepo(
    dependencies: Record<string, string>,
    list: unknown,
    optionalDependencies?: Record<string, string>,
    devDependencies?: Record<string, string>,
  ) {
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "fixture-app",
        version: "1.2.3",
        description: "A fixture.",
        license: "Apache-2.0",
        dependencies,
        ...(optionalDependencies ? { optionalDependencies } : {}),
        ...(devDependencies ? { devDependencies } : {}),
      }),
    );
    writeFileSync(join(repo, "list.json"), typeof list === "string" ? list : JSON.stringify(list));
  }

  function run(env: Record<string, string> = {}, flags: string[] = []) {
    const out = join(repo, "bom.cdx.json");
    const result = spawnSync(process.execPath, [script, ...flags, out], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_PNPM_LIST: join(repo, "list.json"), ...env },
    });
    return { ...result, out };
  }

  function bom(out: string) {
    return JSON.parse(readFileSync(out, "utf8"));
  }

  // As pnpm lists them: direct-a pulls in transitive-b and shared-c@3.0.0,
  // transitive-b pulls in shared-c@3.1.0, and @scope/direct-d lists shared-c@3.0.0
  // again (deduped) and its peer peer-f, which the root also depends on; pnpm
  // puts the peer in the name of direct-d's folder. optional-e is the root's
  // optional dependency, listed under its own key.
  function graph(): unknown {
    const shared: Node = { version: "3.0.0", path: pkg("shared-c", "3.0.0", "ISC") };
    const peer: Node = { version: "6.0.0", path: pkg("peer-f", "6.0.0", "MIT") };
    return [
      {
        name: "fixture-app",
        version: "1.2.3",
        path: repo,
        dependencies: {
          "direct-a": {
            version: "1.0.0",
            path: pkg("direct-a", "1.0.0", "MIT"),
            dependencies: {
              "transitive-b": {
                version: "2.0.0",
                path: pkg("transitive-b", "2.0.0", "MIT"),
                dependencies: { "shared-c": { version: "3.1.0", path: pkg("shared-c", "3.1.0", "ISC") } },
              },
              "shared-c": shared,
            },
          },
          "@scope/direct-d": {
            version: "4.0.0",
            path: pkg("@scope/direct-d", "4.0.0", undefined, "_peer-f@6.0.0"),
            dependencies: { "shared-c": { ...shared, deduped: true }, "peer-f": peer },
          },
          "peer-f": peer,
        },
        optionalDependencies: { "optional-e": { version: "5.0.0", path: pkg("optional-e", "5.0.0", "BSD-3-Clause") } },
      },
    ];
  }

  const declared = { "direct-a": "^1.0.0", "@scope/direct-d": "^4.0.0", "peer-f": "^6.0.0" };

  it("emits every direct, transitive, peer and optional package once, as valid CycloneDX 1.5", () => {
    writeRepo(declared, graph(), { "optional-e": "^5.0.0" });
    const result = run();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const doc = bom(result.out);

    expect(doc.components.map((c: { purl: string }) => c.purl)).toEqual([
      "pkg:npm/%40scope/direct-d@4.0.0",
      "pkg:npm/direct-a@1.0.0",
      "pkg:npm/optional-e@5.0.0",
      "pkg:npm/peer-f@6.0.0",
      "pkg:npm/shared-c@3.0.0",
      "pkg:npm/shared-c@3.1.0",
      "pkg:npm/transitive-b@2.0.0",
    ]);
    const byName = Object.fromEntries(doc.components.map((c: { name: string }) => [c.name, c]));
    expect(byName["direct-a"].licenses).toEqual([{ license: { id: "MIT" } }]);
    expect(byName["peer-f"].licenses).toEqual([{ license: { id: "MIT" } }]);
    expect(byName["optional-e"].licenses).toEqual([{ license: { id: "BSD-3-Clause" } }]);
    // No license field in its package.json, and none invented.
    expect(byName["@scope/direct-d"].licenses).toBeUndefined();
    // No lockfile and no resolved URL in this tree: no hashes or references made up.
    expect(byName["direct-a"].hashes).toBeUndefined();
    expect(byName["direct-a"].externalReferences).toBeUndefined();

    expect(doc.metadata.component).toMatchObject({
      type: "application",
      name: "fixture-app",
      version: "1.2.3",
      purl: "pkg:npm/fixture-app@1.2.3",
      licenses: [{ license: { id: "Apache-2.0" } }],
    });
    expect(doc.metadata.timestamp).toBeUndefined();
    expect(doc.metadata.properties.map((p: { name: string }) => p.name)).toEqual(["agav:scope", "agav:excludes"]);
    expect(doc.serialNumber).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const { valid, errors } = validateBom(doc);
    expect(errors).toBeNull();
    expect(valid).toBe(true);
    // The schema check is not vacuous: an unknown component type is rejected.
    expect(validateBom({ ...doc, components: [{ ...doc.components[0], type: "lib" }] }).valid).toBe(false);
  });

  function dependencyMap(doc: { dependencies: Array<{ ref: string; dependsOn: string[] }> }) {
    return Object.fromEntries(doc.dependencies.map((d) => [d.ref, d.dependsOn]));
  }

  it("gives every package a bom-ref and records its direct and transitive dependencies", () => {
    writeRepo(declared, graph(), { "optional-e": "^5.0.0" });
    const result = run();
    expect(result.status).toBe(0);
    const doc = bom(result.out);

    for (const c of doc.components) expect(c["bom-ref"]).toBe(c.purl);
    expect(doc.metadata.component["bom-ref"]).toBe("pkg:npm/fixture-app@1.2.3");
    // One entry per package and the application, each listing what it pulls in;
    // shared-c@3.0.0 is listed twice in the tree (once deduped) but edged once.
    expect(doc.dependencies.map((d: { ref: string }) => d.ref)).toEqual([
      "pkg:npm/%40scope/direct-d@4.0.0",
      "pkg:npm/direct-a@1.0.0",
      "pkg:npm/fixture-app@1.2.3",
      "pkg:npm/optional-e@5.0.0",
      "pkg:npm/peer-f@6.0.0",
      "pkg:npm/shared-c@3.0.0",
      "pkg:npm/shared-c@3.1.0",
      "pkg:npm/transitive-b@2.0.0",
    ]);
    expect(dependencyMap(doc)).toEqual({
      "pkg:npm/fixture-app@1.2.3": [
        "pkg:npm/%40scope/direct-d@4.0.0",
        "pkg:npm/direct-a@1.0.0",
        "pkg:npm/optional-e@5.0.0",
        "pkg:npm/peer-f@6.0.0",
      ],
      "pkg:npm/%40scope/direct-d@4.0.0": ["pkg:npm/peer-f@6.0.0", "pkg:npm/shared-c@3.0.0"],
      "pkg:npm/direct-a@1.0.0": ["pkg:npm/shared-c@3.0.0", "pkg:npm/transitive-b@2.0.0"],
      "pkg:npm/transitive-b@2.0.0": ["pkg:npm/shared-c@3.1.0"],
      "pkg:npm/optional-e@5.0.0": [],
      "pkg:npm/peer-f@6.0.0": [],
      "pkg:npm/shared-c@3.0.0": [],
      "pkg:npm/shared-c@3.1.0": [],
    });

    const { valid, errors } = validateBom(doc);
    expect(errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("records the lockfile integrity as hashes, and the tarball and source repository as references", () => {
    const a = sri("sha512", "direct-a tarball");
    const b = sri("sha1", "transitive-b tarball");
    const c = sri("sha512", "shared-c tarball");
    const registry = (name: string, version: string) => `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`;
    const tree = [
      {
        name: "fixture-app",
        version: "1.2.3",
        path: repo,
        dependencies: {
          "direct-a": {
            version: "1.0.0",
            resolved: registry("direct-a", "1.0.0"),
            path: pkg("direct-a", "1.0.0", "MIT", "", { repository: "owner/direct-a" }),
            dependencies: {
              "transitive-b": {
                version: "2.0.0",
                resolved: registry("transitive-b", "2.0.0"),
                path: pkg("transitive-b", "2.0.0", "MIT", "", { repository: { type: "git", url: "git+https://github.com/owner/transitive-b.git" } }),
              },
            },
          },
          "@scope/direct-d": {
            version: "4.0.0",
            resolved: registry("@scope/direct-d", "4.0.0"),
            path: pkg("@scope/direct-d", "4.0.0", "MIT", "", { repository: "gitlab:owner/direct-d" }),
            dependencies: { "shared-c": { version: "3.0.0", resolved: registry("shared-c", "3.0.0"), path: pkg("shared-c", "3.0.0", "ISC") } },
          },
          // Not in the lockfile and no resolved URL: listed without either.
          "peer-f": { version: "6.0.0", path: pkg("peer-f", "6.0.0", "MIT") },
        },
      },
    ];
    writeRepo(declared, tree);
    // transitive-b carries a legacy sha1 next to a sha512, as old packages do.
    const b512 = sri("sha512", "transitive-b tarball");
    writeLock({
      "direct-a@1.0.0": a.integrity,
      "transitive-b@2.0.0": `${b.integrity} ${b512.integrity}`,
      "shared-c@3.0.0": c.integrity,
      "@scope/direct-d@4.0.0": "sha512-not*base64",
    });
    const result = run();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const doc = bom(result.out);
    const byName = Object.fromEntries(doc.components.map((x: { name: string }) => [x.name, x]));

    expect(byName["direct-a"].hashes).toEqual([{ alg: "SHA-512", content: a.hex }]);
    expect(byName["transitive-b"].hashes).toEqual([
      { alg: "SHA-1", content: b.hex },
      { alg: "SHA-512", content: b512.hex },
    ]);
    expect(byName["shared-c"].hashes).toEqual([{ alg: "SHA-512", content: c.hex }]);
    // A malformed integrity is left out, not decoded into a wrong digest.
    expect(byName["@scope/direct-d"].hashes).toBeUndefined();
    expect(byName["peer-f"].hashes).toBeUndefined();

    expect(byName["direct-a"].externalReferences).toEqual([
      { type: "distribution", url: "https://registry.npmjs.org/direct-a/-/direct-a-1.0.0.tgz" },
      { type: "vcs", url: "https://github.com/owner/direct-a" },
    ]);
    expect(byName["transitive-b"].externalReferences).toEqual([
      { type: "distribution", url: "https://registry.npmjs.org/transitive-b/-/transitive-b-2.0.0.tgz" },
      { type: "vcs", url: "git+https://github.com/owner/transitive-b.git" },
    ]);
    expect(byName["@scope/direct-d"].externalReferences).toEqual([
      { type: "distribution", url: "https://registry.npmjs.org/@scope/direct-d/-/direct-d-4.0.0.tgz" },
      { type: "vcs", url: "https://gitlab.com/owner/direct-d" },
    ]);
    // No repository field: the tarball only.
    expect(byName["shared-c"].externalReferences).toEqual([
      { type: "distribution", url: "https://registry.npmjs.org/shared-c/-/shared-c-3.0.0.tgz" },
    ]);
    expect(byName["peer-f"].externalReferences).toBeUndefined();

    const { valid, errors } = validateBom(doc);
    expect(errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("fails on a lockfile it cannot parse, rather than drop every hash", () => {
    writeRepo(declared, graph());
    writeFileSync(join(repo, "pnpm-lock.yaml"), "packages:\n  'direct-a@1.0.0': {resolution: [\n");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not parse pnpm-lock.yaml");
  });

  it("reads the project lockfile after a leading env lockfile document", () => {
    // pnpm 11+ may put its env lockfile (pnpm's own pin) first in pnpm-lock.yaml.
    writeRepo(declared, graph());
    const pnpm = sri("sha512", "pnpm tarball");
    const a = sri("sha512", "direct-a tarball");
    writeFileSync(
      join(repo, "pnpm-lock.yaml"),
      `---\nlockfileVersion: '9.0'\n\nimporters:\n  .:\n    packageManagerDependencies:\n      pnpm: {specifier: 12.0.0, version: 12.0.0}\n\npackages:\n  'pnpm@12.0.0':\n    resolution: {integrity: ${pnpm.integrity}}\n` +
        `---\nlockfileVersion: '9.0'\n\npackages:\n  'direct-a@1.0.0':\n    resolution: {integrity: ${a.integrity}}\n`,
    );
    const result = run();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const directA = bom(result.out).components.find((x: { name: string }) => x.name === "direct-a");
    expect(directA.hashes).toEqual([{ alg: "SHA-512", content: a.hex }]);
  });

  it.each([
    ["an empty file", ""],
    ["no packages map", "lockfileVersion: '9.0'\n"],
    ["a null packages map", "lockfileVersion: '9.0'\npackages:\n"],
    ["a list for packages", "lockfileVersion: '9.0'\npackages: [direct-a@1.0.0]\n"],
    ["a scalar document", "just text\n"],
  ])("fails on a lockfile with %s, rather than emit a BOM without hashes", (_, content) => {
    writeRepo(declared, graph());
    writeFileSync(join(repo, "pnpm-lock.yaml"), content);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pnpm-lock.yaml");
    expect(existsSync(result.out)).toBe(false);
  });

  it("emits SPDX ids and expressions, and keeps any other license text as written", () => {
    const licensed: Array<[string, string]> = [
      ["lower-id", "mit"],
      ["either", "(MIT OR Apache-2.0)"],
      ["both", "Apache-2.0 AND BSD-3-Clause"],
      ["see-file", "SEE LICENSE IN LICENSE.md"],
      ["vague", "BSD"],
      ["unknown-in-expression", "MIT OR Nonsense-1.0"],
      ["dangling", "MIT OR"],
      ["lower-expression", "(mit OR apache-2.0)"],
      ["with-exception", "apache-2.0 WITH llvm-exception"],
      ["or-later", "(LGPL-2.1-only+ OR MIT)"],
      ["license-ref", "LicenseRef-Acme-EULA"],
      ["document-ref", "MIT AND DocumentRef-spdx-tool-1.2:LicenseRef-MIT-Style-2"],
      ["with-unknown", "MIT WITH Nonsense-exception"],
      ["with-after-group", "(MIT OR ISC) WITH LLVM-exception"],
      ["empty-ref", "LicenseRef-"],
    ];
    const deps = Object.fromEntries(licensed.map(([name, license]) => [name, { version: "1.0.0", path: pkg(name, "1.0.0", license) }]));
    writeRepo(Object.fromEntries(licensed.map(([name]) => [name, "^1.0.0"])), [{ name: "fixture-app", version: "1.2.3", path: repo, dependencies: deps }]);
    const result = run();
    expect(result.status).toBe(0);
    const doc = bom(result.out);
    const licenses = Object.fromEntries(doc.components.map((x: { name: string; licenses: unknown }) => [x.name, x.licenses]));

    expect(licenses).toEqual({
      "lower-id": [{ license: { id: "MIT" } }],
      either: [{ expression: "(MIT OR Apache-2.0)" }],
      both: [{ expression: "Apache-2.0 AND BSD-3-Clause" }],
      "see-file": [{ license: { name: "SEE LICENSE IN LICENSE.md" } }],
      vague: [{ license: { name: "BSD" } }],
      "unknown-in-expression": [{ license: { name: "MIT OR Nonsense-1.0" } }],
      dangling: [{ license: { name: "MIT OR" } }],
      // Ids in their canonical casing.
      "lower-expression": [{ expression: "(MIT OR Apache-2.0)" }],
      "with-exception": [{ expression: "Apache-2.0 WITH LLVM-exception" }],
      "or-later": [{ expression: "(LGPL-2.1-only+ OR MIT)" }],
      "license-ref": [{ expression: "LicenseRef-Acme-EULA" }],
      "document-ref": [{ expression: "MIT AND DocumentRef-spdx-tool-1.2:LicenseRef-MIT-Style-2" }],
      "with-unknown": [{ license: { name: "MIT WITH Nonsense-exception" } }],
      // WITH applies to a single license, not a group.
      "with-after-group": [{ license: { name: "(MIT OR ISC) WITH LLVM-exception" } }],
      "empty-ref": [{ license: { name: "LicenseRef-" } }],
    });
    const { valid, errors } = validateBom(doc);
    expect(errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("writes byte-identical output for the same tree, whatever order pnpm lists it in", () => {
    writeRepo(declared, graph());
    const first = run();
    expect(first.status).toBe(0);
    const firstBytes = readFileSync(first.out, "utf8");
    expect(readFileSync(run().out, "utf8")).toBe(firstBytes);

    const reversed = graph() as Array<{ dependencies: Record<string, Node> }>;
    reversed[0].dependencies = Object.fromEntries(Object.entries(reversed[0].dependencies).reverse());
    writeRepo(declared, reversed);
    expect(readFileSync(run().out, "utf8")).toBe(firstBytes);
  });

  it("fails when a declared dependency is missing from the listed tree", () => {
    writeRepo({ ...declared, "left-pad": "^1.3.0" }, graph());
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing declared dependencies: left-pad");
    expect(existsSync(result.out)).toBe(false);
  });

  it("fails without writing a BOM when required production dependencies resolve to no components", () => {
    writeRepo(declared, [{ dependencies: {} }]);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing declared dependencies:");
    expect(result.stderr).toContain("@scope/direct-d");
    expect(existsSync(result.out)).toBe(false);
  });

  it("allows an empty production graph with no required production dependencies", () => {
    writeRepo({ optional: "^1.0.0" }, { dependencies: {} }, { optional: "^1.0.0" });
    const result = run();
    expect(result.status).toBe(0);
    expect(bom(result.out).components).toEqual([]);
  });

  it("takes a name declared in both maps as optional, listed or not", () => {
    // pnpm lists such a package under optionalDependencies; on a platform
    // that skips it, it is not listed at all.
    const both = { ...declared, "optional-e": "^5.0.0" };
    writeRepo(both, graph(), { "optional-e": "^5.0.0" });
    const listedRun = run();
    expect(listedRun.stderr).toBe("");
    expect(listedRun.status).toBe(0);
    expect(bom(listedRun.out).components.map((c: { name: string }) => c.name)).toContain("optional-e");

    const skipped = graph() as Array<{ optionalDependencies?: Record<string, Node> }>;
    delete skipped[0].optionalDependencies;
    writeRepo(both, skipped, { "optional-e": "^5.0.0" });
    expect(run().status).toBe(0);
  });

  it("fails when a listed package has no version", () => {
    const tree = graph() as Array<{ dependencies: Record<string, Node> }>;
    delete tree[0].dependencies["direct-a"].dependencies!["transitive-b"].version;
    writeRepo(declared, tree);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no version for transitive-b");
  });

  it.each([
    ["a string", "corrupt"],
    ["an array", []],
    ["null", null],
  ])("fails when a nested dependency map is %s", (_label, deps) => {
    const tree = graph() as Array<{ dependencies: Record<string, Record<string, unknown>> }>;
    tree[0].dependencies["direct-a"].dependencies = deps;
    writeRepo(declared, tree);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("malformed dependency map");
  });

  it.each([
    ["truncated JSON", '[{"name": "fixture-app", "dependencies": {"direct-a": {'],
    ["no JSON at all", "ERR_PNPM_SOMETHING"],
  ])("fails on %s", (_label, list) => {
    writeRepo(declared, list);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not parse `pnpm list --json` output.");
  });

  it.each([
    ["an empty list", []],
    ["null", null],
  ])("fails when pnpm lists no project (%s)", (_label, list) => {
    writeRepo(declared, list);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("returned no project");
  });

  it("asks pnpm for the production graph by default", () => {
    writeRepo(declared, graph());
    const args = join(repo, "args.txt");
    expect(run({ FAKE_PNPM_ARGS: args }).status).toBe(0);
    expect(readFileSync(args, "utf8")).toBe("list --prod --depth Infinity --json");
  });

  // As plain `pnpm list` lists them: the production graph, then the dev graph.
  // pnpm prints a subtree once per run, so transitive-b comes back under
  // test-runner deduped, without the shared-c@3.1.0 it pulls in.
  function devGraph(): unknown {
    const [project] = graph() as Array<{ dependencies: Record<string, Node> }>;
    const printed = project.dependencies["direct-a"].dependencies!["transitive-b"];
    return [
      {
        ...project,
        devDependencies: {
          "test-runner": {
            version: "7.0.0",
            path: pkg("test-runner", "7.0.0", "MIT"),
            dependencies: {
              "transitive-b": { version: "2.0.0", path: printed.path, deduped: true, dedupedDependenciesCount: 1 },
            },
          },
          "@types/fixture": { version: "8.0.0", path: pkg("@types/fixture", "8.0.0", "MIT") },
        },
      },
    ];
  }

  const declaredDev = { "test-runner": "^7.0.0", "@types/fixture": "^8.0.0" };

  it("with --dev, writes the dev/build graph as a separate build-phase BOM", () => {
    writeRepo(declared, devGraph(), { "optional-e": "^5.0.0" }, declaredDev);
    const args = join(repo, "args.txt");
    const result = run({ FAKE_PNPM_ARGS: args }, ["--dev"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    // No --dev: pnpm's --dev also drops optional edges, such as esbuild's platform binary.
    expect(readFileSync(args, "utf8")).toBe("list --depth Infinity --json");
    expect(result.stdout).toContain("4 dev/build components");
    const doc = bom(result.out);

    // Only the dev graph, with the deduped copy followed to shared-c@3.1.0.
    expect(doc.components.map((c: { purl: string }) => c.purl)).toEqual([
      "pkg:npm/%40types/fixture@8.0.0",
      "pkg:npm/shared-c@3.1.0",
      "pkg:npm/test-runner@7.0.0",
      "pkg:npm/transitive-b@2.0.0",
    ]);
    // The deduped transitive-b keeps the edge to shared-c@3.1.0 from its printed copy.
    expect(dependencyMap(doc)).toEqual({
      "pkg:npm/fixture-app@1.2.3": ["pkg:npm/%40types/fixture@8.0.0", "pkg:npm/test-runner@7.0.0"],
      "pkg:npm/%40types/fixture@8.0.0": [],
      "pkg:npm/shared-c@3.1.0": [],
      "pkg:npm/test-runner@7.0.0": ["pkg:npm/transitive-b@2.0.0"],
      "pkg:npm/transitive-b@2.0.0": ["pkg:npm/shared-c@3.1.0"],
    });
    expect(doc.metadata.lifecycles).toEqual([{ phase: "build" }]);
    const scope = doc.metadata.properties.find((p: { name: string }) => p.name === "agav:scope");
    expect(scope.value).toContain("dev/build");

    const { valid, errors } = validateBom(doc);
    expect(errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("with --dev, fails when a declared devDependency is missing from the listed tree", () => {
    writeRepo(declared, devGraph(), undefined, { ...declaredDev, "lint-tool": "^1.0.0" });
    const result = run({}, ["--dev"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing declared devDependencies: lint-tool");
  });

  it("with --dev, keeps the platform packages pnpm lists but did not install", () => {
    // pnpm lists every platform variant the lockfile resolves; for one it
    // skipped on this platform, `path` points at a folder that does not exist.
    // The variants here are esbuild's binaries for the five release targets.
    const skipped = ["darwin-arm64", "darwin-x64", "linux-arm64", "win32-x64"].map((target) => ({
      name: `@esbuild/${target}`,
      path: join(repo, "store", `@esbuild+${target}@0.28.2`),
    }));
    const variants: Record<string, Node> = {
      "@esbuild/linux-x64": { version: "0.28.2", path: pkg("@esbuild/linux-x64", "0.28.2", "MIT") },
      ...Object.fromEntries(skipped.map(({ name, path }) => [name, { version: "0.28.2", path }])),
    };
    const esbuild: Node = { version: "0.28.2", path: pkg("esbuild", "0.28.2", "MIT"), dependencies: variants };
    writeRepo({}, [{ name: "fixture-app", version: "1.2.3", path: repo, devDependencies: { esbuild } }], undefined, {
      esbuild: "^0.28.2",
    });
    const result = run({}, ["--dev"]);
    expect(result.status).toBe(0);
    for (const { path } of skipped) expect(existsSync(path)).toBe(false);

    // All five listed; the skipped ones have no package.json to read a license from.
    const doc = bom(result.out);
    expect(doc.components.map((c: { name: string; licenses?: unknown }) => [c.name, c.licenses !== undefined])).toEqual([
      ["@esbuild/darwin-arm64", false],
      ["@esbuild/darwin-x64", false],
      ["@esbuild/linux-arm64", false],
      ["@esbuild/linux-x64", true],
      ["@esbuild/win32-x64", false],
      ["esbuild", true],
    ]);
  });

  it("gives a production and a build BOM of the same components different serial numbers", () => {
    const solo = () => ({ solo: { version: "1.0.0", path: pkg("solo", "1.0.0", "MIT") } });
    writeRepo({ solo: "^1.0.0" }, [{ name: "fixture-app", version: "1.2.3", path: repo, dependencies: solo() }]);
    const prod = run();
    expect(prod.status).toBe(0);
    const prodDoc = bom(prod.out);

    writeRepo({}, [{ name: "fixture-app", version: "1.2.3", path: repo, devDependencies: solo() }], undefined, {
      solo: "^1.0.0",
    });
    const build = run({}, ["--dev"]);
    expect(build.status).toBe(0);
    const buildDoc = bom(build.out);

    expect(buildDoc.components).toEqual(prodDoc.components);
    expect(buildDoc.serialNumber).not.toBe(prodDoc.serialNumber);
  });

  it("fails when pnpm list itself fails", () => {
    writeRepo(declared, graph());
    const result = run({ FAKE_PNPM_EXIT: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pnpm list failed");
  });
});
