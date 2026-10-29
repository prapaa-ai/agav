import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt, isEncrypted } from "../utils/encrypt.js";
import {
  setSecret,
  getSecret,
  deleteSecret,
  isKeychainRef,
  keychainRef,
  keychainAccount,
} from "../utils/keychain.js";
import type { StoredAccount } from "./types.js";

/**
 * On-disk store for the signed-in consumer Agav account.
 *
 * The API KEY is a secret, so it is kept out of the config file: we prefer the
 * OS credential store (Keychain / libsecret / DPAPI) and persist only a
 * `keychain:` reference in the record. When no credential store is available
 * (e.g. a headless Linux box without libsecret) we fall back to AES-encrypting
 * the key inside the record — the same posture as provider API keys (#593).
 *
 * The non-secret metadata (account id, email, status, service, timestamp) is
 * written to `~/.agav/account/account.json`, always encrypted at rest and
 * written atomically — mirroring the enterprise policy store. This store is
 * entirely separate from enterprise enrollment: signing out of one never touches
 * the other.
 */

const ACCOUNT_DIR = join(homedir(), ".agav", "account");
const ACCOUNT_PATH = join(ACCOUNT_DIR, "account.json");

/**
 * Prefix for the credential-store account name holding the consumer API key.
 * Each save writes a UNIQUE entry (prefix + random suffix) rather than
 * overwriting a fixed one, so a metadata write/rename failure can never leave the
 * old metadata pointing at a new account's key (see saveStoredAccount).
 */
const KEYCHAIN_PREFIX = "account:agav-api-key";

/** Path to the cached consumer account file. Exposed for diagnostics/tests. */
export function accountStorePath(): string {
  return ACCOUNT_PATH;
}

/**
 * Read the stored account, resolving the API key from the OS credential store
 * when the record holds a reference. Returns undefined when none is signed in,
 * the file is unreadable/not encrypted, required fields are missing, or (for a
 * keychain-backed record) the secret can no longer be read. Never throws.
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

  // Resolve a keychain-referenced key back to the real secret.
  if (isKeychainRef(record.apiKey)) {
    try {
      const secret = await getSecret(keychainAccount(record.apiKey));
      if (!secret) return undefined; // key no longer in the store → treat as signed out
      return { ...record, apiKey: secret };
    } catch {
      return undefined;
    }
  }
  // Otherwise the key is AES-encrypted inline (file fallback); decrypt it.
  return { ...record, apiKey: decrypt(record.apiKey) };
}

/**
 * Persist the signed-in account. The API key goes to the OS credential store
 * when available (record holds a `keychain:` reference); otherwise it is
 * AES-encrypted inline. The metadata file is always encrypted and written
 * atomically (temp-file-then-rename), dir 0o700, file 0o600.
 */
export async function saveStoredAccount(
  record: StoredAccount,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  await mkdir(ACCOUNT_DIR, { recursive: true, mode: 0o700 });

  // Capture the PREVIOUS keychain account (if any) so we can delete it only AFTER
  // the new metadata is committed — never before. This makes the switch atomic
  // from the reader's view: metadata always points at a key that exists.
  const previousKeychainAccount = await readCurrentKeychainAccount();

  // Prefer the OS credential store for the secret; fall back to inline encryption.
  // Write the new secret under a UNIQUE account name so it never clobbers the one
  // the current (still-valid) metadata references.
  let apiKeyField: string;
  let newKeychainAccount: string | undefined;
  const candidate = `${KEYCHAIN_PREFIX}:${randomBytes(9).toString("hex")}`;
  const storedInKeychain = await setSecret(candidate, record.apiKey);
  if (storedInKeychain) {
    apiKeyField = keychainRef(candidate);
    newKeychainAccount = candidate;
  } else {
    // No credential store: AES-encrypt the key inside the record (encrypt() is
    // idempotent and only wraps a raw value).
    apiKeyField = encrypt(record.apiKey);
  }

  // Cancellation check BEFORE the commit (the rename). Up to here nothing the
  // reader sees has changed: the old metadata and its credential are intact, and
  // only a NEW unique keychain entry exists. If the user cancelled, delete just
  // that new entry and abort — leaving the previously signed-in account fully
  // usable. This is the only safe rollback point; past the rename the switch is
  // committed and must stand.
  if (options.signal?.aborted) {
    if (newKeychainAccount) await deleteSecret(newKeychainAccount).catch(() => {});
    throw new SaveCancelledError();
  }

  const onDisk: StoredAccount = { ...record, apiKey: apiKeyField };
  const temporary = `${ACCOUNT_PATH}.${randomBytes(12).toString("hex")}.tmp`;
  const serialized = encrypt(JSON.stringify(onDisk));
  try {
    // "wx" refuses an existing path so a planted symlink can't be followed.
    await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
    // Cancellation may arrive during the write; rollback is safe until rename.
    if (options.signal?.aborted) throw new SaveCancelledError();
    await rename(temporary, ACCOUNT_PATH);
  } catch (error) {
    // The metadata commit failed: roll back the just-written new secret so we
    // don't leak an orphaned credential, and leave the OLD entry intact so the
    // existing metadata still resolves. Then surface the failure.
    await rm(temporary, { force: true }).catch(() => {});
    if (newKeychainAccount) await deleteSecret(newKeychainAccount).catch(() => {});
    throw error;
  }
  await rm(temporary, { force: true }).catch(() => {});

  // Metadata now points at the new secret (commit done). Safe to delete the
  // previous entry. A cancellation that lands AFTER this point is ignored: the
  // switch already succeeded, and deleting the just-committed account would be a
  // surprise sign-out.
  if (previousKeychainAccount && previousKeychainAccount !== newKeychainAccount) {
    await deleteSecret(previousKeychainAccount).catch(() => {});
  }
}

/** Thrown by saveStoredAccount when cancelled before the commit (nothing changed). */
export class SaveCancelledError extends Error {}

/** The keychain account the current metadata references, if any. Never throws. */
async function readCurrentKeychainAccount(): Promise<string | undefined> {
  try {
    const content = await readFile(ACCOUNT_PATH, "utf8");
    if (!isEncrypted(content)) return undefined;
    const parsed = JSON.parse(decrypt(content)) as { apiKey?: unknown };
    if (parsed && typeof parsed.apiKey === "string" && isKeychainRef(parsed.apiKey)) {
      return keychainAccount(parsed.apiKey);
    }
  } catch {
    // no existing record / unreadable
  }
  return undefined;
}

/**
 * Remove the stored account (sign-out): delete the metadata file AND the
 * credential-store entry. `rm` with `force: true` tolerates a missing file; a
 * permission/I/O failure is propagated so the caller can report that sign-out
 * did not take effect. The keychain delete is best-effort (never throws).
 */
export async function clearStoredAccount(): Promise<void> {
  // Read which keychain entry the metadata references BEFORE removing anything.
  const account = await readCurrentKeychainAccount();
  // Remove the METADATA first. If this fails, the account is still fully usable
  // (metadata + its referenced credential both intact), so the caller correctly
  // reports "still connected". Deleting the credential first would instead leave
  // dangling metadata pointing at a missing key while claiming connection.
  await rm(ACCOUNT_PATH, { force: true });
  // Metadata is gone; now best-effort delete the orphaned credential.
  if (account) await deleteSecret(account).catch(() => {});
}

export { KEYCHAIN_PREFIX };
