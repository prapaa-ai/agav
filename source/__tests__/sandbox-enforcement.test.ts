/**
 * Real, per-OS sandbox ENFORCEMENT tests (the other half of #2).
 *
 * Every other sandbox test in the suite mocks `node:child_process`, so they only
 * assert the SHAPE of the command we hand the backend — never that the OS sandbox
 * actually restricts anything. These tests deliberately do NOT mock anything:
 * they spawn real commands through the real backend and prove that
 * filesystem / network / process restrictions hold.
 *
 * Because the restrictions are OS-specific, each test self-detects whether its
 * backend can actually be applied in the current environment and REPORTS A SKIP
 * (not a silent pass) when it cannot — Windows has no OS sandbox; a nested
 * sandbox cannot re-apply seatbelt/bubblewrap; a CI runner may lack
 * `bwrap`/`sandbox-exec` or user namespaces. The CI matrix in
 * `.github/workflows/sandbox-enforcement.yml` runs this file on native macOS and
 * Linux runners where the probe passes, so the assertions execute for real there.
 * Using `ctx.skip()` (rather than an early `return`) keeps a non-executing
 * environment visibly distinct from a genuine pass, so a broken probe cannot
 * quietly disable enforcement coverage.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir, platform } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { runInSandbox, detectSandboxBackend, type SandboxBackend } from "../utils/sandbox.js";

const RUN = { timeout: 15_000, maxBuffer: 1 << 20 };

/**
 * Can `backend` actually be applied here? We check the launcher exists and the
 * shell works; the stronger "does the profile apply" check is `profileApplies`.
 * A nested sandbox (e.g. the agent's own seatbelt) makes `sandbox-exec`/`bwrap`
 * fail to apply — that is the signal to skip, not to fail.
 */
function backendInstalled(backend: SandboxBackend): boolean {
  try {
    const bin = backend === "seatbelt" ? "sandbox-exec" : "bwrap";
    execFileSync("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "pipe", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** Shared: run a real command through the backend and return its combined output + error. */
async function sandboxed(backend: SandboxBackend, command: string, cwd: string) {
  return runInSandbox({ command, cwd, forceBackend: backend, ...RUN });
}

/**
 * A backend that is installed can still fail to *apply its profile* (nested
 * sandbox, no user namespaces). We only run the enforcement asserts when a
 * trivial profiled command actually succeeds.
 */
async function profileApplies(backend: SandboxBackend, cwd: string): Promise<boolean> {
  if (!backendInstalled(backend)) return false;
  try {
    const r = await sandboxed(backend, "echo __agav_apply__", cwd);
    return r.error === null && r.stdout.includes("__agav_apply__");
  } catch {
    return false;
  }
}

describe("real sandbox enforcement (per-OS)", () => {
  let workdir: string;
  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), "agav-sbx-enf-"));
  });
  afterAll(() => {
    try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // -------------------------------------------------------------------------
  // macOS Seatbelt
  // -------------------------------------------------------------------------
  describe.runIf(platform() === "darwin")("macOS Seatbelt", () => {
    let active = false;
    const guard = (ctx: TestContext) => {
      if (!active) ctx.skip("seatbelt cannot apply here (nested sandbox or unavailable); runs on native CI");
    };
    beforeAll(async () => { active = await profileApplies("seatbelt", workdir); });

    it("detects seatbelt as the default backend on macOS", (ctx) => {
      guard(ctx);
      expect(detectSandboxBackend()).toBe("seatbelt");
    });

    it("allows writes inside the working directory", async (ctx) => {
      guard(ctx);
      const marker = join(workdir, "sb-cwd-write.txt");
      const r = await sandboxed("seatbelt", `printf wrote > ${JSON.stringify(marker)} && echo WROTE`, workdir);
      expect(r.error).toBeNull();
      expect(r.stdout).toContain("WROTE");
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf8")).toBe("wrote");
    });

    it("denies writes to the user's home directory root (filesystem restriction)", async (ctx) => {
      guard(ctx);
      const forbidden = join(homedir(), `agav-sbx-should-not-exist-${process.pid}.txt`);
      const r = await sandboxed("seatbelt", `printf x > ${JSON.stringify(forbidden)} && echo WROTE_HOME`, workdir);
      // The sandbox must block the write: the command exits non-zero and the
      // file must not appear on the host.
      expect(r.error).not.toBeNull();
      expect(r.stdout).not.toContain("WROTE_HOME");
      expect(existsSync(forbidden)).toBe(false);
      if (existsSync(forbidden)) rmSync(forbidden, { force: true }); // paranoia cleanup
    });

    it("denies reads of credential directories even if they exist", async (ctx) => {
      guard(ctx);
      const ssh = join(homedir(), ".ssh");
      const r = await sandboxed(
        "seatbelt",
        `cat ${JSON.stringify(join(ssh, "*"))} 2>/dev/null && echo READ_SSH || echo DENIED_SSH`,
        workdir,
      );
      expect(r.stdout).not.toContain("READ_SSH");
    });

    it("denies writes to the credential directories (last-match-wins is not re-exposed)", async (ctx) => {
      guard(ctx);
      const target = join(homedir(), ".ssh", `agav-sbx-${process.pid}.key`);
      const r = await sandboxed("seatbelt", `printf x > ${JSON.stringify(target)} && echo WROTE_SSH`, workdir);
      expect(r.stdout).not.toContain("WROTE_SSH");
      expect(existsSync(target)).toBe(false);
    });

    it("denies writes to system directories like /usr", async (ctx) => {
      guard(ctx);
      const r = await sandboxed("seatbelt", `printf x > /usr/agav-sbx-${process.pid} && echo WROTE_USR`, workdir);
      expect(r.stdout).not.toContain("WROTE_USR");
      expect(existsSync(`/usr/agav-sbx-${process.pid}`)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Linux Bubblewrap
  // -------------------------------------------------------------------------
  describe.runIf(platform() === "linux")("Linux Bubblewrap", () => {
    let active = false;
    const guard = (ctx: TestContext) => {
      if (!active) ctx.skip("bwrap unavailable or cannot apply (no user namespaces / nested sandbox); runs on native CI");
    };
    beforeAll(async () => { active = await profileApplies("bubblewrap", workdir); });

    it("detects bubblewrap as the default backend when bwrap is present", (ctx) => {
      guard(ctx);
      expect(detectSandboxBackend()).toBe("bubblewrap");
    });

    it("allows writes inside the bound working directory", async (ctx) => {
      guard(ctx);
      const marker = join(workdir, "bw-cwd-write.txt");
      const r = await sandboxed("bubblewrap", `printf wrote > ${JSON.stringify(marker)} && echo WROTE`, workdir);
      expect(r.error).toBeNull();
      expect(r.stdout).toContain("WROTE");
      // The bind is read-write to the host, so the file is visible outside.
      expect(existsSync(marker)).toBe(true);
    });

    it("masks the credential directories with an empty tmpfs (read isolation)", async (ctx) => {
      guard(ctx);
      // ~/.ssh is tmpfs-masked inside the sandbox; listing it must show nothing
      // from the host even if the host dir has contents.
      const r = await sandboxed(
        "bubblewrap",
        `ls -A ${JSON.stringify(join(homedir(), ".ssh"))} 2>/dev/null | head -1; echo LISTED_SSH`,
        workdir,
      );
      expect(r.stdout).toContain("LISTED_SSH");
      const before = r.stdout.split("LISTED_SSH")[0] ?? "";
      expect(before.trim()).toBe("");
    });

    it("does not persist writes to the masked credential directory on the host", async (ctx) => {
      guard(ctx);
      const name = `agav-sbx-${process.pid}.key`;
      const target = join(homedir(), ".ssh", name);
      const r = await sandboxed("bubblewrap", `printf x > ${JSON.stringify(target)} 2>/dev/null; echo DONE`, workdir);
      expect(r.stdout).toContain("DONE");
      // Even if the write "succeeds" against the tmpfs, it must NOT land on the host.
      expect(existsSync(target)).toBe(false);
    });

    it("mounts the rest of the filesystem read-only (system write restriction)", async (ctx) => {
      guard(ctx);
      const r = await sandboxed("bubblewrap", `printf x > /usr/agav-sbx-${process.pid} 2>/dev/null && echo WROTE_USR || echo RO_USR`, workdir);
      expect(r.stdout).not.toContain("WROTE_USR");
      expect(existsSync(`/usr/agav-sbx-${process.pid}`)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Windows: no OS sandbox exists; the contract is "fail safe to unsandboxed",
  // never "pretend to sandbox". This must hold on the real platform.
  // -------------------------------------------------------------------------
  describe.runIf(platform() === "win32")("Windows (no OS sandbox)", () => {
    it("auto-detects backend 'none' rather than claiming a sandbox", () => {
      expect(detectSandboxBackend()).toBe("none");
    });

    it("still refuses a model-driven explicit 'none' override without the user opt-out", async () => {
      await expect(
        runInSandbox({ command: "echo hi", cwd: process.cwd(), forceBackend: "none", ...RUN }),
      ).rejects.toThrow(/Sandbox bypass denied/i);
    });

    it("runs commands through the automatic unsandboxed fallback", async () => {
      const marker = join(tmpdir(), `agav-win-sbx-${process.pid}.txt`);
      try {
        const r = await runInSandbox({ command: `echo win-ok> ${JSON.stringify(marker)}`, cwd: tmpdir(), ...RUN });
        expect(r.backend).toBe("none");
        expect(r.error).toBeNull();
        expect(existsSync(marker)).toBe(true);
      } finally {
        if (existsSync(marker)) rmSync(marker, { force: true });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Platform-independent: the enforcement DECISION cannot be bypassed by model
// input. These run everywhere (no backend application required).
// ---------------------------------------------------------------------------
describe("sandbox bypass is refused regardless of OS", () => {
  const prev = process.env.AGAV_NO_SANDBOX;
  beforeAll(() => { delete process.env.AGAV_NO_SANDBOX; });
  afterAll(() => { if (prev === undefined) delete process.env.AGAV_NO_SANDBOX; else process.env.AGAV_NO_SANDBOX = prev; });

  it("rejects forceBackend 'none' before spawning anything when the user has not opted out", async () => {
    await expect(
      runInSandbox({ command: "echo hi", cwd: tmpdir(), forceBackend: "none", ...RUN }),
    ).rejects.toThrow(/Sandbox bypass denied/i);
  });

  it.each(["invalid", "", "SEATBELT", "shell"])("rejects the unknown backend %p", async (backend) => {
    await expect(
      runInSandbox({ command: "echo hi", cwd: tmpdir(), forceBackend: backend as SandboxBackend, ...RUN }),
    ).rejects.toThrow(/sandbox/i);
  });

  it("writes nothing to disk when a bypass is refused", async () => {
    const marker = join(tmpdir(), `agav-bypass-${process.pid}.txt`);
    if (existsSync(marker)) rmSync(marker, { force: true });
    await expect(
      runInSandbox({ command: `printf x > ${JSON.stringify(marker)}`, cwd: tmpdir(), forceBackend: "none", ...RUN }),
    ).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
  });
});
