import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Compile into a disposable directory, never into the repository's generated build/dist.
describe("freshly compiled job recovery CLI", () => {
  it("runs the actual entry in an isolated profile and retains hidden evidence after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "agav-compiled-recovery-"));
    const home = join(root, "profile ü");
    const output = join(root, "compiled");
    const exec = promisify(execFile);
    const env = { ...process.env, USERPROFILE: home, HOME: home, NODE_ENV: "test" };
    try {
      await mkdir(join(home, ".agav"), { recursive: true });
      await writeFile(join(home, ".agav", "config.json"), JSON.stringify({ backgroundJobsEnabled: true, permissionMode: "auto-accept" }));
      // Temporary output needs an ESM boundary and access to this checkout's installed dependencies.
      await writeFile(join(root, "package.json"), '{"type":"module"}');
      const { symlink } = await import("node:fs/promises");
      await symlink(resolve("node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      const compiled = await exec(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "--outDir", output, "--declaration", "false", "--declarationMap", "false", "--sourceMap", "false"], { timeout: 60000, maxBuffer: 4 * 1024 * 1024, env });
      expect(compiled.stdout).toBe(""); expect(compiled.stderr).toBe("");
      const moduleURL = (path: string) => pathToFileURL(join(output, path)).href;
      const runModule = (code: string) => exec(process.execPath, ["--input-type=module", "-e", code], { env, cwd: home, timeout: 20000 });
      const seeded = await runModule(`const { createCoordinator } = await import(${JSON.stringify(moduleURL("background-jobs/coordinator/service.js"))});
        const c = await createCoordinator(); const id = '11111111-2222-4333-8444-555555555555';
        await c.repositories.jobs.create({ jobId: id, requestId: 'compiled-request', specHash: 'fixture', protocolVersion: 1, state: 'recovery-required', stopState: 'none', nonce: '' });
        console.log(id);`);
      expect(seeded.stderr).toBe("");
      const id = seeded.stdout.trim();
      const cli = join(output, "cli.js");
      const help = await exec(process.execPath, [cli, "job", "help"], { env, cwd: home, timeout: 20000 });
      expect(help.stdout).toContain("abandon"); expect(help.stderr).toBe("");
      const result = await exec(process.execPath, [cli, "job", "abandon", id, "--acknowledge-unverified"], { env, cwd: home, timeout: 20000 });
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Capacity released");
      expect(result.stdout).toMatch(/no processes were stopped/i);
      const checked = await runModule(`const { createJobsAdapter } = await import(${JSON.stringify(moduleURL("resources/job-adapters.js"))});
        const { getSharedCoordinator } = await import(${JSON.stringify(moduleURL("background-jobs-integration.js"))});
        const c = await getSharedCoordinator(); const active = await createJobsAdapter().list(); const all = await createJobsAdapter(true).list();
        const detail = await createJobsAdapter().get(${JSON.stringify(id)});
        const original = await c.findByRequestId('compiled-request');
        if (active.length || all.length !== 1 || !all[0].title.includes('[abandoned]') || all[0].removable || all[0].stoppable || all[0].abandonable || !detail.detail.includes('abandonedAt:') || !original.abandonment) throw Error('lost audit or incorrect active/actions state');
        console.log('verified compiled active filter, retained audit, by-ID lookup and request dedup lookup');`);
      expect(checked.stderr).toBe(""); expect(checked.stdout).toContain("verified compiled");
      console.log("Temporary compilation + actual agav job abandon + fresh-process visibility/audit verification passed.");
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }, 90000);
});
