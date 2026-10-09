/**
 * T08 — File-backed grant store.
 *
 * `Grant` persistence is not part of T05's `Repositories` contract (see
 * types.ts: the `Repositories` interface has no `grants` field), so this
 * module owns its own small on-disk layout, reusing T05's general-purpose
 * atomic-file primitives (`writeAtomic`/`readJsonIfExists`) directly rather
 * than duplicating atomic-publication logic.
 *
 * On-disk layout under `root`:
 *   grants/<grantId>.json   — one Grant per file, single writer via this module
 *
 * This module performs no authorization policy decisions itself — see
 * `service.ts` / `policy.ts` for that. It only persists and queries `Grant`
 * records.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { Grant, GrantAction, GrantId } from "../types.js";
import { readJsonIfExists, writeAtomic } from "../storage/atomic-file.js";

function grantsDir(root: string): string {
  return join(root, "grants");
}

/** Matches the collision-resistant ids this subsystem issues (uuid-ish); mirrors storage/paths.ts. */
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function grantPath(root: string, grantId: string): string {
  if (typeof grantId !== "string" || grantId.length === 0 || !SAFE_ID_PATTERN.test(grantId)) {
    throw new Error(`Invalid or unsafe grant id: ${JSON.stringify(grantId)}`);
  }
  return join(grantsDir(root), `${grantId}.json`);
}

async function listGrantIds(root: string): Promise<string[]> {
  try {
    const files = await readdir(grantsDir(root));
    return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export interface GrantStore {
  put(grant: Grant): Promise<void>;
  get(grantId: GrantId): Promise<Grant | undefined>;
  /**
   * Find the newest non-revoked grant matching `action` + `specHash`. Used
   * by the authorization service to implement recurring-consent reuse: an
   * identical spec with an existing active grant does not require a new one.
   */
  findActiveBySpecHash(action: GrantAction, specHash: string): Promise<Grant | undefined>;
  /** Sets `revokedAt` on the grant. Does not touch any job/supervisor state. */
  revoke(grantId: GrantId): Promise<void>;
  list(): Promise<Grant[]>;
}

export function createGrantStore(root: string): GrantStore {
  return {
    async put(grant: Grant): Promise<void> {
      await writeAtomic(grantPath(root, grant.grantId), JSON.stringify(grant, null, 2));
    },

    async get(grantId: GrantId): Promise<Grant | undefined> {
      return readJsonIfExists<Grant>(grantPath(root, grantId));
    },

    async findActiveBySpecHash(action: GrantAction, specHash: string): Promise<Grant | undefined> {
      const all = await this.list();
      const candidates = all.filter(
        (g) => g.action === action && g.specHash === specHash && g.revokedAt === undefined,
      );
      if (candidates.length === 0) return undefined;
      candidates.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      return candidates[0];
    },

    async revoke(grantId: GrantId): Promise<void> {
      const path = grantPath(root, grantId);
      const existing = await readJsonIfExists<Grant>(path);
      if (existing === undefined) return;
      const updated: Grant = { ...existing, revokedAt: new Date().toISOString() };
      await writeAtomic(path, JSON.stringify(updated, null, 2));
    },

    async list(): Promise<Grant[]> {
      const ids = await listGrantIds(root);
      const grants: Grant[] = [];
      for (const id of ids) {
        const grant = await readJsonIfExists<Grant>(grantPath(root, id));
        if (grant !== undefined) grants.push(grant);
      }
      return grants;
    },
  };
}
