import { beforeEach, describe, expect, it, vi } from "vitest";

// Stable home + user so the encryption key and paths are deterministic.
vi.mock("node:os", () => ({
  homedir: () => "/Users/test",
  userInfo: () => ({ username: "agav" }),
  platform: () => "darwin",
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

const fs = await import("node:fs/promises");
const readFile = vi.mocked(fs.readFile);
const writeFile = vi.mocked(fs.writeFile);
const rename = vi.mocked(fs.rename);
const rm = vi.mocked(fs.rm);

const { encrypt, isEncrypted } = await import("../utils/encrypt.js");
const {
  loadEnrolledPolicy,
  saveEnrolledPolicy,
  clearEnrolledPolicy,
  enterprisePolicyPath,
} = await import("../config/enterprise-policy-store.js");
import type { EnrolledPolicy } from "../config/enterprise-policy-store.js";

const record: EnrolledPolicy = {
  policy: { provider: "openai", openaiBaseURL: "https://gw/v1", permissionMode: "ask" },
  gatewayToken: "gw-secret",
  controlPlane: "https://auth.corp",
  subject: "jane@corp.com",
  storedAt: "2026-01-01T00:00:00.000Z",
};

describe("enterprise-policy-store", () => {
  beforeEach(() => {
    readFile.mockReset();
    writeFile.mockReset().mockResolvedValue(undefined);
    rename.mockReset().mockResolvedValue(undefined);
    rm.mockReset().mockResolvedValue(undefined);
  });

  it("returns undefined when no policy file exists", async () => {
    readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    expect(await loadEnrolledPolicy()).toBeUndefined();
  });

  it("reads and decrypts a stored policy record", async () => {
    readFile.mockResolvedValue(encrypt(JSON.stringify(record)));
    const loaded = await loadEnrolledPolicy();
    expect(loaded?.policy.provider).toBe("openai");
    expect(loaded?.policy.openaiBaseURL).toBe("https://gw/v1");
    expect(loaded?.gatewayToken).toBe("gw-secret");
    expect(loaded?.subject).toBe("jane@corp.com");
  });

  it("refuses a plaintext (unencrypted) policy file", async () => {
    readFile.mockResolvedValue(JSON.stringify(record)); // not encrypted
    expect(await loadEnrolledPolicy()).toBeUndefined();
  });

  it("returns undefined for a record missing a policy object", async () => {
    readFile.mockResolvedValue(encrypt(JSON.stringify({ storedAt: "x" })));
    expect(await loadEnrolledPolicy()).toBeUndefined();
  });

  it("never throws on corrupt ciphertext", async () => {
    readFile.mockResolvedValue("enc:not-valid-base64-or-tag");
    expect(await loadEnrolledPolicy()).toBeUndefined();
  });

  it("still returns an expired policy (offline enforcement; refresh is caller's job)", async () => {
    const expired: EnrolledPolicy = { ...record, expiresAt: 1 };
    readFile.mockResolvedValue(encrypt(JSON.stringify(expired)));
    const loaded = await loadEnrolledPolicy();
    expect(loaded?.policy.provider).toBe("openai");
  });

  it("writes the policy encrypted, atomically (temp file + rename), 0o600", async () => {
    await saveEnrolledPolicy(record);
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [tmpPath, data, opts] = writeFile.mock.calls[0]!;
    expect(String(tmpPath)).toMatch(/policy\.json\.[0-9a-f]+\.tmp$/);
    expect(isEncrypted(String(data))).toBe(true);
    expect(opts).toMatchObject({ mode: 0o600, flag: "wx" });
    // Atomic publish: rename temp -> final.
    expect(rename).toHaveBeenCalledTimes(1);
    expect(String(rename.mock.calls[0]![1])).toBe(enterprisePolicyPath());
  });

  it("round-trips a saved record back through load", async () => {
    let written = "";
    writeFile.mockImplementation(async (_p: unknown, data: unknown) => {
      written = String(data);
    });
    await saveEnrolledPolicy(record);
    readFile.mockResolvedValue(written);
    const loaded = await loadEnrolledPolicy();
    expect(loaded?.policy).toEqual(record.policy);
    expect(loaded?.controlPlane).toBe("https://auth.corp");
  });

  it("clear removes the policy file without throwing when absent", async () => {
    rm.mockResolvedValue(undefined);
    await expect(clearEnrolledPolicy()).resolves.toBeUndefined();
    expect(rm).toHaveBeenCalledWith(enterprisePolicyPath(), { force: true });
  });

  it("propagates an I/O failure so logout cannot falsely report success", async () => {
    // On a read-only filesystem or a non-writable directory the cached policy
    // stays active; the failure must surface instead of being swallowed.
    rm.mockRejectedValue(Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" }));
    await expect(clearEnrolledPolicy()).rejects.toThrow(/read-only/);
  });
});
