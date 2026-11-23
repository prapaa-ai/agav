import { spawnSync } from "node:child_process";
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
// fixtures/cyclonedx are copied unchanged from CycloneDX/specification at tag
// 1.5 (Apache-2.0).
//
// The fake pnpm is a shebang script, which Windows cannot exec, so the suite
// runs on POSIX only; CI runs it on ubuntu.

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts/gen-sbom.mjs");
const schemaDir = join(import.meta.dirname, "fixtures/cyclonedx");

type Node = { version?: string; path?: string; dependencies?: Record<string, Node> };

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
  function pkg(name: string, version: string, license?: string, peers = ""): string {
    const dir = join(repo, "store", `${name.replace("/", "+")}@${version}${peers}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, ...(license ? { license } : {}) }));
    return dir;
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
    expect(byName["direct-a"].licenses).toEqual([{ license: { name: "MIT" } }]);
    expect(byName["peer-f"].licenses).toEqual([{ license: { name: "MIT" } }]);
    expect(byName["optional-e"].licenses).toEqual([{ license: { name: "BSD-3-Clause" } }]);
    // No license field in its package.json, and none invented.
    expect(byName["@scope/direct-d"].licenses).toBeUndefined();

    expect(doc.metadata.component).toMatchObject({
      type: "application",
      name: "fixture-app",
      version: "1.2.3",
      purl: "pkg:npm/fixture-app@1.2.3",
      licenses: [{ license: { name: "Apache-2.0" } }],
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
