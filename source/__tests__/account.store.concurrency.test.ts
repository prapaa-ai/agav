import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => home,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});
vi.mock("../utils/keychain.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../utils/keychain.js")>(),
  setSecret: vi.fn(), getSecret: vi.fn(), deleteSecret: vi.fn(),
}));

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
const secrets = new Map<string, string>();
let store: typeof import("../account/account-store.js");
let keychain: typeof import("../utils/keychain.js");
let decrypt: typeof import("../utils/encrypt.js")["decrypt"];
const record = (id: string) => ({
  apiKey: `secret-${id}`, accountId: id, email: "a@b.com", status: "active",
  accountService: "https://agav.dev", storedAt: "2026-01-01T00:00:00.000Z",
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "agav-account-race-"));
  vi.resetModules();
  store = await import("../account/account-store.js");
  keychain = await import("../utils/keychain.js");
  ({ decrypt } = await import("../utils/encrypt.js"));
  secrets.clear();
  vi.mocked(keychain.setSecret).mockReset().mockImplementation(async (name, value) => {
    secrets.set(name, value); return true;
  });
  vi.mocked(keychain.getSecret).mockReset().mockImplementation(async (name) => secrets.get(name));
  vi.mocked(keychain.deleteSecret).mockReset().mockImplementation(async (name) => { secrets.delete(name); });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

async function expectOnlyCurrentCredential(id: string) {
  expect(await store.loadStoredAccount()).toEqual(record(id));
  const metadata = JSON.parse(decrypt(await readFile(store.accountStorePath(), "utf8")));
  expect([...secrets.keys()]).toEqual([keychain.keychainAccount(metadata.apiKey)]);
  expect(await readdir(join(home, ".agav", "account"))).toEqual(["account.json"]);
}

describe("complete account transactions", () => {
  it.each(["save", "logout"])("serializes a save followed by concurrent %s, including credential creation", async (operation) => {
    await store.saveStoredAccount(record("A"));
    const entered = gate();
    const resume = gate();
    vi.mocked(keychain.setSecret).mockImplementationOnce(async (name, value) => {
      secrets.set(name, value);
      entered.release();
      await resume.promise;
      return true;
    });
    const first = store.saveStoredAccount(record("B"));
    await entered.promise;
    const second = operation === "save" ? store.saveStoredAccount(record("C")) : store.clearStoredAccount();
    await pause();
    resume.release();
    await Promise.all([first, second]);
    if (operation === "save") await expectOnlyCurrentCredential("C");
    else {
      expect(await store.loadStoredAccount()).toBeUndefined();
      expect(secrets.size).toBe(0);
    }
  });

  it("serializes a save behind logout's read-remove-delete transaction", async () => {
    await store.saveStoredAccount(record("A"));
    const entered = gate();
    const resume = gate();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(rm).mockImplementationOnce(async (path, options) => {
      entered.release();
      await resume.promise;
      return actual.rm(path, options);
    });
    const first = store.clearStoredAccount();
    await entered.promise;
    const second = store.saveStoredAccount(record("B"));
    await pause();
    resume.release();
    await Promise.all([first, second]);
    await expectOnlyCurrentCredential("B");
  });

  it("preserves the winner when a queued save is cancelled before acquiring the lock", async () => {
    await store.saveStoredAccount(record("A"));
    const entered = gate();
    const resume = gate();
    vi.mocked(keychain.setSecret).mockImplementationOnce(async (name, value) => {
      secrets.set(name, value);
      entered.release();
      await resume.promise;
      return true;
    });
    const first = store.saveStoredAccount(record("B"));
    await entered.promise;
    const controller = new AbortController();
    const second = store.saveStoredAccount(record("C"), { signal: controller.signal });
    const cancelled = expect(second).rejects.toBeInstanceOf(store.SaveCancelledError);
    controller.abort();
    resume.release();
    await first;
    await cancelled;
    await expectOnlyCurrentCredential("B");
    await store.saveStoredAccount(record("D"));
    await expectOnlyCurrentCredential("D");
  });

  it("holds the lock until post-commit credential deletion finishes", async () => {
    await store.saveStoredAccount(record("A"));
    const entered = gate();
    const resume = gate();
    vi.mocked(keychain.deleteSecret).mockImplementationOnce(async (name) => {
      entered.release();
      await resume.promise;
      secrets.delete(name);
    });
    const first = store.saveStoredAccount(record("B"));
    await entered.promise;
    const second = store.saveStoredAccount(record("C"));
    await pause();
    const callsWhileHeld = vi.mocked(keychain.setSecret).mock.calls.length;
    resume.release();
    await Promise.all([first, second]);
    expect(callsWhileHeld).toBe(2);
    await expectOnlyCurrentCredential("C");
  });
});
