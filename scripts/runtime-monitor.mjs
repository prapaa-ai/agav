// Monitoring supplements the reviewed version floors. A missing feed or an
// ambiguous HIGH/CRITICAL advisory is a failure, not evidence of safety.
import { readFileSync } from "node:fs";

const EXPECTED_SOURCES = {
  bun: "oven-sh/bun", brotli: "google/brotli", "c-ares": "c-ares/c-ares",
  "zlib-ng": "zlib-ng/zlib-ng", libarchive: "libarchive/libarchive",
};

export function validateReview(policy, now = Date.now()) {
  if (policy?.schemaVersion !== 1 || policy.owner !== "prapaa-ai/security" ||
      !Number.isInteger(policy.maxAgeDays) || policy.maxAgeDays < 1 || policy.maxAgeDays > 30 ||
      typeof policy.reviewedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(policy.reviewedAt)) {
    throw new Error("Invalid runtime review policy");
  }
  const reviewed = Date.parse(policy.reviewedAt);
  if (!Number.isFinite(reviewed) || new Date(reviewed).toISOString() !== policy.reviewedAt.replace("Z", ".000Z") ||
      reviewed > now || now - reviewed >= policy.maxAgeDays * 86400000) {
    throw new Error("Runtime policy review is expired or future-dated; security review is required");
  }
  if (JSON.stringify(Object.entries(policy.sources ?? {}).sort()) !== JSON.stringify(Object.entries(EXPECTED_SOURCES).sort())) {
    throw new Error("Runtime advisory source inventory is incomplete or changed");
  }
  return policy;
}

export function readReview(root, now = Date.now()) {
  return validateReview(JSON.parse(readFileSync(`${root}/security/runtime-review.json`, "utf8")), now);
}

// Only accept a single explicit stable fixed version; unclear ranges require
// human review. We deliberately do not guess applicability from function names.
export function needsReview(advisory, version) {
  if (!advisory || !/^GHSA-[a-z0-9-]+$/.test(advisory.ghsa_id ?? "") ||
      !["low", "medium", "moderate", "high", "critical"].includes(advisory.severity)) {
    throw new Error("Malformed advisory response");
  }
  if (advisory.withdrawn_at || !["high", "critical"].includes(advisory.severity)) return false;
  if (!Array.isArray(advisory.vulnerabilities) || !advisory.vulnerabilities.length) return true;
  return advisory.vulnerabilities.some(v => {
    const fixed = /^(?:>=\s*)?(\d+)\.(\d+)\.(\d+)$/.exec(v.patched_versions ?? "");
    const current = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!fixed || !current) return true;
    for (let i = 1; i <= 3; i++) {
      if (Number(current[i]) !== Number(fixed[i])) return Number(current[i]) < Number(fixed[i]);
    }
    return false;
  });
}

export async function monitorAdvisories(versions, policy, fetcher = fetch, token = process.env.GITHUB_TOKEN) {
  const findings = [];
  for (const [name, repository] of Object.entries(policy.sources)) {
    if (!versions[name]) throw new Error(`Missing runtime component: ${name}`);
    let complete = false;
    for (let page = 1; page <= 20; page++) {
      const url = `https://api.github.com/repos/${repository}/security-advisories?per_page=100&page=${page}`;
      const response = await fetcher(url, {
        redirect: "error", signal: AbortSignal.timeout(30000),
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (!response.ok) throw new Error(`Advisory feed ${repository} failed: HTTP ${response.status}`);
      const entries = await response.json();
      if (!Array.isArray(entries) || entries.length > 100) throw new Error(`Invalid advisory feed: ${repository}`);
      for (const advisory of entries) {
        if (needsReview(advisory, versions[name])) {
          findings.push(`${name}@${versions[name]}: ${advisory.ghsa_id} requires remediation or applicability review (https://github.com/${repository}/security/advisories/${advisory.ghsa_id})`);
        }
      }
      if (entries.length < 100) { complete = true; break; }
    }
    if (!complete) throw new Error(`Advisory pagination limit reached: ${repository}`);
  }
  if (findings.length) throw new Error(findings.join("\n"));
  return "No unresolved HIGH/CRITICAL advisories in the configured upstream GitHub feeds (not exhaustive CVE coverage).";
}
