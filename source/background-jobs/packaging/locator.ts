/**
 * T09 — Runtime locator for the compiled supervisor entry asset.
 *
 * Per README.md "Native packaging/runtime strategy" (decided in T01), the
 * supervisor entry ships as a plain `.js` file produced by the ordinary
 * `tsc` build — it is NOT a bundled/standalone executable and it is NOT
 * downloaded at launch time. This module only ever *locates* that asset on
 * disk and verifies it exists; it must never fetch, generate, or rewrite it.
 *
 * Resolution strategy mirrors the existing `import.meta.url`-relative
 * pattern already used elsewhere in this repo (see
 * `source/agents/loader.ts#getAgentSearchPaths` and
 * `source/agents/sandboxed-tool.ts#getSandboxExecPath`): resolve a path
 * relative to *this compiled module's own location* rather than relative to
 * `process.cwd()` or a hardcoded repo-root guess. This way the same logic
 * works whether this file is running from `source/background-jobs/packaging/`
 * (e.g. via `tsx` in development) or from `build/background-jobs/packaging/`
 * (the real compiled artifact shipped to users) — in both cases the sibling
 * `supervisor/entry.js` lives at the same relative offset because `tsc`
 * preserves directory structure under `outDir`.
 *
 * Expected on-disk layout (both in `source/` during dev and `build/` after
 * compilation):
 *   .../background-jobs/packaging/locator.ts   <- this file
 *   .../background-jobs/supervisor/entry.ts    <- T11 source (compiles to entry.js)
 *
 * so from this file the supervisor entry is always found at
 * `../supervisor/entry.js` relative to this file's own directory.
 */

import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BackgroundJobError } from "../types.js";

/** Relative path (from this file's directory) to the compiled supervisor entry point. */
const SUPERVISOR_ENTRY_RELATIVE_PATH = "../supervisor/entry.js";

/**
 * Resolve the absolute path to the compiled supervisor entry point.
 *
 * This performs pure path arithmetic only — it does not touch the
 * filesystem and does not verify the file exists. Callers that are about to
 * launch the supervisor MUST pair this with `assertSupervisorAssetExists`
 * so missing-asset failures are reported as an actionable error rather than
 * a confusing downstream ENOENT from `child_process.spawn`.
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
 * Verify the supervisor entry asset exists on disk before attempting to
 * launch it.
 *
 * This is a capability check only: it never downloads, generates, or
 * rewrites the asset (solution.md §7/§9 — "do not assume the CLI executable
 * can interpret .mjs, or download a runtime at job launch"). A missing
 * asset most often means the package was built/installed incompletely, so
 * the thrown error message points at that remediation rather than at a
 * retryable condition.
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
