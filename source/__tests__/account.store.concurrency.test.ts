import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => home,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm), writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) };
});
vi.mock("node:child_process", () => {
  throw new Error("Account storage must not access OS credentials");
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
let store: typeof import("../account/account-store.js");
let decrypt: typeof import("../utils/encrypt.js")["decrypt"];
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const record = (id: string) => ({
  apiKey: `secret-${id}`, accountId: id, email: "a@b.com", status: "active",
  accountService: "https://agav.dev", storedAt: "2026-01-01T00:00:00.000Z",
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "agav-account-race-"));
  vi.resetModules();
  store = await import("../account/account-store.js");
  ({ decrypt } = await import("../utils/encrypt.js"));
  vi.mocked(rm).mockReset().mockImplementation(actual.rm);
  vi.mocked(writeFile).mockReset().mockImplementation(actual.writeFile);
  vi.mocked(rename).mockReset().mockImplementation(actual.rename);
});
afterEach(async () => { await actual.rm(home, { recursive: true, force: true }); });

async function expectOnlyCurrentAccount(id: string) {
  expect(await store.loadStoredAccount()).toEqual(record(id));
  const content = await readFile(store.accountStorePath(), "utf8");
  expect(content.startsWith("enc:")).toBe(true);
  expect(content).not.toContain(record(id).apiKey);
  const metadata = JSON.parse(decrypt(content));
  expect(metadata.apiKey.startsWith("enc:")).toBe(true);
  expect(decrypt(metadata.apiKey)).toBe(record(id).apiKey);
  expect(await readdir(join(home, ".agav", "account"))).toEqual(["account.json"]);
  if (process.platform !== "win32") {
    expect((await stat(store.accountStorePath())).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, ".agav", "account"))).mode & 0o777).toBe(0o700);
  }
}

function holdNextWrite() {
  const entered = gate();
  const resume = gate();
  vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
    await actual.writeFile(...args);
    entered.release();
    await resume.promise;
  });
  return { entered, resume };
}

describe("complete account transactions", () => {
  it.each(["save", "logout"])("serializes a save followed by concurrent %s through the file commit", async (operation) => {
    await store.saveStoredAccount(record("A"));
    const { entered, resume } = holdNextWrite();
    const first = store.saveStoredAccount(record("B"));
    await entered.promise;
    const second = operation === "save" ? store.saveStoredAccount(record("C")) : store.clearStoredAccount();
    await pause();
    const callsWhileHeld = vi.mocked(writeFile).mock.calls.length;
    const visibleWhileHeld = await store.loadStoredAccount();
    resume.release();
    await Promise.all([first, second]);
    expect(callsWhileHeld).toBe(2);
    expect(visibleWhileHeld).toEqual(record("A"));
    if (operation === "save") await expectOnlyCurrentAccount("C");
    else {
      expect(await store.loadStoredAccount()).toBeUndefined();
      expect(await readdir(join(home, ".agav", "account"))).toEqual([]);
    }
  });

  it("serializes a save behind logout's file removal", async () => {
    await store.saveStoredAccount(record("A"));
    const entered = gate();
    const resume = gate();
    vi.mocked(rm).mockImplementationOnce(async (path, options) => {
      entered.release();
      await resume.promise;
      return actual.rm(path, options);
    });
    const first = store.clearStoredAccount();
    await entered.promise;
    const second = store.saveStoredAccount(record("B"));
    await pause();
    const callsWhileHeld = vi.mocked(writeFile).mock.calls.length;
    resume.release();
    await Promise.all([first, second]);
    expect(callsWhileHeld).toBe(1);
    await expectOnlyCurrentAccount("B");
  });

  it("preserves the winner when a queued save is cancelled before acquiring the lock", async () => {
    await store.saveStoredAccount(record("A"));
    const { entered, resume } = holdNextWrite();
    const first = store.saveStoredAccount(record("B"));
    await entered.promise;
    const controller = new AbortController();
    const second = store.saveStoredAccount(record("C"), { signal: controller.signal });
    const cancelled = expect(second).rejects.toBeInstanceOf(store.SaveCancelledError);
    controller.abort();
    resume.release();
    await first;
    await cancelled;
    expect(writeFile).toHaveBeenCalledTimes(2);
    await expectOnlyCurrentAccount("B");
    await store.saveStoredAccount(record("D"));
    await expectOnlyCurrentAccount("D");
  });

  it("holds the lock until post-commit temporary cleanup finishes", async () => {
    await store.saveStoredAccount(record("A"));
    const entered = gate();
    const resume = gate();
    vi.mocked(rm).mockImplementationOnce(async (path, options) => {
      entered.release();
      await resume.promise;
      return actual.rm(path, options);
    });
    const first = store.saveStoredAccount(record("B"));
    await entered.promise;
    const second = store.saveStoredAccount(record("C"));
    await pause();
    const callsWhileHeld = vi.mocked(writeFile).mock.calls.length;
    const visibleWhileHeld = await store.loadStoredAccount();
    resume.release();
    await Promise.all([first, second]);
    expect(callsWhileHeld).toBe(2);
    expect(visibleWhileHeld).toEqual(record("B"));
    await expectOnlyCurrentAccount("C");
  });

  it("removes a cancelled temporary file without changing the previous account", async () => {
    await store.saveStoredAccount(record("A"));
    const previous = await readFile(store.accountStorePath(), "utf8");
    const { entered, resume } = holdNextWrite();
    const controller = new AbortController();
    const pending = store.saveStoredAccount(record("B"), { signal: controller.signal });
    const cancelled = expect(pending).rejects.toBeInstanceOf(store.SaveCancelledError);
    await entered.promise;
    controller.abort();
    resume.release();
    await cancelled;
    expect(await readFile(store.accountStorePath(), "utf8")).toBe(previous);
    await expectOnlyCurrentAccount("A");
  });

  it("rolls back a failed rename and releases the lock for a later save", async () => {
    await store.saveStoredAccount(record("A"));
    const previous = await readFile(store.accountStorePath(), "utf8");
    vi.mocked(rename).mockRejectedValueOnce(new Error("EIO"));
    await expect(store.saveStoredAccount(record("B"))).rejects.toThrow("EIO");
    expect(await readFile(store.accountStorePath(), "utf8")).toBe(previous);
    await expectOnlyCurrentAccount("A");
    await store.saveStoredAccount(record("C"));
    await expectOnlyCurrentAccount("C");
  });
});
