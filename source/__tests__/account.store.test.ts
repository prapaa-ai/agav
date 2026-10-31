import { beforeEach, describe, expect, it, vi } from "vitest";

// Match path semantics to the mocked macOS home on Windows test hosts too.
vi.mock("node:path", async () => {
  const { posix } = await vi.importActual<typeof import("node:path")>("node:path");
  return { ...posix, default: posix };
});

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

// Account persistence must not import any OS credential subprocess machinery.
vi.mock("node:child_process", () => {
  throw new Error("Account storage must not access OS credentials");
});

const fs = await import("node:fs/promises");
const readFile = vi.mocked(fs.readFile);
const writeFile = vi.mocked(fs.writeFile);
const rename = vi.mocked(fs.rename);
const rm = vi.mocked(fs.rm);

const { encrypt, decrypt, isEncrypted } = await import("../utils/encrypt.js");
const {
  loadStoredAccount,
  saveStoredAccount,
  clearStoredAccount,
  accountStorePath,
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

function storedFile(account = record) {
  return encrypt(JSON.stringify({ ...account, apiKey: encrypt(account.apiKey) }));
}

function noExistingFile() {
  readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
}

describe("account-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readFile.mockReset();
    writeFile.mockReset().mockResolvedValue(undefined);
    rename.mockReset().mockResolvedValue(undefined);
    rm.mockReset().mockResolvedValue(undefined);
  });

  it("stores the account under ~/.agav/account/account.json", () => {
    expect(accountStorePath()).toBe("/Users/test/.agav/account/account.json");
  });

  it("returns undefined when no account is stored", async () => {
    noExistingFile();
    expect(await loadStoredAccount()).toBeUndefined();
  });

  it("refuses a plaintext (unencrypted) metadata file", async () => {
    readFile.mockResolvedValue(JSON.stringify(record));
    expect(await loadStoredAccount()).toBeUndefined();
  });

  it.each([null, [], { email: "a@b.com" }, { ...record, apiKey: 42 }])(
    "returns undefined for an invalid record: %j", async (invalid) => {
      readFile.mockResolvedValue(encrypt(JSON.stringify(invalid)));
      expect(await loadStoredAccount()).toBeUndefined();
    },
  );

  it("returns undefined for corrupt encrypted metadata", async () => {
    readFile.mockResolvedValue("enc:corrupt");
    expect(await loadStoredAccount()).toBeUndefined();
  });

  it("atomically saves an inline-encrypted key inside an encrypted file", async () => {
    noExistingFile();
    await saveStoredAccount(record);

    expect(writeFile).toHaveBeenCalledTimes(1);
    const [tempPath, content, opts] = writeFile.mock.calls[0]!;
    expect(String(tempPath)).toMatch(/account\.json\.[0-9a-f]+\.tmp$/);
    expect(isEncrypted(content as string)).toBe(true);
    expect(content).not.toContain(record.apiKey);
    const onDisk = JSON.parse(decrypt(content as string));
    expect(isEncrypted(onDisk.apiKey)).toBe(true);
    expect(decrypt(onDisk.apiKey)).toBe(record.apiKey);
    expect({ ...onDisk, apiKey: record.apiKey }).toEqual(record);
    expect(opts).toEqual({ mode: 0o600, flag: "wx" });
    expect(fs.mkdir).toHaveBeenCalledWith("/Users/test/.agav/account", { recursive: true, mode: 0o700 });
    expect(rename).toHaveBeenCalledExactlyOnceWith(tempPath, accountStorePath());
    expect(writeFile.mock.invocationCallOrder[0]).toBeLessThan(rename.mock.invocationCallOrder[0]!);
    expect(readFile).not.toHaveBeenCalled();
    readFile.mockResolvedValue(content as string);
    expect(await loadStoredAccount()).toEqual(record);
  });

  it("decrypts the existing inline key on load", async () => {
    readFile.mockResolvedValue(storedFile());
    expect(await loadStoredAccount()).toEqual(record);
  });

  it.each(["keychain:account:agav-api-key:abc123", "keychain:"])(
    "treats legacy reference %s as signed out without OS access", async (apiKey) => {
      readFile.mockResolvedValue(encrypt(JSON.stringify({ ...record, apiKey })));
      expect(await loadStoredAccount()).toBeUndefined();
      expect(writeFile).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
    },
  );

  it("replaces a legacy keychain reference on the next sign-in without reading it", async () => {
    readFile.mockResolvedValue(encrypt(JSON.stringify({ ...record, apiKey: "keychain:old" })));
    await saveStoredAccount(record);
    expect(readFile).not.toHaveBeenCalled();
    readFile.mockResolvedValue(writeFile.mock.calls[0]![1] as string);
    expect(await loadStoredAccount()).toEqual(record);
  });

  it("cancels before writing and keeps the previous account intact", async () => {
    readFile.mockResolvedValue(storedFile());
    const controller = new AbortController();
    controller.abort();

    await expect(saveStoredAccount({ ...record, accountId: "B" }, { signal: controller.signal }))
      .rejects.toBeInstanceOf(SaveCancelledError);

    expect(writeFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
    expect(await loadStoredAccount()).toEqual(record);
  });

  it("cancels during the temp write and preserves the previous account", async () => {
    readFile.mockResolvedValue(storedFile());
    const controller = new AbortController();
    writeFile.mockImplementationOnce(async () => {
      await Promise.resolve();
      controller.abort();
    });

    await expect(saveStoredAccount({ ...record, accountId: "B", apiKey: "agav_sk_new" }, { signal: controller.signal }))
      .rejects.toBeInstanceOf(SaveCancelledError);

    expect(rename).not.toHaveBeenCalled();
    expect(rm).toHaveBeenCalledExactlyOnceWith(writeFile.mock.calls[0]![0], { force: true });
    expect(await loadStoredAccount()).toEqual(record);
  });

  it("keeps a successful commit when cancellation arrives after rename", async () => {
    readFile.mockResolvedValue(storedFile());
    const next = { ...record, accountId: "B", apiKey: "agav_sk_new" };
    const controller = new AbortController();
    rename.mockImplementationOnce(async () => {
      expect(controller.signal.aborted).toBe(false);
      readFile.mockResolvedValue(writeFile.mock.calls[0]![1] as string);
      controller.abort();
    });

    await expect(saveStoredAccount(next, { signal: controller.signal })).resolves.toBeUndefined();
    expect(rename).toHaveBeenCalledExactlyOnceWith(writeFile.mock.calls[0]![0], accountStorePath());
    expect(await loadStoredAccount()).toEqual(next);
  });

  it.each(["write", "rename"])("keeps the previous account and cleans up after a %s failure", async (failure) => {
    readFile.mockResolvedValue(storedFile());
    (failure === "write" ? writeFile : rename).mockRejectedValueOnce(new Error("EIO"));

    await expect(saveStoredAccount({ ...record, accountId: "B" })).rejects.toThrow("EIO");
    if (failure === "write") expect(rename).not.toHaveBeenCalled();
    expect(rm).toHaveBeenCalledExactlyOnceWith(writeFile.mock.calls[0]![0], { force: true });
    expect(await loadStoredAccount()).toEqual(record);
    // A failed save must release the lock so the next save can succeed.
    await expect(saveStoredAccount(record)).resolves.toBeUndefined();
  });

  it("preserves the original commit error if temporary cleanup also fails", async () => {
    readFile.mockResolvedValue(storedFile());
    rename.mockRejectedValueOnce(new Error("EIO"));
    rm.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(saveStoredAccount(record)).rejects.toThrow("EIO");
    expect(await loadStoredAccount()).toEqual(record);
  });

  it("signs out by removing only the file, without reading legacy credentials", async () => {
    readFile.mockResolvedValue(encrypt(JSON.stringify({ ...record, apiKey: "keychain:old" })));
    await clearStoredAccount();
    expect(readFile).not.toHaveBeenCalled();
    expect(rm).toHaveBeenCalledExactlyOnceWith(accountStorePath(), { force: true });
  });

  it("propagates sign-out failure and leaves the account usable", async () => {
    readFile.mockResolvedValue(storedFile());
    rm.mockRejectedValueOnce(new Error("EROFS"));
    await expect(clearStoredAccount()).rejects.toThrow("EROFS");
    expect(await loadStoredAccount()).toEqual(record);
  });
});
