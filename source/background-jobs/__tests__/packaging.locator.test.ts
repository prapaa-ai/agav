import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveSupervisorEntryPath,
  assertSupervisorAssetExists,
} from "../packaging/locator.js";
import { getNodeRuntimeInvocation } from "../packaging/manifest.js";
import { BackgroundJobError } from "../types.js";

describe("packaging/locator", () => {
  it("resolveSupervisorEntryPath returns a plausible absolute path ending in the expected relative suffix", () => {
    const resolved = resolveSupervisorEntryPath();
    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved.replaceAll("\\", "/")).toMatch(
      /background-jobs\/supervisor\/entry\.js$/,
    );
  });

  it("source/dev execution locates the mirrored build asset, not a nonexistent source-side JS sibling", () => {
    const expected = fileURLToPath(new URL("../../../build/background-jobs/supervisor/entry.js", import.meta.url));
    expect(resolveSupervisorEntryPath()).toBe(expected);
  });

  it("assertSupervisorAssetExists resolves for an existing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-bg-jobs-locator-"));
    try {
      const file = join(dir, "entry.js");
      await writeFile(file, "// dummy supervisor entry\n");
      await expect(assertSupervisorAssetExists(file)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("assertSupervisorAssetExists rejects with BackgroundJobError for a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-bg-jobs-locator-"));
    try {
      const missing = join(dir, "does-not-exist.js");
      await expect(assertSupervisorAssetExists(missing)).rejects.toThrow(
        BackgroundJobError,
      );
      try {
        await assertSupervisorAssetExists(missing);
        expect.unreachable("expected assertSupervisorAssetExists to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(BackgroundJobError);
        expect((err as BackgroundJobError).code).toBe("storage-unavailable");
        expect((err as BackgroundJobError).message).toContain(missing);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("packaging/manifest", () => {
  it("getNodeRuntimeInvocation returns process.execPath with no prepended args", () => {
    const invocation = getNodeRuntimeInvocation();
    expect(invocation.executable).toBe(process.execPath);
    expect(invocation.prependArgs).toEqual([]);
  });
});
