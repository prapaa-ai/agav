import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:os", () => ({ platform: vi.fn() }));

import { execFile } from "node:child_process";
import { platform } from "node:os";

const execFileMock = vi.mocked(execFile);
const platformMock = vi.mocked(platform);

interface Response {
  code: number;
  stdout?: string;
  /** When true, simulate a timeout-killed child (sets error.killed). */
  timeout?: boolean;
  /** When set, the child's stdin emits this error asynchronously (e.g. EPIPE). */
  stdinError?: string;
}

/**
 * Queue a scripted response per execFile invocation, matched in call order.
 * Captures each call's file, args, env and stdin so transport can be asserted.
 */
function scriptExecFile(responses: Response[]) {
  const calls: Array<{ file: string; args: string[]; env?: Record<string, string | undefined>; stdin: string }> = [];
  let index = 0;
  execFileMock.mockImplementation(((file: any, args: any, options: any, callback: any) => {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? {} : options;
    const record = { file, args: args ?? [], env: opts?.env, stdin: "" };
    calls.push(record);
    const response = responses[index++] ?? { code: 0, stdout: "" };
    const child = new EventEmitter() as any;
    const stdin = new EventEmitter() as any;
    stdin.end = (data?: string) => { if (data) record.stdin += data; };
    child.stdin = stdin;
    queueMicrotask(() => {
      if (response.stdinError) stdin.emit("error", Object.assign(new Error(response.stdinError), { code: response.stdinError }));
      if (response.code === 0) {
        cb(null, response.stdout ?? "", "");
      } else {
        const err: any = new Error("command failed");
        err.code = response.code;
        if (response.timeout) err.killed = true;
        cb(err, response.stdout ?? "", "");
      }
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
    // A stable SystemRoot so the Windows PowerShell path is deterministic.
    process.env.SystemRoot = "C:\\Windows";
  });
  afterEach(() => {
    platformMock.mockReset();
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
      const getCalls = scriptExecFile([
        { code: 0 }, // security help (detection)
        { code: 0 }, // security -i (add)
      ]);
      const mod = await freshModule();
      expect(await mod.setSecret("openai-api-key", "sk-secret")).toBe(true);
      const call = getCalls().find((c) => c.file === "security" && c.args[0] === "-i");
      expect(call).toBeDefined();
      // The secret must not appear in argv at all; it is fed over stdin.
      expect(call!.args.join(" ")).not.toContain("sk-secret");
      // Base64 of the secret is what gets written on stdin (lossless round-trip).
      const b64 = Buffer.from("sk-secret", "utf-8").toString("base64");
      expect(call!.stdin).toContain("add-generic-password");
      expect(call!.stdin).toContain(b64);
      expect(call!.stdin).not.toContain("sk-secret");
    });

    it("round-trips a secret through base64 on read", async () => {
      const b64 = Buffer.from("sk-secret", "utf-8").toString("base64");
      scriptExecFile([
        { code: 0 }, // detection
        { code: 0, stdout: `${b64}\n` }, // security -i (find)
      ]);
      const mod = await freshModule();
      expect(await mod.getSecret("openai-api-key")).toBe("sk-secret");
    });

    it("round-trips a secret containing newlines/non-printable bytes losslessly", async () => {
      const raw = "a\nb\tc";
      const b64 = Buffer.from(raw, "utf-8").toString("base64");
      const getCalls = scriptExecFile([
        { code: 0 }, // detection
        { code: 0 }, // set
        { code: 0, stdout: `${b64}\n` }, // get
      ]);
      const mod = await freshModule();
      expect(await mod.setSecret("k", raw)).toBe(true);
      expect(await mod.getSecret("k")).toBe(raw);
      const setCall = getCalls().find((c) => c.stdin.includes("add-generic-password"));
      expect(setCall!.stdin).toContain(b64);
    });

    it("returns undefined when the item is absent (non-zero exit)", async () => {
      scriptExecFile([
        { code: 0 }, // detection
        { code: 44 }, // find: not found
      ]);
      const mod = await freshModule();
      expect(await mod.getSecret("missing")).toBeUndefined();
    });

    it("reports availability when `security help` succeeds", async () => {
      scriptExecFile([{ code: 0 }]);
      const mod = await freshModule();
      expect(await mod.isKeychainAvailable()).toBe(true);
    });
  });

  describe("Linux secret-tool backend", () => {
    beforeEach(() => platformMock.mockReturnValue("linux"));

    it("detects availability via a read-only `search` probe (not --version)", async () => {
      const getCalls = scriptExecFile([{ code: 0 }]); // search succeeds on a reachable service
      const mod = await freshModule();
      expect(await mod.isKeychainAvailable()).toBe(true);
      const probe = getCalls()[0]!;
      expect(probe.file).toBe("secret-tool");
      expect(probe.args[0]).toBe("search");
      expect(probe.args).not.toContain("--version");
    });

    it("feeds the secret through stdin, never argv", async () => {
      const getCalls = scriptExecFile([
        { code: 0 }, // search (detection)
        { code: 0 }, // store
      ]);
      const mod = await freshModule();
      expect(await mod.setSecret("openai-api-key", "sk-secret")).toBe(true);
      const call = getCalls().find((c) => c.args[0] === "store");
      expect(call).toBeDefined();
      expect(call!.args.join(" ")).not.toContain("sk-secret");
      expect(call!.stdin).toBe("sk-secret");
    });

    it("looks a secret up by its attributes", async () => {
      scriptExecFile([
        { code: 0 }, // detection
        { code: 0, stdout: "sk-secret" }, // lookup
      ]);
      const mod = await freshModule();
      expect(await mod.getSecret("openai-api-key")).toBe("sk-secret");
    });

    it("treats an unreachable service / missing CLI as no credential store", async () => {
      scriptExecFile([{ code: 1 }]); // search probe fails
      const mod = await freshModule();
      expect(await mod.isKeychainAvailable()).toBe(false);
      expect(await mod.setSecret("k", "v")).toBe(false);
      expect(await mod.getSecret("k")).toBeUndefined();
    });

    it("does not crash when the child closes stdin early (EPIPE) and reports failure", async () => {
      scriptExecFile([
        { code: 0 }, // detection
        { code: 1, stdinError: "EPIPE" }, // store child dies, stdin errors
      ]);
      const mod = await freshModule();
      expect(await mod.setSecret("k", "v")).toBe(false);
    });
  });

  describe("Windows backend", () => {
    beforeEach(() => platformMock.mockReturnValue("win32"));

    it("invokes the absolute system PowerShell, never the bare name", async () => {
      const getCalls = scriptExecFile([{ code: 0 }]); // detection
      const mod = await freshModule();
      expect(await mod.isKeychainAvailable()).toBe(true);
      const call = getCalls()[0]!;
      // Must be the absolute system path rooted at SystemRoot — never the bare
      // "powershell" name, which libuv would resolve from the CWD first.
      // (path.join uses the host separator, so normalize before matching.)
      const normalized = call.file.replace(/\\/g, "/");
      expect(normalized).toBe("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
      expect(call.file).not.toBe("powershell");
      expect(call.args).toContain("-NoProfile");
      expect(call.args).toContain("-NonInteractive");
    });

    it("passes the secret via env (AGAV_KC_SECRET), never on the command line", async () => {
      const getCalls = scriptExecFile([
        { code: 0 }, // detection
        { code: 0 }, // store script
      ]);
      const mod = await freshModule();
      expect(await mod.setSecret("openai-api-key", "sk-secret")).toBe(true);
      const call = getCalls().find((c) => c.args.join(" ").includes("ProtectedData"));
      expect(call).toBeDefined();
      expect(call!.args.join(" ")).not.toContain("sk-secret");
      expect(call!.env?.AGAV_KC_SECRET).toBe("sk-secret");
      // The store script makes the native cmdkey exit status authoritative.
      expect(call!.args.join(" ")).toContain("$LASTEXITCODE");
    });

    it("reports failure when the PowerShell store script exits non-zero", async () => {
      scriptExecFile([
        { code: 0 }, // detection
        { code: 1 }, // store script fails (e.g. cmdkey error → exit 1)
      ]);
      const mod = await freshModule();
      expect(await mod.setSecret("k", "v")).toBe(false);
    });
  });

  describe("circuit breaker", () => {
    beforeEach(() => platformMock.mockReturnValue("darwin"));

    it("fast-fails subsequent calls after one timeout, avoiding serial timeouts", async () => {
      const getCalls = scriptExecFile([
        { code: 0 }, // detection
        { code: 1, timeout: true }, // first getSecret times out → trips breaker
      ]);
      const mod = await freshModule();
      expect(await mod.getSecret("a")).toBeUndefined();
      // Further calls must not spawn any more processes.
      const spawnsAfter = getCalls().length;
      expect(await mod.getSecret("b")).toBeUndefined();
      expect(await mod.setSecret("c", "v")).toBe(false);
      expect(getCalls().length).toBe(spawnsAfter);
    });
  });

  describe("unsupported platform", () => {
    it("reports no store and never shells out for secrets", async () => {
      platformMock.mockReturnValue("aix" as NodeJS.Platform);
      const getCalls = scriptExecFile([]);
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
      const getCalls = scriptExecFile([{ code: 0 }]);
      const mod = await freshModule();
      expect(await mod.setSecret("", "v")).toBe(false);
      expect(await mod.setSecret("k", "")).toBe(false);
      expect(await mod.getSecret("")).toBeUndefined();
      expect(getCalls().some((c) => c.stdin.includes("add-generic-password"))).toBe(false);
    });
  });
});
