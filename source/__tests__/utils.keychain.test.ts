import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:os", () => ({ platform: vi.fn() }));

import { spawn } from "node:child_process";
import { platform } from "node:os";

const spawnMock = vi.mocked(spawn);
const platformMock = vi.mocked(platform);

interface Response {
  /** Exit code delivered via the 'close' event. */
  code?: number;
  stdout?: string;
  /** Emit stdout as these raw byte chunks (to exercise UTF-8 boundary decoding). */
  stdoutChunks?: Buffer[];
  /** When true, the child never closes on its own (simulates a hang/timeout). */
  hang?: boolean;
  /** When set, the child's stdin emits this error asynchronously (e.g. EPIPE). */
  stdinError?: string;
  /** When true, emit a spawn 'error' (missing tool). */
  spawnError?: boolean;
  /** Close with a signal instead of an exit code. */
  signal?: string;
}

interface SpawnCall {
  file: string;
  args: string[];
  env?: Record<string, string | undefined>;
  stdin: string;
  child: any;
  killed: string[];
}

/** Scripted spawn mock; records calls and the kill signals each child received. */
function scriptSpawn(responses: Response[]) {
  const calls: SpawnCall[] = [];
  let index = 0;
  spawnMock.mockImplementation(((file: any, args: any, options: any) => {
    const response = responses[index++] ?? { code: 0, stdout: "" };
    const child = new EventEmitter() as any;
    const stdout = new EventEmitter() as any;
    const stdin = new EventEmitter() as any;
    stdin.end = (data?: string) => { if (data) record.stdin += data; };
    child.stdout = stdout;
    child.stdin = stdin;
    const killed: string[] = [];
    child.kill = (sig?: string) => { killed.push(sig ?? "SIGTERM"); return true; };
    const record: SpawnCall = { file, args: args ?? [], env: options?.env, stdin: "", child, killed };
    calls.push(record);
    queueMicrotask(() => {
      if (response.spawnError) { child.emit("error", new Error("ENOENT")); return; }
      if (response.stdinError) stdin.emit("error", Object.assign(new Error(response.stdinError), { code: response.stdinError }));
      if (response.stdoutChunks) { for (const c of response.stdoutChunks) stdout.emit("data", c); }
      else if (response.stdout) stdout.emit("data", Buffer.from(response.stdout, "utf-8"));
      if (response.hang) return; // never closes — exercises our deadline timer
      if (response.signal) { child.emit("close", null, response.signal); return; }
      child.emit("close", response.code ?? 0, null);
    });
    return child;
  }) as any);
  return () => calls;
}

async function freshModule() {
  vi.resetModules();
  const mod = await import("../utils/keychain.js");
  mod.__resetKeychainBackendForTests();
  mod.__resetKeychainBreakerForTests();
  return mod;
}

describe("utils/keychain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    process.env.SystemRoot = "C:\\Windows";
  });
  afterEach(() => {
    platformMock.mockReset();
    vi.useRealTimers();
    delete process.env.SystemRoot;
  });

  describe("reference helpers", () => {
    it("builds, detects and parses placeholders", async () => {
      const mod = await freshModule();
      expect(mod.keychainRef("openai-api-key")).toBe("keychain:openai-api-key");
      expect(mod.isKeychainRef("keychain:openai-api-key")).toBe(true);
      expect(mod.isKeychainRef("enc:abc")).toBe(false);
      expect(mod.keychainAccount("keychain:openai-api-key")).toBe("openai-api-key");
      expect(mod.keychainAccount("enc:abc")).toBe("");
    });
  });

  describe("macOS backend", () => {
    beforeEach(() => platformMock.mockReturnValue("darwin"));

    it("stores a secret via interactive `security -i`, never placing it on argv", async () => {
      const getCalls = scriptSpawn([{ code: 0 }, { code: 0 }]);
      const mod = await freshModule();
      expect(await mod.setSecret("openai-api-key", "sk-secret")).toBe(true);
      const call = getCalls().find((c) => c.file === "security" && c.args[0] === "-i");
      expect(call).toBeDefined();
      expect(call!.args.join(" ")).not.toContain("sk-secret");
      const b64 = Buffer.from("sk-secret", "utf-8").toString("base64");
      expect(call!.stdin).toContain("add-generic-password");
      expect(call!.stdin).toContain(b64);
      expect(call!.stdin).not.toContain("sk-secret");
    });

    it("round-trips a secret through base64 on read", async () => {
      const b64 = Buffer.from("sk-secret", "utf-8").toString("base64");
      scriptSpawn([{ code: 0 }, { code: 0, stdout: `${b64}\n` }]);
      const mod = await freshModule();
      expect(await mod.getSecret("openai-api-key")).toBe("sk-secret");
    });

    it("round-trips a secret with newlines/non-printable bytes losslessly", async () => {
      const raw = "a\nb\tc";
      const b64 = Buffer.from(raw, "utf-8").toString("base64");
      const getCalls = scriptSpawn([{ code: 0 }, { code: 0 }, { code: 0, stdout: `${b64}\n` }]);
      const mod = await freshModule();
      expect(await mod.setSecret("k", raw)).toBe(true);
      expect(await mod.getSecret("k")).toBe(raw);
      const setCall = getCalls().find((c) => c.stdin.includes("add-generic-password"));
      expect(setCall!.stdin).toContain(b64);
    });

    it("refuses an over-long interactive line (would split and falsely succeed)", async () => {
      const getCalls = scriptSpawn([{ code: 0 } /* detection only */]);
      const mod = await freshModule();
      // A ~4100-byte secret exceeds the 4095-byte interactive parser line.
      const huge = "x".repeat(4100);
      expect(await mod.setSecret("openai-api-key", huge)).toBe(false);
      // Only the detection spawn ran; no add-generic-password was attempted.
      expect(getCalls().some((c) => c.stdin.includes("add-generic-password"))).toBe(false);
    });

    it.each([
      ["ASCII", "a".repeat(5000)],
      ["multi-byte UTF-8", "é".repeat(2050)],
      ["escaped quotes", '"'.repeat(2050)],
    ])("refuses an over-long %s account on read and delete (interactive line bound)", async (_label, huge) => {
      const getCalls = scriptSpawn([{ code: 0 }]); // detection only; no command should run
      const mod = await freshModule();
      expect(await mod.getSecret(huge)).toBeUndefined();
      await mod.deleteSecret(huge); // must not throw / not emit a split command
      // Assert the backend as well as the absence of interactive commands: this
      // regression used to pass vacuously inside the Linux backend's describe.
      expect(getCalls().map(({ file, args }) => ({ file, args }))).toEqual([
        { file: "security", args: ["help"] },
      ]);
    });

    it("returns undefined when the item is absent (non-zero exit)", async () => {
      scriptSpawn([{ code: 0 }, { code: 44 }]);
      const mod = await freshModule();
      expect(await mod.getSecret("missing")).toBeUndefined();
    });

    it("reports availability when `security help` succeeds", async () => {
      scriptSpawn([{ code: 0 }]);
      const mod = await freshModule();
      expect(await mod.isKeychainAvailable()).toBe(true);
    });
  });

  describe("Linux secret-tool backend", () => {
    beforeEach(() => platformMock.mockReturnValue("linux"));

    it("detects availability via a read-only `search` probe (not --version)", async () => {
      const getCalls = scriptSpawn([{ code: 0 }]);
      const mod = await freshModule();
      expect(await mod.isKeychainAvailable()).toBe(true);
      const probe = getCalls()[0]!;
      expect(probe.file).toBe("secret-tool");
      expect(probe.args[0]).toBe("search");
      expect(probe.args).not.toContain("--version");
    });

    it("feeds the secret through stdin, never argv", async () => {
      const getCalls = scriptSpawn([{ code: 0 }, { code: 0 }]);
      const mod = await freshModule();
      expect(await mod.setSecret("openai-api-key", "sk-secret")).toBe(true);
      const call = getCalls().find((c) => c.args[0] === "store");
      expect(call).toBeDefined();
      expect(call!.args.join(" ")).not.toContain("sk-secret");
      expect(call!.stdin).toBe("sk-secret");
    });

    it("looks a secret up by its attributes", async () => {
      scriptSpawn([{ code: 0 }, { code: 0, stdout: "sk-secret" }]);
      const mod = await freshModule();
      expect(await mod.getSecret("openai-api-key")).toBe("sk-secret");
    });

    it("treats an unreachable service / missing CLI as no credential store", async () => {
      scriptSpawn([{ spawnError: true }]);
      const mod = await freshModule();
      expect(await mod.isKeychainAvailable()).toBe(false);
      expect(await mod.setSecret("k", "v")).toBe(false);
      expect(await mod.getSecret("k")).toBeUndefined();
    });

    it("does not crash when the child closes stdin early (EPIPE) and reports failure", async () => {
      scriptSpawn([{ code: 0 }, { code: 1, stdinError: "EPIPE" }]);
      const mod = await freshModule();
      expect(await mod.setSecret("k", "v")).toBe(false);
    });

    it("reports failure when stdin delivery fails even if the child exits 0", async () => {
      // A command that closed its input early but still exited 0 did NOT receive
      // the full secret; setSecret must treat that as a failure (→ file fallback).
      scriptSpawn([{ code: 0 }, { code: 0, stdinError: "EPIPE" }]);
      const mod = await freshModule();
      expect(await mod.setSecret("k", "v")).toBe(false);
    });

    it("force-terminates a child that errors on stdin but keeps running", async () => {
      // stdin errors, child never closes on its own → we must still reap it.
      const getCalls = scriptSpawn([{ code: 0 }, { stdinError: "EPIPE", hang: true }]);
      const mod = await freshModule();
      expect(await mod.setSecret("k", "v")).toBe(false);
      const storeCall = getCalls().find((c) => c.args[0] === "store");
      expect(storeCall!.killed).toContain("SIGTERM");
    });

    it("fails closed when stdout overflows instead of returning a truncated secret", async () => {
      // A reply larger than the 1 MiB cap is abnormal; the read must fail (not
      // return a silently truncated, possibly mid-UTF-8 value) and reap the child.
      // On the Linux backend getSecret runs `secret-tool lookup ...`.
      const huge = Buffer.alloc(1024 * 1024 + 10, 0x41); // > MAX_STDOUT, exits 0
      const getCalls = scriptSpawn([{ code: 0 }, { code: 0, stdoutChunks: [huge], hang: true }]);
      const mod = await freshModule();
      expect(await mod.getSecret("k")).toBeUndefined();
      const readCall = getCalls().find((c) => c.args[0] === "lookup");
      expect(readCall!.killed).toContain("SIGTERM");
    });

    it("treats a signal-terminated child as failure, not success", async () => {
      scriptSpawn([{ code: 0 }, { signal: "SIGKILL" }]);
      const mod = await freshModule();
      expect(await mod.setSecret("k", "v")).toBe(false);
    });

    it("decodes a multi-byte secret split across stdout chunks losslessly", async () => {
      // "é" is 0xC3 0xA9; split the UTF-8 sequence across two chunks. Per-chunk
      // decoding would yield replacement chars; decode-once preserves it.
      const raw = Buffer.from("synthetic-é-secret", "utf-8");
      const mid = raw.indexOf(0xa9); // split between the two bytes of é
      scriptSpawn([{ code: 0 }, { code: 0, stdoutChunks: [raw.subarray(0, mid), raw.subarray(mid)] }]);
      const mod = await freshModule();
      expect(await mod.getSecret("k")).toBe("synthetic-é-secret");
    });

    it("refuses an account containing control characters (injection guard)", async () => {
      const getCalls = scriptSpawn([{ code: 0 }]); // detection only
      const mod = await freshModule();
      expect(await mod.setSecret("evil\nhelp", "v")).toBe(false);
      expect(await mod.getSecret("evil\nhelp")).toBeUndefined();
      // No store subcommand was ever spawned for the unsafe account.
      expect(getCalls().some((c) => c.stdin.includes("add-generic-password"))).toBe(false);
      expect(getCalls().some((c) => c.stdin.includes("find-generic-password"))).toBe(false);
    });
  });

  describe("Windows backend", () => {
    beforeEach(() => platformMock.mockReturnValue("win32"));

    it("invokes the absolute system PowerShell, never the bare name", async () => {
      const getCalls = scriptSpawn([{ code: 0 }]);
      const mod = await freshModule();
      expect(await mod.isKeychainAvailable()).toBe(true);
      const call = getCalls()[0]!;
      const normalized = call.file.replace(/\\/g, "/");
      expect(normalized).toBe("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
      expect(call.file).not.toBe("powershell");
      expect(call.args).toContain("-NoProfile");
      expect(call.args).toContain("-NonInteractive");
    });

    it("passes the secret via env (AGAV_KC_SECRET), never on the command line", async () => {
      const getCalls = scriptSpawn([{ code: 0 }, { code: 0 }]);
      const mod = await freshModule();
      expect(await mod.setSecret("openai-api-key", "sk-secret")).toBe(true);
      const call = getCalls().find((c) => c.args.join(" ").includes("ProtectedData"));
      expect(call).toBeDefined();
      expect(call!.args.join(" ")).not.toContain("sk-secret");
      expect(call!.env?.AGAV_KC_SECRET).toBe("sk-secret");
      expect(call!.args.join(" ")).toContain("$LASTEXITCODE");
    });

    it("reports failure when the PowerShell store script exits non-zero", async () => {
      scriptSpawn([{ code: 0 }, { code: 1 }]);
      const mod = await freshModule();
      expect(await mod.setSecret("k", "v")).toBe(false);
    });
  });

  describe("timeout handling and circuit breaker", () => {
    beforeEach(() => platformMock.mockReturnValue("darwin"));

    it("fails and force-kills a hung child at the deadline (SIGTERM then SIGKILL)", async () => {
      vi.useFakeTimers();
      const getCalls = scriptSpawn([{ code: 0 }, { hang: true }]);
      const mod = await freshModule();
      const p = mod.getSecret("a");
      // Let detection resolve, then advance to the per-call deadline.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000); // CALL_TIMEOUT_MS
      // After the deadline the call settles as failure without waiting for close.
      expect(await p).toBeUndefined();
      const hung = getCalls().find((c) => c.args[0] === "-i");
      expect(hung!.killed).toContain("SIGTERM");
      // Escalation to SIGKILL after the grace period.
      await vi.advanceTimersByTimeAsync(600);
      expect(hung!.killed).toContain("SIGKILL");
    });

    it("trips the breaker on timeout so later calls fast-fail without spawning", async () => {
      vi.useFakeTimers();
      const getCalls = scriptSpawn([{ code: 0 }, { hang: true }]);
      const mod = await freshModule();
      const p = mod.getSecret("a");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      const spawnsAfter = getCalls().length;
      vi.useRealTimers();
      expect(await mod.getSecret("b")).toBeUndefined();
      expect(await mod.setSecret("c", "v")).toBe(false);
      expect(getCalls().length).toBe(spawnsAfter);
      expect(mod.isStoreUnresponsive()).toBe(true);
    });

    it("a WRITE timeout blocks further writes but NOT reads (regression: dropped key)", async () => {
      vi.useFakeTimers();
      // detection ok, setSecret hangs (write timeout), then getSecret succeeds.
      const b64 = Buffer.from("sk-live", "utf-8").toString("base64");
      const getCalls = scriptSpawn([
        { code: 0 },          // detection
        { hang: true },       // setSecret → write timeout
        { code: 0, stdout: `${b64}\n` }, // getSecret → must still be attempted
      ]);
      const mod = await freshModule();
      const setP = mod.setSecret("a", "v");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await setP).toBe(false);
      expect(mod.isStoreUnresponsive()).toBe(true); // write breaker tripped
      vi.useRealTimers();
      // The read is NOT suppressed by the write timeout — the key resolves.
      expect(await mod.getSecret("a")).toBe("sk-live");
      // A further write is still blocked.
      const before = getCalls().length;
      expect(await mod.setSecret("b", "v")).toBe(false);
      expect(getCalls().length).toBe(before);
    });

    it("a READ timeout blocks further reads", async () => {
      vi.useFakeTimers();
      const getCalls = scriptSpawn([{ code: 0 }, { hang: true }]);
      const mod = await freshModule();
      const p = mod.getSecret("a");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      vi.useRealTimers();
      const before = getCalls().length;
      expect(await mod.getSecret("b")).toBeUndefined();
      expect(getCalls().length).toBe(before); // no further read spawned
    });

    it("detection timeout: cools down (no re-probe per key), then recovers after cooldown", async () => {
      vi.useFakeTimers();
      const b64 = Buffer.from("sk-live", "utf-8").toString("base64");
      // 1st call = detection, hangs → times out (NOT cached as permanent "none").
      // 2nd call = detection retry succeeds; 3rd = the actual read.
      const getCalls = scriptSpawn([
        { hang: true },                   // detection #1 times out
        { code: 0 },                      // detection #2 succeeds (after cooldown)
        { code: 0, stdout: `${b64}\n` },  // read
      ]);
      const mod = await freshModule();
      const p1 = mod.getSecret("a");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000); // detection #1 deadline
      expect(await p1).toBeUndefined();        // this call fails (store was slow)

      // Within the cooldown, further reads fast-fail WITHOUT re-probing (so N keys
      // don't each pay a detection timeout).
      expect(await mod.getSecret("b")).toBeUndefined();
      expect(getCalls().length).toBe(1); // only the timed-out probe ran

      // Remain on the fake clock: the cooldown starts at the timeout, not at
      // probe launch. Even one millisecond before expiry must not re-probe.
      await vi.advanceTimersByTimeAsync(29_999);
      expect(await mod.getSecret("b")).toBeUndefined();
      expect(getCalls().length).toBe(1);

      // At the actual expiry (no test-only reset), detection retries and reads
      // recover even though the detection timeout left the write breaker set.
      await vi.advanceTimersByTimeAsync(1);
      expect(await mod.getSecret("a")).toBe("sk-live");
      expect(getCalls().length).toBe(3);
      expect(getCalls().map((call) => call.args)).toEqual([["help"], ["help"], ["-i"]]);
      expect(mod.isStoreUnresponsive()).toBe(true);
      expect(await mod.setSecret("a", "replacement")).toBe(false);
      expect(getCalls().length).toBe(3);
    });
  });

  describe("unsupported platform", () => {
    it("reports no store and never shells out for secrets", async () => {
      platformMock.mockReturnValue("aix" as NodeJS.Platform);
      const getCalls = scriptSpawn([]);
      const mod = await freshModule();
      expect(await mod.isKeychainAvailable()).toBe(false);
      expect(await mod.setSecret("k", "v")).toBe(false);
      expect(await mod.getSecret("k")).toBeUndefined();
      expect(getCalls().every((c) => c.file !== "security" && c.file !== "secret-tool")).toBe(true);
    });
  });

  describe("input guards", () => {
    it("rejects empty account or secret without touching the store", async () => {
      platformMock.mockReturnValue("darwin");
      const getCalls = scriptSpawn([{ code: 0 }]);
      const mod = await freshModule();
      expect(await mod.setSecret("", "v")).toBe(false);
      expect(await mod.setSecret("k", "")).toBe(false);
      expect(await mod.getSecret("")).toBeUndefined();
      expect(getCalls().some((c) => c.stdin.includes("add-generic-password"))).toBe(false);
    });
  });
});
