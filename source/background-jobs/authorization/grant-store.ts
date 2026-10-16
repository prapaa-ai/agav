// Grants live outside `Repositories`: one file per grant at grants/<grantId>.json. No policy decisions here.
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { Grant, GrantAction, GrantId } from "../types.js";
import { readJsonIfExists, writeAtomic } from "../storage/atomic-file.js";

function grantsDir(root: string): string {
  return join(root, "grants");
}

/** Mirrors storage/paths.ts; guards against path traversal. */
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
  /** Newest non-revoked grant for `action` + `specHash` (recurring-consent reuse). */
  findActiveBySpecHash(action: GrantAction, specHash: string): Promise<Grant | undefined>;
  /** Only sets `revokedAt`; does not touch job/supervisor state. */
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
