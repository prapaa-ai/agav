import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt, isEncrypted } from "../utils/encrypt.js";
import { withAccountLock } from "./account-lock.js";
import type { StoredAccount } from "./types.js";

/**
 * On-disk store for the signed-in consumer Agav account.
 *
 * The API key is AES-encrypted inline, and the entire record is encrypted at
 * rest in `~/.agav/account/account.json`. Atomic writes keep the previous account
 * intact until the replacement commits. No OS credential store is accessed.
 * This store is entirely separate from enterprise enrollment: signing out of
 * one never touches the other.
 */

const ACCOUNT_DIR = join(homedir(), ".agav", "account");
const ACCOUNT_PATH = join(ACCOUNT_DIR, "account.json");
const ACCOUNT_LOCK_PATH = join(ACCOUNT_DIR, ".account.lock");

/** Path to the cached consumer account file. Exposed for diagnostics/tests. */
export function accountStorePath(): string {
  return ACCOUNT_PATH;
}

/**
 * Read the stored account and decrypt its inline API key. Returns undefined when
 * none is signed in, the file is unreadable/not encrypted, required fields are
 * missing, or a legacy keychain reference requires signing in again. Never throws.
 */
export async function loadStoredAccount(): Promise<StoredAccount | undefined> {
  let record: StoredAccount;
  try {
    const content = await readFile(ACCOUNT_PATH, "utf8");
    // Refuse a plaintext file: the metadata file must always be encrypted at rest.
    if (!isEncrypted(content)) return undefined;
    const parsed = JSON.parse(decrypt(content)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    record = parsed as StoredAccount;
    if (typeof record.apiKey !== "string" || typeof record.accountId !== "string") {
      return undefined;
    }
  } catch {
    return undefined;
  }

  // Legacy references cannot be recovered without accessing the OS credential
  // store. Treat them as signed out rather than prompting or using a reference.
  if (record.apiKey.startsWith("keychain:")) return undefined;
  return { ...record, apiKey: decrypt(record.apiKey) };
}

/**
 * Persist the signed-in account with an AES-encrypted inline key inside an
 * encrypted record. Writes are atomic (temp-file-then-rename), dir 0o700,
 * file 0o600, and serialized across processes by the account lock.
 */
export async function saveStoredAccount(
  record: StoredAccount,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  await withAccountLock(ACCOUNT_LOCK_PATH, async () => {
    if (options.signal?.aborted) throw new SaveCancelledError();

    const onDisk: StoredAccount = { ...record, apiKey: encrypt(record.apiKey) };
    const temporary = `${ACCOUNT_PATH}.${randomBytes(12).toString("hex")}.tmp`;
    const serialized = encrypt(JSON.stringify(onDisk));
    try {
      // "wx" refuses an existing path so a planted symlink can't be followed.
      await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
      // Cancellation may arrive during the write; rollback is safe until rename.
      if (options.signal?.aborted) throw new SaveCancelledError();
      await rename(temporary, ACCOUNT_PATH);
    } finally {
      // On failure the previous file remains intact. After rename the switch is
      // committed, so a later cancellation must not remove the new account.
      await rm(temporary, { force: true }).catch(() => {});
    }
  });
}

/** Thrown by saveStoredAccount when cancelled before the commit (nothing changed). */
export class SaveCancelledError extends Error {}

/**
 * Remove the stored account (sign-out). Missing files are tolerated; permission
 * or I/O failures propagate so the caller can report that sign-out did not take
 * effect. Legacy OS credentials are never accessed or removed.
 */
export async function clearStoredAccount(): Promise<void> {
  await withAccountLock(ACCOUNT_LOCK_PATH, async () => {
    await rm(ACCOUNT_PATH, { force: true });
  });
}
