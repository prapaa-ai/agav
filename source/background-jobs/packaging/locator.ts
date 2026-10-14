import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BackgroundJobError } from "../types.js";

/** Relative to this file; `tsc` preserves the directory layout under `outDir`. */
const SUPERVISOR_ENTRY_RELATIVE_PATH = "../supervisor/entry.js";

/**
 * Pure path arithmetic, no filesystem access: pair with `assertSupervisorAssetExists`
 * before launching. Resolved relative to this module, not `process.cwd()`.
 */
export function resolveSupervisorEntryPath(): string {
  const thisFilePath = fileURLToPath(import.meta.url);
  // `pnpm start`/`pnpm dev` load this TypeScript module from source via tsx,
  // where the sibling entry.js does not exist. Use tsc's mirrored build
  // output in that case; installed/compiled CLI runs use the sibling asset.
  if (thisFilePath.endsWith(".ts")) {
    return resolve(dirname(thisFilePath), "../../../build/background-jobs/supervisor/entry.js");
  }
  return resolve(dirname(thisFilePath), SUPERVISOR_ENTRY_RELATIVE_PATH);
}

/**
 * Existence check only; never downloads or regenerates the asset. A missing asset
 * usually means an incomplete build/install, which the error message points at.
 */
export async function assertSupervisorAssetExists(path: string): Promise<void> {
  try {
    await access(path);
  } catch (err) {
    throw new BackgroundJobError(
      "storage-unavailable",
      `Background-jobs supervisor entry is missing at "${path}". This usually means the package was ` +
        `built or installed incompletely (the compiled background-jobs/supervisor/entry.js asset is not ` +
        `present alongside this build). Reinstall or rebuild the CLI; this failure will not resolve itself ` +
        `and the supervisor will not be downloaded or regenerated automatically.` +
        (err instanceof Error ? ` (${err.message})` : ""),
    );
  }
}
