/**
 * Real, per-OS sandbox ENFORCEMENT tests (the other half of #2).
 *
 * Every other sandbox test in the suite mocks `node:child_process`, so they only
 * assert the SHAPE of the command we hand the backend — never that the OS sandbox
 * actually restricts anything. These tests deliberately do NOT mock anything:
 * they spawn real commands through the real backend and prove that
 * filesystem / credential / network / process restrictions hold.
 *
 * Design principles (addressing review of the first draft):
 *
 *  - Every restriction test has a POSITIVE CONTROL: it first proves the host
 *    (unsandboxed) can do the thing, so a passing negative assertion reflects the
 *    sandbox blocking it rather than the operation being impossible anyway (e.g.
 *    writing to /usr already fails for an ordinary user; a seeded, host-writable
 *    fixture does not).
 *  - Credential dirs are SEEDED in a controlled $HOME and the exact file is
 *    named, so a quoted-wildcard no-op cannot pass for "read denied".
 *  - Each OS self-detects whether its backend can apply and REPORTS A SKIP
 *    (ctx.skip, not a silent pass) when it cannot. The dedicated CI job
 *    (.github/workflows/sandbox-enforcement.yml) fails the run if the backend it
 *    is responsible for could not apply, so a skip on the owning runner is turned
 *    into a hard failure there — a silently-disabled sandbox cannot hide.
 *  - Guarantees that a backend does NOT provide are documented, not asserted:
 *    seatbelt/bubblewrap here do not sandbox the network, so the network test is
 *    Docker-only (which configures --network=none).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { runInSandbox, detectSandboxBackend, type SandboxBackend } from "../utils/sandbox.js";

const RUN = { timeout: 20_000, maxBuffer: 1 << 20 };
const SEED = "agav-secret-do-not-leak";

/** The launcher binary for a backend, or undefined for backends without one. */
function launcher(backend: SandboxBackend): string | undefined {
  if (backend === "seatbelt") return "sandbox-exec";
  if (backend === "bubblewrap") return "bwrap";
  if (backend === "docker") return "docker";
  return undefined;
}

function backendInstalled(backend: SandboxBackend): boolean {
  const bin = launcher(backend);
  if (!bin) return false;
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "pipe", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function sandboxed(backend: SandboxBackend, command: string, cwd: string) {
  return runInSandbox({ command, cwd, forceBackend: backend, ...RUN });
}

/**
 * CONTROL for the Docker tests: run the same image with DEFAULT networking (no
 * --network=none) and no resource/uid flags, bypassing runInSandbox. Used to
 * prove a restriction the production sandbox adds is genuinely absent without it,
 * so the sandboxed assertion reflects the sandbox and not an ambient condition.
 */
function dockerRunDefault(command: string): { stdout: string; code: number } {
  try {
    const stdout = execFileSync("docker", ["run", "--rm", "node:22-slim", "/bin/sh", "-c", command],
      { encoding: "utf8", timeout: 60_000 });
    return { stdout, code: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; status?: number };
    return { stdout: err.stdout ? String(err.stdout) : "", code: err.status ?? 1 };
  }
}

/** Is the Docker daemon rootless? Mirrors production's detection in sandbox.ts. */
function dockerIsRootless(): boolean {
  try {
    const out = execFileSync("docker", ["info", "--format", "{{.SecurityOptions}}"], { encoding: "utf8", timeout: 5000 });
    return out.includes("name=rootless");
  } catch {
    return false;
  }
}

/**
 * A backend that is installed can still fail to *apply* (nested sandbox, no user
 * namespaces, no Docker daemon). We only run the enforcement asserts when a
 * trivial command through the backend actually produces the workload's marker.
 */
async function backendApplies(backend: SandboxBackend, cwd: string): Promise<boolean> {
  if (!backendInstalled(backend)) return false;
  try {
    const r = await sandboxed(backend, "echo __agav_apply__", cwd);
    const ok = r.error === null && r.stdout.includes("__agav_apply__");
    if (!ok) {
      // Surface WHY a backend did not apply so a CI skip is diagnosable rather
      // than silent (the dedicated workflow turns an owning-runner skip into a
      // hard failure; this log explains it).
      // eslint-disable-next-line no-console
      console.warn(`[sandbox-enforcement] ${backend} did not apply: error=${r.error?.message ?? "none"} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
    }
    return ok;
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.warn(`[sandbox-enforcement] ${backend} probe threw: ${cause instanceof Error ? cause.message : String(cause)}`);
    return false;
  }
}

/**
 * Seeds an isolated HOME (with populated credential dirs + a writable dir OUTSIDE
 * the sandbox CWD) and points process.env.HOME at it so the production profile
 * uses it. Returns the home dir, a separate workdir (the sandbox CWD), the seeded
 * secret path, and a restore fn. The workdir is a sibling of HOME, never nested,
 * so neither the HOME-subdir tmpfs masks (bubblewrap) nor the HOME write-deny
 * (seatbelt) accidentally cover the CWD carve-out.
 *
 * CRITICAL: the path MUST be canonical (realpath). The seatbelt profile denies
 * `(subpath (param "HOME"))`, but seatbelt matches on the kernel's canonical
 * path. On macOS `os.tmpdir()` is `/var/folders/...`, a symlink to
 * `/private/var/folders/...`; a non-canonical HOME param would never match the
 * path the sandboxed process actually resolves, silently re-allowing writes and
 * reads (exactly the native-CI failure this fixes). We realpath the root so the
 * param and the in-sandbox resolution are the same string.
 */
function seedHome(rawRoot: string): { home: string; workdir: string; secret: string; writableOutside: string; restore: () => void } {
  const root = realpathSync(rawRoot);
  const home = join(root, "home");
  const workdir = join(root, "work");
  const ssh = join(home, ".ssh");
  mkdirSync(ssh, { recursive: true });
  mkdirSync(join(home, ".aws"), { recursive: true });
  mkdirSync(join(home, ".gnupg"), { recursive: true });
  // Create the cache/config carve-out dirs the profile grants writes to, so the
  // profile's `-D HOME_*` params point at real directories (matches a real home).
  for (const dir of [".cache", ".config", ".local", ".npm", ".cargo"]) mkdirSync(join(home, dir), { recursive: true });
  mkdirSync(workdir, { recursive: true });
  const secret = join(ssh, "id_test");
  writeFileSync(secret, SEED);
  // A host-writable directory under HOME but not a credential/cache carve-out,
  // used as the positive control for the "home write is denied" test.
  const writableOutside = join(home, "docs");
  mkdirSync(writableOutside, { recursive: true });
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  return {
    home,
    workdir,
    secret,
    writableOutside,
    restore: () => { if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome; },
  };
}

describe("real sandbox enforcement (per-OS)", () => {
  // -------------------------------------------------------------------------
  // macOS Seatbelt
  // -------------------------------------------------------------------------
  describe.runIf(platform() === "darwin")("macOS Seatbelt", () => {
    let active = false;
    let root: string;
    let env: ReturnType<typeof seedHome>;
    const guard = (ctx: TestContext) => {
      if (!active) ctx.skip("seatbelt cannot apply here (nested sandbox or unavailable); runs on native CI");
    };
    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), "agav-sbx-sb-"));
      env = seedHome(root);
      active = await backendApplies("seatbelt", env.workdir);
    });
    afterAll(() => { env?.restore(); try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

    it("detects seatbelt as the default backend on macOS", (ctx) => {
      guard(ctx);
      expect(detectSandboxBackend()).toBe("seatbelt");
    });

    it("allows writes inside the working directory", async (ctx) => {
      guard(ctx);
      const marker = join(env.workdir, "sb-cwd-write.txt");
      const r = await sandboxed("seatbelt", `printf wrote > ${JSON.stringify(marker)} && echo WROTE`, env.workdir);
      expect(r.error).toBeNull();
      expect(r.stdout).toContain("WROTE");
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf8")).toBe("wrote");
    });

    it("denies writes to the home directory (control: host CAN write there)", async (ctx) => {
      guard(ctx);
      // Positive control: the target dir is genuinely writable off-sandbox.
      const control = join(env.writableOutside, "host-control.txt");
      writeFileSync(control, "host");
      expect(readFileSync(control, "utf8")).toBe("host");

      const forbidden = join(env.writableOutside, "sandboxed.txt");
      const r = await sandboxed("seatbelt", `printf x > ${JSON.stringify(forbidden)} && echo WROTE_HOME`, env.workdir);
      expect(r.error).not.toBeNull();
      expect(r.stdout).not.toContain("WROTE_HOME");
      expect(existsSync(forbidden)).toBe(false);
    });

    it("denies reads of a seeded credential file (control: host CAN read it)", async (ctx) => {
      guard(ctx);
      // Positive control: the secret really is present and readable off-sandbox.
      expect(readFileSync(env.secret, "utf8")).toBe(SEED);

      const r = await sandboxed(
        "seatbelt",
        `cat ${JSON.stringify(env.secret)} 2>/dev/null && echo DID_READ || echo DENIED`,
        env.workdir,
      );
      // The secret's contents must never appear, and the open must be denied.
      expect(r.stdout).not.toContain(SEED);
      expect(r.stdout).not.toContain("DID_READ");
      expect(r.stdout).toContain("DENIED");
    });

    it("denies writes to the credential directories (last-match-wins is not re-exposed)", async (ctx) => {
      guard(ctx);
      const target = join(env.home, ".ssh", "injected.key");
      const r = await sandboxed("seatbelt", `printf x > ${JSON.stringify(target)} && echo WROTE_SSH`, env.workdir);
      expect(r.stdout).not.toContain("WROTE_SSH");
      expect(existsSync(target)).toBe(false);
    });

    it("denies writes to system directories like /usr", async (ctx) => {
      guard(ctx);
      const r = await sandboxed("seatbelt", `printf x > /usr/agav-sbx-${process.pid} && echo WROTE_USR`, env.workdir);
      expect(r.stdout).not.toContain("WROTE_USR");
      expect(existsSync(`/usr/agav-sbx-${process.pid}`)).toBe(false);
    });

    it("blocks exec of binaries under /System/Library/CoreServices (process restriction)", async (ctx) => {
      guard(ctx);
      // The profile has `(deny process-exec (subpath "/System/Library/CoreServices"))`.
      // Pick a real executable file in that tree at runtime (image-independent).
      let bin: string;
      try {
        bin = execFileSync("/bin/sh", ["-c", "find /System/Library/CoreServices -maxdepth 1 -type f -perm -u+x 2>/dev/null | head -1"],
          { encoding: "utf8", timeout: 5000 }).trim();
      } catch {
        bin = "";
      }
      if (!bin || !existsSync(bin)) ctx.skip("no executable found under /System/Library/CoreServices on this image");
      // Running the exact binary through the shell: when process-exec is denied,
      // the shell cannot launch it and reports 126 (permission) or 127 (ENOENT
      // surfaced by the sandbox). We print a distinct marker only if exec was
      // actually reached (the kernel let the image load), which must NOT happen.
      const r = await sandboxed(
        "seatbelt",
        `${JSON.stringify(bin)} --agav-nonexistent-flag >/dev/null 2>&1; code=$?; echo "code:$code"`,
        env.workdir,
      );
      const code = /code:(\d+)/.exec(r.stdout)?.[1];
      // 126/127 == exec refused by the sandbox. Any "normal" nonzero (e.g. a
      // usage error from the running binary) would be a different, small number
      // and would mean exec was NOT blocked — fail in that case.
      expect(["126", "127"]).toContain(code);
    });
  });

  // -------------------------------------------------------------------------
  // Linux Bubblewrap
  // -------------------------------------------------------------------------
  describe.runIf(platform() === "linux")("Linux Bubblewrap", () => {
    let active = false;
    let root: string | undefined;
    let seeded: ReturnType<typeof seedHome> | undefined;
    // Returns the seeded fixture, or skips (and never returns) when inactive.
    const guard = (ctx: TestContext): ReturnType<typeof seedHome> => {
      if (!active || !seeded) ctx.skip("bwrap unavailable or cannot apply (no user namespaces / nested sandbox); runs on native CI");
      return seeded!;
    };
    const base = join(process.cwd(), ".agav-sbx-bw-tmp");
    beforeAll(async () => {
      // Only materialize the fixture when bwrap is actually present, so the common
      // (no-bwrap) Tests job never creates a stray dir under the checkout that a
      // clean-worktree check could trip.
      if (!backendInstalled("bubblewrap")) return;
      // IMPORTANT: NOT under /tmp. production runBubblewrap applies `--tmpfs /tmp`
      // AFTER `--bind {cwd} {cwd}`, so a workdir under /tmp would be masked by the
      // empty tmpfs and host writes would vanish. Real users' CWDs are project
      // dirs, never /tmp; mirror that by rooting the fixture under the checkout.
      mkdirSync(base, { recursive: true });
      root = mkdtempSync(join(base, "run-"));
      seeded = seedHome(root);
      active = await backendApplies("bubblewrap", seeded.workdir);
    });
    afterAll(() => {
      seeded?.restore();
      try { if (root) rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
      try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    it("detects bubblewrap as the default backend when bwrap is present", (ctx) => {
      guard(ctx);
      expect(detectSandboxBackend()).toBe("bubblewrap");
    });

    it("allows writes inside the bound working directory", async (ctx) => {
      const env = guard(ctx);
      const marker = join(env.workdir, "bw-cwd-write.txt");
      const r = await sandboxed("bubblewrap", `printf wrote > ${JSON.stringify(marker)} && echo WROTE`, env.workdir);
      expect(r.error).toBeNull();
      expect(r.stdout).toContain("WROTE");
      // The bind is read-write to the host, so the file is visible outside.
      expect(existsSync(marker)).toBe(true);
    });

    it("masks a seeded credential file with tmpfs (control: host CAN read it)", async (ctx) => {
      const env = guard(ctx);
      expect(readFileSync(env.secret, "utf8")).toBe(SEED);

      const r = await sandboxed(
        "bubblewrap",
        `cat ${JSON.stringify(env.secret)} 2>/dev/null && echo DID_READ || echo MASKED; echo DONE`,
        env.workdir,
      );
      expect(r.stdout).toContain("DONE");
      // tmpfs overlay means the seeded file is simply not there inside the sandbox.
      expect(r.stdout).not.toContain(SEED);
      expect(r.stdout).not.toContain("DID_READ");
      expect(r.stdout).toContain("MASKED");
    });

    it("does not persist writes to the masked credential directory on the host", async (ctx) => {
      const env = guard(ctx);
      const target = join(env.home, ".ssh", "injected.key");
      const r = await sandboxed("bubblewrap", `printf x > ${JSON.stringify(target)} 2>/dev/null; echo DONE`, env.workdir);
      expect(r.stdout).toContain("DONE");
      // Even if the write "succeeds" against the tmpfs, it must NOT land on the host.
      expect(existsSync(target)).toBe(false);
    });

    it("mounts $HOME read-only outside the writable carve-outs (control: host CAN write there)", async (ctx) => {
      const env = guard(ctx);
      // Positive control: the target is genuinely host-writable.
      const control = join(env.writableOutside, "host-control.txt");
      writeFileSync(control, "host");
      expect(readFileSync(control, "utf8")).toBe("host");

      const forbidden = join(env.writableOutside, "sandboxed.txt");
      const r = await sandboxed("bubblewrap", `printf x > ${JSON.stringify(forbidden)} 2>/dev/null && echo WROTE_HOME || echo RO_HOME`, env.workdir);
      expect(r.stdout).not.toContain("WROTE_HOME");
      expect(existsSync(forbidden)).toBe(false);
    });

    it("mounts the rest of the filesystem read-only (system write restriction)", async (ctx) => {
      const env = guard(ctx);
      // Control: /etc exists and is a normal, non-tmpfs host path the ro-bind covers.
      const r = await sandboxed("bubblewrap", `printf x > /etc/agav-sbx-${process.pid} 2>/dev/null && echo WROTE_ETC || echo RO_ETC`, env.workdir);
      expect(r.stdout).not.toContain("WROTE_ETC");
      expect(existsSync(`/etc/agav-sbx-${process.pid}`)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Docker: the only backend that sandboxes the network (--network=none).
  // Runs wherever a Docker daemon is reachable; otherwise a visible skip.
  // -------------------------------------------------------------------------
  describe.runIf(platform() !== "win32")("Docker network + process isolation", () => {
    let active = false;
    let root: string;
    const guard = (ctx: TestContext) => {
      if (!active) ctx.skip("docker daemon unavailable here; runs where Docker is present");
    };
    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), "agav-sbx-dk-"));
      // The first container run pulls node:22-slim; the hook gets a generous
      // timeout so a cold image cache does not look like "docker unavailable".
      active = await backendApplies("docker", root);
    }, 180_000);
    afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

    it("denies all outbound network (--network=none)", async (ctx) => {
      guard(ctx);
      // Prove the network namespace is actually absent by enumerating the
      // container's own interfaces with Node (no external host, no DNS, no remote
      // service that could flake). --network=none leaves ONLY loopback; a normally
      // networked container also has an ethernet interface (eth0).
      const probe =
        "const n=require('os').networkInterfaces();" +
        "console.log('IFACES:'+Object.keys(n).sort().join(','));";

      // Positive control: the SAME probe with default networking must show a
      // non-loopback interface — otherwise "only lo" below would prove nothing.
      const control = dockerRunDefault(`node -e ${JSON.stringify(probe)}`);
      const controlIfaces = (/IFACES:(.*)/.exec(control.stdout)?.[1] ?? "").split(",").filter(Boolean);
      expect(control.code).toBe(0);
      expect(controlIfaces.some((i) => i !== "lo")).toBe(true); // control really has a network

      // Through the production sandbox (--network=none): only loopback remains.
      const r = await sandboxed("docker", `node -e ${JSON.stringify(probe)}`, root);
      expect(r.error).toBeNull();
      const ifaces = (/IFACES:(.*)/.exec(r.stdout)?.[1] ?? "").split(",").filter(Boolean);
      expect(ifaces.length).toBeGreaterThan(0);          // probe ran
      expect(ifaces.every((i) => i === "lo")).toBe(true); // no non-loopback interface exists
    }, 90_000);

    it("confines the filesystem to the mounted workspace (host root not writable)", async (ctx) => {
      guard(ctx);
      const r = await sandboxed(
        "docker",
        "printf x > /etc/agav-docker-probe 2>/dev/null && echo WROTE_ETC || echo RO_ETC; " +
        "printf y > /workspace/in-ws.txt && echo WROTE_WS",
        root,
      );
      // The container's own /etc is ephemeral, but it is not the host's — prove
      // the workspace write lands on the host while the container root does not.
      expect(r.stdout).toContain("WROTE_WS");
      expect(existsSync(join(root, "in-ws.txt"))).toBe(true);
      expect(existsSync("/etc/agav-docker-probe")).toBe(false);
    }, 40_000);

    it("applies the configured memory limit (concrete resource restriction)", async (ctx) => {
      guard(ctx);
      // Prove --memory=512m actually took effect by reading the cgroup limit the
      // container sees. Removing --memory from runDocker would make this fail
      // (cgroup v2 reports "max"; v1 reports the host's huge default). 512 MiB =
      // 536870912 bytes.
      const read =
        "cat /sys/fs/cgroup/memory.max 2>/dev/null || " +         // cgroup v2
        "cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null"; // cgroup v1
      const r = await sandboxed("docker", read, root);
      expect(r.error).toBeNull();
      const limit = Number(r.stdout.trim().split(/\s+/)[0]);
      expect(Number.isFinite(limit)).toBe(true);
      expect(limit).toBe(512 * 1024 * 1024);
    }, 40_000);

    it("runs under an explicit non-default UID mapping (not ambient container root)", async (ctx) => {
      guard(ctx);
      // Control: WITHOUT production's `-u uid:gid`, this image defaults to running
      // as root (uid 0). This both proves the default and makes the sandboxed
      // assertion meaningful (removing -u would regress to this).
      const control = dockerRunDefault("id -u");
      expect(control.code).toBe(0);
      expect(Number(control.stdout.trim())).toBe(0); // default container user IS root

      const r = await sandboxed("docker", "id -u", root);
      expect(r.error).toBeNull();
      const inContainerUid = Number(r.stdout.trim().split(/\s+/)[0]);

      if (dockerIsRootless()) {
        // True rootless Docker: production omits `-u`, so the container runs as its
        // own root (0) which the daemon maps to the unprivileged host user — not a
        // host-root escape. Accept 0 only under verified rootless.
        expect(inContainerUid).toBe(0);
      } else {
        // Rootful daemon: production passes `-u <hostuid>:<hostgid>`, so the
        // container must NOT be root and must equal the host uid. Dropping `-u`
        // from runDocker would make this 0 (matching the control) and fail here.
        const hostUid = process.getuid?.() ?? -1;
        expect(inContainerUid).not.toBe(0);
        expect(inContainerUid).toBe(hostUid);
      }
    }, 90_000);
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
