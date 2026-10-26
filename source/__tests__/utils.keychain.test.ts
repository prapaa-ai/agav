import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:os", () => ({ platform: vi.fn() }));

import { execFile } from "node:child_process";
import { platform } from "node:os";

const execFileMock = vi.mocked(execFile);
const platformMock = vi.mocked(platform);

/**
 * Queue a scripted response per execFile invocation. Each entry is matched in
 * call order; the child's stdin is captured so stdin-fed secrets can be
 * asserted. Returns a getter for the recorded calls.
 */
function scriptExecFile(responses: Array<{ code: number; stdout?: string }>) {
  const calls: Array<{ file: string; args: string[]; env?: Record<string, string | undefined>; stdin: string }> = [];
  let index = 0;
  execFileMock.mockImplementation(((file: any, args: any, options: any, callback: any) => {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? {} : options;
    const record = { file, args: args ?? [], env: opts?.env, stdin: "" };
    calls.push(record);
    const child = new EventEmitter() as any;
    child.stdin = { end: (data?: string) => { if (data) record.stdin += data; } };
    const response = responses[index++] ?? { code: 0, stdout: "" };
    queueMicrotask(() => {
      if (response.code === 0) {
        cb(null, response.stdout ?? "", "");
      } else {
        cb(Object.assign(new Error("command failed"), { code: response.code }), response.stdout ?? "", "");
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
  return mod;
}

describe("utils/keychain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    platformMock.mockReset();
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

    it("stores a secret via `security add-generic-password` without a shell", async () => {
      const getCalls = scriptExecFile([
        { code: 0 }, // security help (detection)
        { code: 0 }, // add-generic-password
      ]);
      const mod = await freshModule();
      expect(await mod.setSecret("openai-api-key", "sk-secret")).toBe(true);
      const call = getCalls().find((c) => c.args[0] === "add-generic-password");
      expect(call).toBeDefined();
      expect(call!.file).toBe("security");
      expect(call!.args).toContain("-U");
      expect(call!.args).toContain("agav-cli");
      expect(call!.args).toContain("openai-api-key");
      expect(call!.args).toContain("sk-secret");
    });

    it("retrieves a secret and trims the trailing newline", async () => {
      scriptExecFile([
        { code: 0 }, // detection
        { code: 0, stdout: "sk-secret\n" }, // find-generic-password -w
      ]);
      const mod = await freshModule();
      expect(await mod.getSecret("openai-api-key")).toBe("sk-secret");
    });

    it("returns undefined when the item is absent (non-zero exit)", async () => {
      scriptExecFile([
        { code: 0 }, // detection
        { code: 44 }, // find-generic-password: not found
      ]);
      const mod = await freshModule();
      expect(await mod.getSecret("missing")).toBeUndefined();
    });

    it("reports availability when `security` is callable", async () => {
      scriptExecFile([{ code: 0 }]);
      const mod = await freshModule();
      expect(await mod.isKeychainAvailable()).toBe(true);
    });
  });

  describe("Linux secret-tool backend", () => {
    beforeEach(() => platformMock.mockReturnValue("linux"));

    it("feeds the secret through stdin, never argv", async () => {
      const getCalls = scriptExecFile([
        { code: 0 }, // secret-tool --version (detection)
        { code: 0 }, // store
      ]);
      const mod = await freshModule();
      expect(await mod.setSecret("openai-api-key", "sk-secret")).toBe(true);
      const call = getCalls().find((c) => c.args[0] === "store");
      expect(call).toBeDefined();
      expect(call!.file).toBe("secret-tool");
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

    it("treats a missing libsecret CLI as no credential store", async () => {
      scriptExecFile([{ code: 1 }]); // secret-tool --version fails (ENOENT → code 1)
      const mod = await freshModule();
      expect(await mod.isKeychainAvailable()).toBe(false);
      // With no store, set/get must degrade quietly to false/undefined.
      expect(await mod.setSecret("k", "v")).toBe(false);
      expect(await mod.getSecret("k")).toBeUndefined();
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
      // Only detection may be attempted; no credential subcommands run.
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
      expect(getCalls().some((c) => c.args[0] === "add-generic-password")).toBe(false);
    });
  });
});
