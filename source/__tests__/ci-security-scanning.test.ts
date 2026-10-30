import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Guards the first batch of security scanning added to CI: Gitleaks secret
// scanning, GitHub Actions security linting (actionlint + zizmor), and the
// broadened/pinned Semgrep SAST. These invariants keep a future workflow edit
// from silently weakening the gates — e.g. dropping a scan from the terminal
// `All Checks` list, unpinning a tool, or re-opening the shell-injection hole
// that actionlint caught.

const root = resolve(import.meta.dirname, "../..");
const workflowsDir = join(root, ".github/workflows");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const prChecks = parse(read(".github/workflows/pr-checks.yml")) as {
  jobs: Record<string, { if?: string; container?: { image?: string } }>;
};
const secretScan = parse(read(".github/workflows/secret-scan.yml")) as {
  on?: Record<string, unknown>;
  jobs: Record<string, { steps?: { run?: string }[] }>;
};

describe("Gitleaks secret scanning", () => {
  it("has a dedicated workflow", () => {
    expect(existsSync(join(workflowsDir, "secret-scan.yml"))).toBe(true);
  });

  it("scans the PR range, the full history on push, and on a schedule", () => {
    // `on` is parsed as a key; YAML may fold it to the boolean true, so read raw.
    const raw = read(".github/workflows/secret-scan.yml");
    const on = parse(raw) as { on?: Record<string, unknown>; true?: Record<string, unknown> };
    const triggers = on.on ?? on.true ?? {};
    expect(Object.keys(triggers)).toEqual(expect.arrayContaining(["pull_request", "push", "schedule"]));
  });

  it("verifies the Gitleaks download against a recorded checksum", () => {
    const raw = read(".github/workflows/secret-scan.yml");
    // A pinned version and a sha256 --check of the downloaded tarball: a moved
    // tag or tampered artifact fails the install rather than running unknown code.
    expect(raw).toMatch(/GITLEAKS_VERSION:/);
    expect(raw).toMatch(/GITLEAKS_SHA256:\s*"[0-9a-f]{64}"/);
    expect(raw).toMatch(/sha256sum --check --strict/);
  });

  it("fails closed (does not swallow the gitleaks exit code)", () => {
    const steps = Object.values(secretScan.jobs).flatMap((j) => j.steps ?? []);
    const scanRuns = steps.map((s) => s.run ?? "").filter((r) => r.includes("gitleaks git"));
    expect(scanRuns.length).toBeGreaterThan(0);
    for (const run of scanRuns) {
      expect(run).not.toMatch(/\|\|\s*true/); // no `… || true` masking a finding
    }
  });

  it("ships a .gitleaks.toml that extends the default rules and scopes its allowlist with AND", () => {
    const cfg = read(".gitleaks.toml");
    expect(cfg).toMatch(/useDefault = true/);
    // The test-fixture allowlist must require BOTH the test path AND a synthetic
    // token shape, so a real key in a test file is still caught.
    expect(cfg).toMatch(/condition = "AND"/);
    expect(cfg).toMatch(/source\/__tests__/);
  });
});

describe("GitHub Actions security linting", () => {
  const job = prChecks.jobs["workflow-lint"];

  it("defines a workflow-lint job running actionlint and zizmor", () => {
    const raw = read(".github/workflows/pr-checks.yml");
    expect(job).toBeDefined();
    expect(raw).toMatch(/actionlint/);
    expect(raw).toMatch(/zizmorcore\/zizmor@sha256:[0-9a-f]{64}/); // container pinned by digest
  });

  it("runs on any .github change", () => {
    expect(job?.if ?? "").toContain("needs.changed.outputs.workflows == 'true'");
  });

  it("verifies the actionlint download against a recorded checksum", () => {
    const raw = read(".github/workflows/pr-checks.yml");
    expect(raw).toMatch(/ACTIONLINT_VERSION:/);
    expect(raw).toMatch(/ACTIONLINT_SHA256:\s*"[0-9a-f]{64}"/);
  });
});

describe("Semgrep SAST", () => {
  const job = prChecks.jobs["semgrep"];

  it("pins the Semgrep container by digest, not a mutable tag", () => {
    const image = job?.container?.image ?? "";
    expect(image).toMatch(/^semgrep\/semgrep@sha256:[0-9a-f]{64}$/);
  });

  it("scans both the shipped source and the CI scripts", () => {
    const raw = read(".github/workflows/pr-checks.yml");
    // The semgrep run step scans `source/ scripts/`.
    expect(raw).toMatch(/source\/ scripts\//);
    expect(job?.if ?? "").toContain("needs.changed.outputs.scripts == 'true'");
  });
});

describe("terminal gate", () => {
  it("includes the security scans and no longer references the removed regex secret-scan job", () => {
    const raw = read(".github/workflows/pr-checks.yml");
    const required = prChecks.jobs["required"] as { needs?: string[] };
    expect(required.needs).toEqual(expect.arrayContaining(["semgrep", "workflow-lint"]));
    expect(required.needs).not.toContain("secret-scan");
    // The old regex job is gone entirely; Gitleaks replaced it.
    expect(prChecks.jobs["secret-scan"]).toBeUndefined();
    // And the evaluate-results step must still check every gated job, so a scan
    // cannot be listed in `needs` but dropped from the pass/fail loop.
    expect(raw).toContain("needs.workflow-lint.result");
    expect(raw).toContain("needs.semgrep.result");
    expect(raw).not.toContain("needs.secret-scan.result");
  });
});

// Dependency vulnerability audits run in two fail-closed tiers: production (ships)
// and dev/build (CI-integrity). Both must be in the gate and blocking.
describe("dependency vulnerability audits (prod + dev tiers)", () => {
  const runs = (job: string) =>
    ((prChecks.jobs[job] as { steps?: { run?: string }[] })?.steps ?? []).map((s) => s.run ?? "").join("\n");

  it("audits production dependencies, fail-closed at HIGH/CRITICAL", () => {
    expect(runs("dependency-audit")).toContain("pnpm audit --prod --audit-level high");
  });

  it("audits dev/build dependencies in a distinct job, fail-closed at HIGH/CRITICAL", () => {
    expect(prChecks.jobs["dev-dependency-audit"]).toBeDefined();
    expect(runs("dev-dependency-audit")).toContain("pnpm audit --dev --audit-level high");
  });

  it("wires the dev audit into the terminal gate (needs + evaluate loop)", () => {
    const raw = read(".github/workflows/pr-checks.yml");
    const required = prChecks.jobs["required"] as { needs?: string[] };
    expect(required.needs).toContain("dev-dependency-audit");
    expect(raw).toContain("needs.dev-dependency-audit.result");
  });

  it("re-checks both tiers at release and in the daily monitor", () => {
    const release = read(".github/workflows/release.yml");
    expect(release).toContain("pnpm audit --prod --audit-level high");
    expect(release).toContain("pnpm audit --dev --audit-level high");
    const monitor = read(".github/workflows/security-monitor.yml");
    expect(monitor).toContain("pnpm audit --prod --audit-level high");
    expect(monitor).toContain("pnpm audit --dev --audit-level high");
  });
});

// The whole point of adding actionlint: the issue-title shell injection it found
// must stay fixed. Assert the untrusted value is read from the environment, never
// interpolated inline into the script.
describe("workflow template-injection fixes", () => {
  it("passes the issue title through the environment, not an inline expression", () => {
    const raw = read(".github/workflows/agav-translate.yml");
    expect(raw).toMatch(/ISSUE_TITLE:\s*\$\{\{\s*github\.event\.issue\.title\s*\}\}/);
    expect(raw).toMatch(/TITLE="\$ISSUE_TITLE"/);
    // The dangerous inline form must be gone.
    expect(raw).not.toMatch(/TITLE="\$\{\{\s*github\.event\.issue\.title/);
  });
});

// zizmor's github-app audit: every create-github-app-token step must scope the
// installation token with at least one permission-* input, or it inherits the
// app's blanket permissions.
describe("scoped GitHub App tokens", () => {
  const appTokenWorkflows = [
    "agav-docs.yml",
    "agav-duplicates.yml",
    "agav-pr-label.yml",
    "agav-review.yml",
    "agav-triage.yml",
    "agav-translate.yml",
    "stale-prs.yml",
  ];
  it.each(appTokenWorkflows)("%s scopes its app token with a permission-* input", (file) => {
    const raw = read(join(".github/workflows", file));
    if (!raw.includes("create-github-app-token")) return; // not applicable
    expect(raw).toMatch(/permission-[a-z-]+:/);
  });
});

// zizmor's artipacked audit: every actions/checkout step must disable credential
// persistence (persist-credentials: false), unless it legitimately needs the
// credential later and carries an inline `# zizmor: ignore[artipacked]`. This
// keeps the swept backlog from regressing — a new checkout without the flag would
// fail zizmor at --min-severity medium, and this test catches it before CI.
describe("checkout credential persistence is disabled", () => {
  const files = readdirSync(workflowsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  it.each(files)("%s: every actions/checkout sets persist-credentials: false (or an ignore)", (file) => {
    const lines = read(join(".github/workflows", file)).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)- uses: actions\/checkout@/.exec(lines[i]);
      if (!m) continue;
      if (lines[i].includes("zizmor: ignore[artipacked]")) continue; // documented exception
      const stepIndent = m[1].length;
      // Collect the step body until the next step at the same indent or a dedent.
      const body: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() !== "") {
          const ind = l.length - l.trimStart().length;
          if (ind < stepIndent || (ind === stepIndent && l.trimStart().startsWith("- "))) break;
        }
        body.push(l);
      }
      expect(
        body.some((l) => /persist-credentials\s*:\s*false/.test(l)),
        `${file}:${i + 1} checkout does not disable persist-credentials`,
      ).toBe(true);
    }
  });
});

// zizmor runs fail-closed at --min-severity medium (artipacked is medium): the
// threshold must not silently drift back up and re-open the swept backlog.
describe("zizmor threshold", () => {
  it("is pinned to --min-severity medium in workflow-lint", () => {
    const raw = read(".github/workflows/pr-checks.yml");
    expect(raw).toMatch(/--min-severity medium/);
    expect(raw).not.toMatch(/--min-severity high/);
  });
});

// Sanity: the recorded checksums are 64-hex (SHA-256) and distinct, so a
// copy-paste mistake that reused one tool's hash for another is caught.
describe("recorded tool checksums are well-formed", () => {
  it("are valid, distinct SHA-256 digests", () => {
    const raw = read(".github/workflows/pr-checks.yml") + read(".github/workflows/secret-scan.yml");
    const hashes = [...raw.matchAll(/_SHA256:\s*"([0-9a-f]{64})"/g)].map((m) => m[1]);
    expect(hashes.length).toBeGreaterThanOrEqual(2);
    expect(new Set(hashes).size).toBe(hashes.length);
    // A valid SHA-256 digest is 64 lowercase hex chars (same shape createHash emits).
    const digestShape = /^[0-9a-f]{64}$/;
    expect(createHash("sha256").update("x").digest("hex")).toMatch(digestShape);
    for (const h of hashes) expect(h).toMatch(digestShape);
  });
});
