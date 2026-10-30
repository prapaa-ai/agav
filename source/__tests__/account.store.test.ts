import { beforeEach, describe, expect, it, vi } from "vitest";

// Stable home + user so the encryption key and paths are deterministic.
vi.mock("node:os", () => ({
  homedir: () => "/Users/test",
  userInfo: () => ({ username: "agav" }),
  platform: () => "darwin",
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  open: vi.fn().mockImplementation(async () => ({
    writeFile: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  unlink: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

// Mock the OS credential store so we can toggle availability and inspect calls.
vi.mock("../utils/keychain.js", () => ({
  setSecret: vi.fn(),
  getSecret: vi.fn(),
  deleteSecret: vi.fn().mockResolvedValue(undefined),
  isKeychainRef: (v: string) => v.startsWith("keychain:"),
  keychainRef: (a: string) => `keychain:${a}`,
  keychainAccount: (v: string) => (v.startsWith("keychain:") ? v.slice("keychain:".length) : ""),
}));

const fs = await import("node:fs/promises");
const readFile = vi.mocked(fs.readFile);
const writeFile = vi.mocked(fs.writeFile);
const rename = vi.mocked(fs.rename);
const rm = vi.mocked(fs.rm);

const keychain = await import("../utils/keychain.js");
const setSecret = vi.mocked(keychain.setSecret);
const getSecret = vi.mocked(keychain.getSecret);
const deleteSecret = vi.mocked(keychain.deleteSecret);

const { encrypt, decrypt, isEncrypted } = await import("../utils/encrypt.js");
const {
  loadStoredAccount,
  saveStoredAccount,
  clearStoredAccount,
  accountStorePath,
  KEYCHAIN_PREFIX,
  SaveCancelledError,
} = await import("../account/account-store.js");
import type { StoredAccount } from "../account/types.js";

const record: StoredAccount = {
  apiKey: "agav_sk_secret",
  accountId: "acct_1",
  email: "a@b.com",
  status: "active",
  accountService: "https://agav.dev",
  storedAt: "2026-01-01T00:00:00.000Z",
};

/** Make readFile behave as "no existing account file". */
function noExistingFile() {
  readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
}

describe("account-store", () => {
  beforeEach(() => {
    readFile.mockReset();
    writeFile.mockReset().mockResolvedValue(undefined);
    rename.mockReset().mockResolvedValue(undefined);
    rm.mockReset().mockResolvedValue(undefined);
    setSecret.mockReset();
    getSecret.mockReset();
    deleteSecret.mockReset().mockResolvedValue(undefined);
  });

  it("stores the metadata under ~/.agav/account/account.json", () => {
    expect(accountStorePath()).toBe("/Users/test/.agav/account/account.json");
  });

  it("returns undefined when no account is stored", async () => {
    noExistingFile();
    expect(await loadStoredAccount()).toBeUndefined();
  });

  it("refuses a plaintext (unencrypted) metadata file", async () => {
    readFile.mockResolvedValue(JSON.stringify(record)); // not encrypted
    expect(await loadStoredAccount()).toBeUndefined();
  });

  it("returns undefined for a record missing required fields", async () => {
    readFile.mockResolvedValue(encrypt(JSON.stringify({ email: "a@b.com" })));
    expect(await loadStoredAccount()).toBeUndefined();
  });

  describe("with an available OS credential store", () => {
    it("stores the key under a unique keychain account and only a reference in the file", async () => {
      noExistingFile();
      setSecret.mockResolvedValue(true);
      await saveStoredAccount(record);

      // The secret was written to a UNIQUE account name (prefix + suffix).
      expect(setSecret).toHaveBeenCalledTimes(1);
      const [acctName, secret] = setSecret.mock.calls[0]!;
      expect(acctName.startsWith(`${KEYCHAIN_PREFIX}:`)).toBe(true);
      expect(secret).toBe("agav_sk_secret");

      const [tempPath, content, opts] = writeFile.mock.calls[0]!;
      expect(String(tempPath)).toMatch(/account\.json\.[0-9a-f]+\.tmp$/);
      expect(isEncrypted(content as string)).toBe(true);
      expect(content).not.toContain("agav_sk_secret");
      const onDisk = JSON.parse(decrypt(content as string));
      expect(onDisk.apiKey).toBe(`keychain:${acctName}`);
      expect(opts).toMatchObject({ mode: 0o600, flag: "wx" });
      expect(rename).toHaveBeenCalledWith(tempPath, "/Users/test/.agav/account/account.json");
    });

    it("resolves the key back from the keychain on load", async () => {
      const acct = `${KEYCHAIN_PREFIX}:abc123`;
      readFile.mockResolvedValue(encrypt(JSON.stringify({ ...record, apiKey: `keychain:${acct}` })));
      getSecret.mockResolvedValue("agav_sk_secret");
      const loaded = await loadStoredAccount();
      expect(loaded?.apiKey).toBe("agav_sk_secret");
      expect(getSecret).toHaveBeenCalledWith(acct);
    });

    it("treats a keychain-referenced record as signed out if the secret is gone", async () => {
      const acct = `${KEYCHAIN_PREFIX}:abc123`;
      readFile.mockResolvedValue(encrypt(JSON.stringify({ ...record, apiKey: `keychain:${acct}` })));
      getSecret.mockResolvedValue(undefined);
      expect(await loadStoredAccount()).toBeUndefined();
    });

    it("deletes the PREVIOUS keychain entry only AFTER the new metadata commits", async () => {
      const prevAcct = `${KEYCHAIN_PREFIX}:old`;
      // Existing metadata points at the previous keychain account.
      readFile.mockResolvedValue(encrypt(JSON.stringify({ ...record, apiKey: `keychain:${prevAcct}` })));
      setSecret.mockResolvedValue(true);
      await saveStoredAccount({ ...record, accountId: "acct_2" });

      // New secret stored under a fresh name; metadata committed; THEN old deleted.
      const newAcct = setSecret.mock.calls[0]![0];
      expect(newAcct).not.toBe(prevAcct);
      expect(rename).toHaveBeenCalled();
      expect(deleteSecret).toHaveBeenCalledWith(prevAcct);
    });

    it("cancel BEFORE commit keeps the previous account fully intact", async () => {
      const prevAcct = `${KEYCHAIN_PREFIX}:old`;
      // Existing (account A) metadata + credential.
      readFile.mockResolvedValue(encrypt(JSON.stringify({ ...record, accountId: "A", apiKey: `keychain:${prevAcct}` })));
      setSecret.mockResolvedValue(true);
      const controller = new AbortController();
      controller.abort(); // cancelled before the commit check

      await expect(
        saveStoredAccount({ ...record, accountId: "B" }, { signal: controller.signal }),
      ).rejects.toBeInstanceOf(SaveCancelledError);

      // The NEW (B) credential is deleted; the metadata file was NEVER rewritten
      // (no rename), and A's previous credential was NOT deleted.
      const newAcct = setSecret.mock.calls[0]![0];
      expect(deleteSecret).toHaveBeenCalledWith(newAcct);
      expect(deleteSecret).not.toHaveBeenCalledWith(prevAcct);
      expect(rename).not.toHaveBeenCalled();
    });

    it("cancels during the temp write and preserves the previous metadata and credential", async () => {
      const prevAcct = `${KEYCHAIN_PREFIX}:old`;
      const previous = { ...record, accountId: "A" };
      const previousMetadata = encrypt(JSON.stringify({ ...previous, apiKey: `keychain:${prevAcct}` }));
      readFile.mockResolvedValue(previousMetadata);
      getSecret.mockResolvedValue(previous.apiKey);
      setSecret.mockResolvedValue(true);
      const controller = new AbortController();
      writeFile.mockImplementationOnce(async () => {
        expect(controller.signal.aborted).toBe(false);
        await Promise.resolve();
        controller.abort();
      });

      await expect(
        saveStoredAccount({ ...record, accountId: "B", apiKey: "agav_sk_new" }, { signal: controller.signal }),
      ).rejects.toBeInstanceOf(SaveCancelledError);

      const newAcct = setSecret.mock.calls[0]![0];
      const temporary = writeFile.mock.calls[0]![0];
      expect(newAcct).not.toBe(prevAcct);
      expect(rename).not.toHaveBeenCalled();
      expect(rm).toHaveBeenCalledExactlyOnceWith(temporary, { force: true });
      expect(deleteSecret).toHaveBeenCalledExactlyOnceWith(newAcct);
      expect(deleteSecret).not.toHaveBeenCalledWith(prevAcct);
      expect(await loadStoredAccount()).toEqual(previous);
      expect(getSecret).toHaveBeenCalledWith(prevAcct);
    });

    it("keeps a successful commit when cancellation arrives after rename", async () => {
      const prevAcct = `${KEYCHAIN_PREFIX}:old`;
      readFile.mockResolvedValue(encrypt(JSON.stringify({ ...record, apiKey: `keychain:${prevAcct}` })));
      setSecret.mockResolvedValue(true);
      const next = { ...record, accountId: "B", apiKey: "agav_sk_new" };
      const controller = new AbortController();
      rename.mockImplementationOnce(async () => {
        expect(controller.signal.aborted).toBe(false);
        // Publish the new metadata before cancellation, as a completed rename does.
        readFile.mockResolvedValue(writeFile.mock.calls[0]![1] as string);
        controller.abort();
      });
      getSecret.mockResolvedValue(next.apiKey);

      await expect(saveStoredAccount(next, { signal: controller.signal })).resolves.toBeUndefined();

      const newAcct = setSecret.mock.calls[0]![0];
      expect(rename).toHaveBeenCalledExactlyOnceWith(writeFile.mock.calls[0]![0], accountStorePath());
      expect(deleteSecret).toHaveBeenCalledExactlyOnceWith(prevAcct);
      expect(deleteSecret).not.toHaveBeenCalledWith(newAcct);
      expect(await loadStoredAccount()).toEqual(next);
      expect(getSecret).toHaveBeenCalledWith(newAcct);
    });

    it("on a metadata-commit failure, rolls back the new secret and keeps the old one", async () => {
      const prevAcct = `${KEYCHAIN_PREFIX}:old`;
      readFile.mockResolvedValue(encrypt(JSON.stringify({ ...record, apiKey: `keychain:${prevAcct}` })));
      setSecret.mockResolvedValue(true);
      rename.mockRejectedValueOnce(new Error("EIO"));

      await expect(saveStoredAccount({ ...record, accountId: "acct_2" })).rejects.toThrow(/EIO/);

      const newAcct = setSecret.mock.calls[0]![0];
      // The just-written NEW secret is rolled back; the OLD one is NOT deleted
      // (existing metadata still resolves to it).
      expect(deleteSecret).toHaveBeenCalledWith(newAcct);
      expect(deleteSecret).not.toHaveBeenCalledWith(prevAcct);
    });
  });

  describe("without a credential store (file fallback)", () => {
    it("AES-encrypts the key inline when the keychain is unavailable", async () => {
      noExistingFile();
      setSecret.mockResolvedValue(false);
      await saveStoredAccount(record);
      const [, content] = writeFile.mock.calls[0]!;
      const onDisk = JSON.parse(decrypt(content as string));
      expect(onDisk.apiKey).not.toBe("agav_sk_secret");
      expect(isEncrypted(onDisk.apiKey)).toBe(true);
    });

    it("decrypts the inline key on load", async () => {
      readFile.mockResolvedValue(encrypt(JSON.stringify({ ...record, apiKey: encrypt("agav_sk_secret") })));
      const loaded = await loadStoredAccount();
      expect(loaded?.apiKey).toBe("agav_sk_secret");
    });
  });

  it("clears the referenced keychain entry AND the file on sign-out", async () => {
    const acct = `${KEYCHAIN_PREFIX}:abc123`;
    readFile.mockResolvedValue(encrypt(JSON.stringify({ ...record, apiKey: `keychain:${acct}` })));
    await clearStoredAccount();
    expect(deleteSecret).toHaveBeenCalledWith(acct);
    expect(rm).toHaveBeenCalledWith("/Users/test/.agav/account/account.json", { force: true });
  });

  it("removes metadata BEFORE deleting the credential, and keeps the credential if metadata removal fails", async () => {
    const acct = `${KEYCHAIN_PREFIX}:abc123`;
    readFile.mockResolvedValue(encrypt(JSON.stringify({ ...record, apiKey: `keychain:${acct}` })));
    rm.mockRejectedValueOnce(new Error("EROFS"));
    await expect(clearStoredAccount()).rejects.toThrow(/EROFS/);
    // Metadata removal failed → the credential must NOT have been deleted, so the
    // account stays fully usable and "still connected" is truthful.
    expect(deleteSecret).not.toHaveBeenCalled();
  });
});
