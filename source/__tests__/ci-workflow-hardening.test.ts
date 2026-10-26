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

// A pinned ref is `owner/repo@<40 hex>` (optionally with a sub-path before @).
// The parsed `uses` value never includes the trailing `# version` comment, so
// the value itself must end at the SHA.
const SHA_PIN = /@[0-9a-f]{40}$/;

/**
 * Every `uses:` value in a parsed workflow, from every job's steps — including
 * composite-action steps nested under `runs.steps`. Using the parser (not a
 * line scan) means quoted keys (`"uses":`), flow mappings (`{ uses: ... }`),
 * and comments are all handled correctly, and each step is judged on its own
 * value rather than a neighbour's.
 */
function collectUses(doc: unknown): string[] {
  const out: string[] = [];
  const visitSteps = (steps: unknown) => {
    if (!Array.isArray(steps)) return;
    for (const step of steps) {
      if (step && typeof step === "object" && typeof (step as { uses?: unknown }).uses === "string") {
        out.push((step as { uses: string }).uses);
      }
    }
  };
  if (doc && typeof doc === "object") {
    const d = doc as { jobs?: Record<string, { steps?: unknown }>; runs?: { steps?: unknown } };
    for (const job of Object.values(d.jobs ?? {})) visitSteps(job?.steps);
    visitSteps(d.runs?.steps); // composite action.yml, if ever present here
  }
  return out;
}

const parsed = files.map((file) => ({ file, doc: parse(readFileSync(join(workflowsDir, file), "utf8")) }));

describe("CI workflow supply-chain hardening", () => {
  it("has workflow files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(parsed)("$file pins every third-party action to a commit SHA", ({ file, doc }) => {
    const refs = collectUses(doc);
    for (const ref of refs) {
      if (ref.startsWith("./")) continue; // local/first-party action, exempt
      expect(SHA_PIN.test(ref), `${file}: "${ref}" is not pinned to a 40-char commit SHA`).toBe(true);
    }
  });

  it.each(parsed)("$file declares an explicit top-level permissions block", ({ file, doc }) => {
    const permissions = (doc as { permissions?: unknown }).permissions;
    expect(permissions, `${file}: missing top-level permissions (jobs would inherit broad defaults)`).toBeDefined();
    // A mapping of scope -> read|write|none, not the "write-all"/"read-all" shorthand string.
    expect(typeof permissions, `${file}: permissions must be a scope map, not ${JSON.stringify(permissions)}`).toBe("object");
    for (const [scope, level] of Object.entries(permissions as Record<string, string>)) {
      expect(["read", "write", "none"], `${file}: ${scope} has unexpected level ${level}`).toContain(level);
    }
  });

  it("runs the Tests job (which hosts this suite) on workflow-only PRs", () => {
    // The hardening suite runs inside the `test` job. If that job skipped
    // workflow-only PRs, a mutable action ref could be merged without this guard
    // ever executing, and the terminal gate accepts skipped jobs.
    const prChecks = parse(readFileSync(join(workflowsDir, "pr-checks.yml"), "utf8")) as {
      jobs: Record<string, { if?: string }>;
    };
    const testIf = prChecks.jobs["test"]?.if ?? "";
    expect(testIf).toContain("needs.changed.outputs.workflows == 'true'");
  });

  it("keeps a human-readable version comment beside each SHA pin", () => {
    // Convention check against the raw text: `@<sha> # vX.Y.Z` for auditability.
    for (const file of files) {
      const raw = readFileSync(join(workflowsDir, file), "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const m = /uses:.*@([0-9a-f]{40})(.*)$/.exec(line);
        if (!m) continue;
        expect(m[2].trim(), `${file}: SHA pin on "${line.trim()}" lacks a '# version' comment`).toMatch(/^# \S/);
      }
    }
  });

  // Guards the detector itself: the exact bypass forms a line-based check missed.
  describe("the SHA-pin detector rejects unpinned refs in any YAML form", () => {
    it.each([
      ["a tag alongside a pinned step", "- uses: actions/checkout@abc\n      - uses: actions/checkout@v4"],
      ["a quoted uses key", '- "uses": actions/checkout@v4'],
      ["a flow-mapping step", "- { uses: actions/checkout@v4 }"],
      ["a bare major tag", "- uses: pnpm/action-setup@v4"],
    ])("flags %s", (_label, stepYaml) => {
      const doc = parse(`jobs:\n  j:\n    steps:\n      ${stepYaml}\n`);
      const refs = collectUses(doc).filter((r) => !r.startsWith("./"));
      expect(refs.length).toBeGreaterThan(0);
      expect(refs.some((r) => !SHA_PIN.test(r)), "expected at least one unpinned ref to be caught").toBe(true);
    });

    it("accepts a correctly SHA-pinned ref in every form", () => {
      const sha = "11bd71901bbe5b1630ceea73d27597364c9af683";
      const doc = parse(
        `jobs:\n  j:\n    steps:\n` +
          `      - uses: actions/checkout@${sha} # v4.2.2\n` +
          `      - "uses": actions/setup-node@${sha}\n` +
          `      - { uses: pnpm/action-setup@${sha} }\n`,
      );
      const refs = collectUses(doc);
      expect(refs).toHaveLength(3);
      expect(refs.every((r) => SHA_PIN.test(r))).toBe(true);
    });
  });
});
