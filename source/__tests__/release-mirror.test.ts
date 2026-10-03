import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const workflow = parse(await readFile(join(root, ".github/workflows/release.yml"), "utf8"));
const step = workflow.jobs.release.steps.find((s: { name?: string }) => s.name === "Mirror release assets to R2");

// Offline by default. Opt in to exercise the identical workflow with the real
// npm installer + SDK against a loopback S3 server, never a real R2 bucket.
const realNpm = process.env.AGAV_TEST_REAL_NPM === "1";

describe("release mirror workflow", () => {
  let fixture: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), "agav-mirror-test-"));
    await mkdir(join(fixture, "scripts"));
    await mkdir(join(fixture, "release assets"));
    await mkdir(join(fixture, "runner temp"));
    await mkdir(join(fixture, "bin"));
    await cp(join(root, "scripts/mirror-release-to-r2.mjs"), join(fixture, "scripts/mirror-release-to-r2.mjs"));
    // A root install must fail instead of silently resolving this poison graph.
    await writeFile(join(fixture, "package.json"), '{"dependencies":{"must-not-install":"file:missing"}}');
    await writeFile(join(fixture, "pnpm-lock.yaml"), "unchanged\n");
    await mkdir(join(fixture, "home"));
    await writeFile(join(fixture, "npmrc"), "");
    await writeFile(join(fixture, "global-npmrc"), "");
    // Do not inherit secrets, NODE_OPTIONS (--env-file), or user npm config.
    env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      HOME: join(fixture, "home"), USERPROFILE: join(fixture, "home"),
      npm_config_userconfig: join(fixture, "npmrc"),
      npm_config_globalconfig: join(fixture, "global-npmrc"),
      npm_config_cache: join(fixture, "npm-cache"),
      RUNNER_TEMP: join(fixture, "runner temp"), TAG: "v0.2.3-beta.2",
      R2_ACCOUNT_ID: "test", R2_ACCESS_KEY_ID: "test", R2_SECRET_ACCESS_KEY: "test", R2_BUCKET: "test",
      R2_ENDPOINT: "http://127.0.0.1:1" };
    if (!realNpm) {
      await writeFile(join(fixture, "bin/npm"), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
if (!args.includes('--prefix') || path.resolve(prefix) === process.cwd()) process.exit(90);
const dir = path.join(prefix, 'node_modules/@aws-sdk/client-s3');
fs.mkdirSync(dir, {recursive:true});
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module","main":"index.js"}');
fs.writeFileSync(path.join(dir, 'index.js'), \`export class PutObjectCommand { constructor(input) { this.input = input; } }
export class HeadObjectCommand { constructor(input) { this.input = input; } }
export class S3Client {
 constructor(config) { this.endpoint = config.endpoint; }
 async send(command) {
  const i = command.input;
  const res = await fetch(this.endpoint + '/' + i.Bucket + '/' + i.Key, {
   method: command instanceof PutObjectCommand ? 'PUT' : 'HEAD',
   body: command instanceof PutObjectCommand ? i.Body : undefined,
   headers: command instanceof PutObjectCommand ? {'content-type':i.ContentType, 'cache-control':i.CacheControl} : {}
  });
  if (!res.ok) throw Object.assign(new Error('missing'), {name:'NotFound'});
  return {ContentLength:res.headers.get('content-length')};
 }
}\`);
`, { mode: 0o755 });
      env.PATH = `${join(fixture, "bin")}:${process.env.PATH}`;
    }
  });

  afterEach(async () => { await rm(fixture, { recursive: true, force: true }); });

  async function run() {
    try {
      return { ...(await exec("bash", ["-e", "-o", "pipefail", "-c", step.run], { cwd: fixture, env, timeout: 120_000 })), code: 0 };
    } catch (error: any) {
      return { stdout: String(error.stdout), stderr: String(error.stderr), code: error.code };
    }
  }

  async function unchanged() {
    expect(await readFile(join(fixture, "package.json"), "utf8")).toContain("must-not-install");
    expect(await readFile(join(fixture, "pnpm-lock.yaml"), "utf8")).toBe("unchanged\n");
    expect(await readdir(join(fixture, "runner temp"))).toEqual([]);
    expect(await readdir(fixture)).not.toContain("node_modules");
    expect(await readdir(fixture)).not.toContain("package-lock.json");
  }

  it("serves both beta and stable releases with the same mirror step", () => {
    expect(workflow.on.push.branches).toEqual(["main", "beta"]);
    expect(step.env.TAG).toBe("v${{ needs.check-version.outputs.version }}");
    expect(workflow.jobs.release.steps.findIndex((s: { name?: string }) => s.name === "Create GitHub Release"))
      .toBeLessThan(workflow.jobs.release.steps.indexOf(step));
  });

  it("skips before installing anything when credentials are absent", async () => {
    env.R2_ACCESS_KEY_ID = "";
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("skipping R2 mirror");
    await unchanged();
  });

  it("runs the copied script and fails validation without attempting upload", async () => {
    env.R2_ACCOUNT_ID = "";
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Missing required env var: R2_ACCOUNT_ID");
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    await unchanged();
  }, 120_000);

  it("cleans up and does not run the script if installation fails", async () => {
    await writeFile(join(fixture, "bin/npm"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
    env.PATH = `${join(fixture, "bin")}:${process.env.PATH}`;
    const result = await run();
    expect(result.code).toBe(42);
    expect(result.stdout).not.toContain("Mirroring");
    await unchanged();
  });

  it.each(["ok", "wrong-size", "missing"])("uploads and HEAD-checks assets (%s)", async (parity) => {
    const puts: { key: string; bytes: Buffer; type: string | undefined; cache: string | undefined }[] = [];
    const heads: string[] = [];
    const server = createServer(async (req, res) => {
      const key = req.url!.split("?")[0];
      if (req.method === "PUT") {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        puts.push({ key, bytes: Buffer.concat(chunks), type: req.headers["content-type"], cache: req.headers["cache-control"] });
        res.end();
      } else if (req.method === "HEAD") {
        heads.push(key);
        const put = puts.find((p) => p.key === key)!;
        res.statusCode = parity === "missing" ? 404 : 200;
        res.setHeader("Content-Length", parity === "wrong-size" ? 999 : put.bytes.length);
        res.end();
      } else { res.statusCode = 405; res.end(); }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address() as { port: number };
    env.R2_ENDPOINT = `http://127.0.0.1:${address.port}`;
    await mkdir(join(fixture, "release"));
    await writeFile(join(fixture, "release/agav-linux-x64.gz"), "binary");
    await writeFile(join(fixture, "release/SHA256SUMS"), "checksum");
    await mkdir(join(fixture, "release/ignored"));
    try {
      const result = await run();
      expect(result.code, result.stderr).toBe(parity === "ok" ? 0 : 1);
      expect(puts.map((p) => p.key).sort()).toEqual(["/test/v0.2.3-beta.2/SHA256SUMS", "/test/v0.2.3-beta.2/agav-linux-x64.gz"]);
      expect(heads.sort()).toEqual(puts.map((p) => p.key).sort());
      expect(puts.find((p) => p.type === "application/gzip")?.bytes.toString()).toBe("binary");
      expect(puts.find((p) => p.type === "text/plain")?.bytes.toString()).toBe("checksum");
      expect(puts.every((p) => p.cache === "public, max-age=31536000, immutable")).toBe(true);
      if (parity === "ok") expect(result.stdout).toContain("2 object(s) under v0.2.3-beta.2/ verified");
      else expect(result.stderr).toContain("R2 mirror parity check failed for 2 object(s)");
      await unchanged();
    } finally { await new Promise<void>((done) => server.close(() => done())); }
  }, 120_000);
});
