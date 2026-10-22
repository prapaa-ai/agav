import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt, isEncrypted } from "../utils/encrypt.js";
import type { OrgConfig } from "./org-config.js";

/**
 * On-disk cache of an organization policy delivered by authenticated enrollment
 * (a future `agav login`). This is the second delivery mechanism for the org
 * tier: `agav login` fetches a policy from the control plane and writes it here;
 * every subsequent startup reads it and feeds it through the same enforcement
 * layer as an admin-shipped file.
 *
 * Stored encrypted at rest with owner-only permissions and written atomically,
 * mirroring the MCP OAuth credential store (see mcp/oauth.ts). The cached policy
 * is a *convenience/offline* copy; the control plane remains the source of truth
 * and can revoke it by refusing to re-issue on the next authenticated refresh.
 */

const ENTERPRISE_DIR = join(homedir(), ".agav", "enterprise");
const POLICY_PATH = join(ENTERPRISE_DIR, "policy.json");

/** The cached enrollment record: the policy plus metadata for later refresh. */
export interface EnrolledPolicy {
  /** The enforced org policy — same shape the file source produces. */
  policy: OrgConfig;
  /**
   * Short-lived credential scoped to the customer's gateway, opaque to Agav.
   * Injected as the provider's Authorization header so live inference reaches the
   * org gateway. Stored encrypted at rest with the rest of this record.
   */
  gatewayToken?: string;
  /** Control-plane address this policy was issued by, for refresh. */
  controlPlane?: string;
  /** Subject the policy was issued for (informational). */
  subject?: string;
  /** Unix ms after which the cached policy should be re-fetched. */
  expiresAt?: number;
  /** When this record was written (ISO-8601). */
  storedAt: string;
}

/** Path to the cached enterprise policy file. Exposed for diagnostics/tests. */
export function enterprisePolicyPath(): string {
  return POLICY_PATH;
}

/**
 * Read the cached enrolled policy. Returns undefined when none is enrolled, the
 * file is unreadable, or it is not a valid encrypted record. Never throws, so a
 * normal startup is unaffected by a missing or corrupt cache.
 *
 * A record whose `expiresAt` is in the past is still returned: the enforcement
 * layer should apply the last known policy offline rather than silently drop all
 * restrictions. Refreshing an expired policy is the caller's (login's) job.
 */
export async function loadEnrolledPolicy(): Promise<EnrolledPolicy | undefined> {
  try {
    const content = await readFile(POLICY_PATH, "utf8");
    // Refuse a plaintext file: the store must always be encrypted at rest.
    if (!isEncrypted(content)) return undefined;
    const parsed = JSON.parse(decrypt(content)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as EnrolledPolicy;
    if (!record.policy || typeof record.policy !== "object" || Array.isArray(record.policy)) {
      return undefined;
    }
    return record;
  } catch {
    return undefined;
  }
}

/**
 * Persist an enrolled policy, encrypted, with an atomic temp-file-then-rename so
 * a crash mid-write can never leave a truncated or readable-in-the-clear file.
 * Directory is created 0o700, the file 0o600.
 */
export async function saveEnrolledPolicy(record: EnrolledPolicy): Promise<void> {
  await mkdir(ENTERPRISE_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${POLICY_PATH}.${randomBytes(12).toString("hex")}.tmp`;
  const serialized = encrypt(JSON.stringify(record));
  const { writeFile } = await import("node:fs/promises");
  try {
    // "wx" refuses an existing path so a planted symlink can't be followed.
    await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
    await rename(temporary, POLICY_PATH);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Remove the cached policy (e.g. on `agav logout`). `force: true` already
 * tolerates a missing file, so a successful return means no policy remains. A
 * permission/I/O failure (read-only filesystem, non-writable directory) is
 * propagated so the caller can report that logout did not take effect — the
 * policy is still active on the next startup, so reporting success would be a lie.
 */
export async function clearEnrolledPolicy(): Promise<void> {
  await rm(POLICY_PATH, { force: true });
}
