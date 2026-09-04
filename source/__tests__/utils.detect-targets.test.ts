import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { detectTargets, clearDetectionCache } from "../utils/detect-targets.js";

describe("utils/detect-targets", () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "agav-detect-")));
  });

  afterEach(async () => {
    clearDetectionCache();
    await rm(root, { recursive: true, force: true });
  });

  it("detects a bare URL in prose", async () => {
    const targets = await detectTargets("check out https://example.com/foo?x=1 for more", root);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ kind: "url", text: "https://example.com/foo?x=1" });
  });

  it("excludes sentence-ending trailing punctuation from a URL", async () => {
    const targets = await detectTargets("see https://example.com/page.", root);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.kind).toBe("url");
    expect(targets[0]!.text).toBe("https://example.com/page");
    expect(targets[0]!.text.endsWith(".")).toBe(false);
  });

  it("reports a path target for a file that actually exists under root", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "export {};\n");

    const targets = await detectTargets("edit src/app.ts to fix it", root);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.kind).toBe("path");
    expect(targets[0]!.absPath).toBe(resolve(root, "src/app.ts"));
  });

  it("does not report a path for a file that does not exist", async () => {
    const targets = await detectTargets("edit src/does-not-exist.ts to fix it", root);
    expect(targets.find((t) => t.kind === "path")).toBeUndefined();
    expect(targets).toHaveLength(0);
  });

  it("does not report a path that resolves outside root via traversal", async () => {
    const projectRoot = join(root, "project");
    await mkdir(projectRoot, { recursive: true });

    // `/etc/passwd` exists on virtually every unix test machine; the point is
    // that even if it resolves to a real file, it must be rejected because it
    // is outside `projectRoot`.
    const targets = await detectTargets("do not open ../../etc/passwd please", projectRoot);
    expect(targets.find((t) => t.kind === "path")).toBeUndefined();
  });

  it("validates a path candidate that has a :line:col suffix, resolving/stat-ing the bare path only", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "export {};\n");

    const targets = await detectTargets("see src/app.ts:12:5 for the bug", root);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ kind: "path", line: 12, col: 5, text: "src/app.ts:12:5" });
    expect(targets[0]!.absPath).toBe(resolve(root, "src/app.ts"));
  });

  it("skips known false-positive corpora that merely look like paths", async () => {
    const cases = [
      "the ratio is 3.5/2.1",
      "released v1.2.3 today",
      "logged on 2024/01/02",
      "built for linux/amd64",
      "downloads at 10 MB/s",
      "the odds are 50/50",
      "email a@b.com for help",
      "the file is package.json",
    ];
    for (const text of cases) {
      const targets = await detectTargets(text, root);
      expect(targets.find((t) => t.kind === "path"), text).toBeUndefined();
    }
  });

  it("finds true-positive paths end-to-end, validated against the filesystem", async () => {
    await mkdir(join(root, "source", "utils"), { recursive: true });
    await writeFile(join(root, "source", "utils", "hyperlink.ts"), "export {};\n");

    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "scripts", "gen.mjs"), "export {};\n");

    let targets = await detectTargets("see source/utils/hyperlink.ts:12 for the bug", root);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ kind: "path", line: 12 });
    expect(targets[0]!.absPath).toBe(resolve(root, "source/utils/hyperlink.ts"));

    targets = await detectTargets("run ./scripts/gen.mjs", root);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.absPath).toBe(resolve(root, "scripts/gen.mjs"));

    // NB: "../x/y.json" is not exercised as a true positive here: `resolve`
    // always uses `root` itself as the base, so any `../`-prefixed candidate
    // necessarily resolves to root's *parent* — which `isWithinRoot` then
    // always rejects (this is exactly what the traversal-rejection test above
    // covers). There is no directory layout under which a `../`-prefixed
    // candidate validates against this boundary model, so it can only ever be
    // a rejected (false) case, not a true positive.

    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "guide.md"), "# guide\n");
    targets = await detectTargets("read docs/guide.md", root);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.absPath).toBe(resolve(root, "docs/guide.md"));
  });

  it("caches validated results by cacheKey, even after the filesystem changes underneath", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    const filePath = join(root, "src", "app.ts");
    await writeFile(filePath, "export {};\n");

    const text = "edit src/app.ts please";
    const first = await detectTargets(text, root, "cache-key-1");
    expect(first).toHaveLength(1);

    await rm(filePath);

    const second = await detectTargets(text, root, "cache-key-1");
    expect(second).toBe(first);
    expect(second).toHaveLength(1);
  });

  // The public URL_RE requires a literal `https?://` prefix, and everything
  // matching that prefix parses successfully via `new URL()` with protocol
  // "http:" or "https:" — there is no realistic input reaching the public API
  // that would exercise the `new URL()` catch branch or the non-http(s)
  // protocol branch for a `kind: "url"` candidate. Skipped as noted in the task.
});
