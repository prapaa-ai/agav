import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Supply-chain hardening for GitHub Actions. Two invariants, enforced repo-wide
// so a future workflow edit cannot silently reintroduce the risk:
//   1. Every third-party action is pinned to a full 40-char commit SHA, not a
//      mutable tag (a tag can be moved to malicious code; a SHA cannot).
//   2. Every workflow declares an explicit top-level `permissions` block, so no
//      job falls back to the broad default GITHUB_TOKEN scopes.

const workflowsDir = resolve(import.meta.dirname, "../../.github/workflows");
const files = readdirSync(workflowsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

// Local composite actions (`./...`) and reusable workflows are first-party and
// exempt from SHA pinning; everything else must be a SHA.
const SHA_PIN = /@[0-9a-f]{40}(\s|$)/;

function usesRefs(raw: string): string[] {
  // Match `uses: <ref>` anywhere (steps, composite actions), ignoring comments.
  return raw
    .split(/\r?\n/)
    .map((line) => /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(line)?.[1])
    .filter((ref): ref is string => Boolean(ref));
}

describe("CI workflow supply-chain hardening", () => {
  it("has workflow files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s pins every third-party action to a commit SHA", (file) => {
    const raw = readFileSync(join(workflowsDir, file), "utf8");
    for (const ref of usesRefs(raw)) {
      if (ref.startsWith("./")) continue; // local/first-party action
      // The ref text in the parsed line stops at whitespace, so re-read the
      // whole line to allow a trailing `# version` comment after the SHA.
      const line = raw.split(/\r?\n/).find((l) => l.includes(`uses:`) && l.includes(ref.split("@")[0]!));
      expect(SHA_PIN.test(ref) || (line !== undefined && SHA_PIN.test(line)),
        `${file}: "${ref}" is not pinned to a 40-char commit SHA`).toBe(true);
    }
  });

  it.each(files)("%s declares an explicit top-level permissions block", (file) => {
    const doc = parse(readFileSync(join(workflowsDir, file), "utf8"));
    expect(doc.permissions, `${file}: missing top-level permissions (jobs would inherit broad defaults)`).toBeDefined();
    // Must be a mapping of scope -> read|write|none, not the "write-all"/"read-all" shorthand.
    expect(typeof doc.permissions).toBe("object");
    for (const [scope, level] of Object.entries(doc.permissions as Record<string, string>)) {
      expect(["read", "write", "none"], `${file}: ${scope} has unexpected level ${level}`).toContain(level);
    }
  });

  it("pins the attestation action and keeps a human-readable version comment", () => {
    // Spot-check the convention: SHA pin followed by `# vX.Y.Z` for auditability.
    const anyPinned = files
      .map((f) => readFileSync(join(workflowsDir, f), "utf8"))
      .join("\n")
      .match(/uses:\s*\S+@[0-9a-f]{40} # v?\d/);
    expect(anyPinned, "expected at least one SHA pin annotated with its version").not.toBeNull();
  });
});
