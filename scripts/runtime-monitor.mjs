// Monitoring supplements the reviewed version floors. A missing feed or an
// ambiguous HIGH/CRITICAL advisory is a failure, not evidence of safety.
import { readFileSync } from "node:fs";

const EXPECTED_SOURCES = {
  bun: "oven-sh/bun", brotli: "google/brotli", "c-ares": "c-ares/c-ares",
  "zlib-ng": "zlib-ng/zlib-ng", libarchive: "libarchive/libarchive",
  // Native voice helper's statically-linked C/C++ components (shipped only in the
  // voice-enabled binary; invisible to pnpm audit / SBOM / Semgrep / Bun gate).
  // ggml is bundled inside the whisper.cpp tarball at the same tag, so it is
  // covered by the whisper.cpp version and feed rather than tracked separately.
  "whisper.cpp": "ggml-org/whisper.cpp", miniaudio: "mackron/miniaudio",
};

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// Validate an acknowledged-advisory entry: a time-bound, reviewed exception for
// a single upstream advisory that cannot yet be remediated (e.g. a component
// vendored by Bun whose fix Bun has not shipped). Every field is required and
// the component must be a recorded source, so an ack can never silence anything
// outside the tracked inventory. An entry whose `expires` is malformed, in the
// past, or beyond the policy's own review window is invalid — the acknowledgment
// cannot outlive the review that granted it, so it fails closed on expiry.
function isLiveAck(ack, reviewedMs, now) {
  if (!ack || typeof ack !== "object" ||
      !EXPECTED_SOURCES[ack.component] ||
      !/^GHSA-[a-z0-9-]+$/.test(ack.ghsa ?? "") ||
      typeof ack.reason !== "string" || ack.reason.length < 10 ||
      typeof ack.expires !== "string" || !ISO_UTC.test(ack.expires)) {
    throw new Error("Invalid acknowledged advisory entry");
  }
  const expires = Date.parse(ack.expires);
  if (!Number.isFinite(expires) || new Date(expires).toISOString() !== ack.expires.replace("Z", ".000Z")) {
    throw new Error("Invalid acknowledged advisory entry");
  }
  if (expires <= reviewedMs) throw new Error("Acknowledged advisory expiry must be after the review date");
  return expires > now;
}

export function validateReview(policy, now = Date.now()) {
  if (policy?.schemaVersion !== 1 || policy.owner !== "prapaa-ai/security" ||
      !Number.isInteger(policy.maxAgeDays) || policy.maxAgeDays < 1 || policy.maxAgeDays > 30 ||
      typeof policy.reviewedAt !== "string" ||
      !ISO_UTC.test(policy.reviewedAt)) {
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
  // Optional and defaults to none. Each entry is validated (throws if malformed)
  // regardless of whether it is currently live, so a bad ack is never ignored.
  const acks = policy.acknowledgedAdvisories ?? [];
  if (!Array.isArray(acks)) throw new Error("Invalid acknowledged advisory list");
  for (const ack of acks) isLiveAck(ack, reviewed, now);
  return policy;
}

// Which (component, ghsa) pairs are currently acknowledged and not expired.
export function liveAcknowledgedAdvisories(policy, now = Date.now()) {
  const reviewed = Date.parse(policy.reviewedAt);
  const live = new Set();
  for (const ack of policy.acknowledgedAdvisories ?? []) {
    if (isLiveAck(ack, reviewed, now)) live.add(`${ack.component}:${ack.ghsa}`);
  }
  return live;
}

export function readReview(root, now = Date.now()) {
  return validateReview(JSON.parse(readFileSync(`${root}/security/runtime-review.json`, "utf8")), now);
}

// Only accept a single explicit stable fixed version; unclear ranges require
// human review. We deliberately do not guess applicability from function names.
export function needsReview(advisory, version, acknowledged = new Set(), component = "") {
  if (!advisory || !/^GHSA-[a-z0-9-]+$/.test(advisory.ghsa_id ?? "") ||
      !["low", "medium", "moderate", "high", "critical"].includes(advisory.severity)) {
    throw new Error("Malformed advisory response");
  }
  if (advisory.withdrawn_at || !["high", "critical"].includes(advisory.severity)) return false;
  // A live, reviewed acknowledgment for this exact (component, advisory) pair
  // suppresses it until the ack expires. Scoped per component so an ack for one
  // source never masks the same GHSA id surfacing for a different component.
  if (acknowledged.has(`${component}:${advisory.ghsa_id}`)) return false;
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

export async function monitorAdvisories(versions, policy, fetcher = fetch, token = process.env.GITHUB_TOKEN, now = Date.now()) {
  const findings = [];
  const acknowledged = liveAcknowledgedAdvisories(policy, now);
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
        if (needsReview(advisory, versions[name], acknowledged, name)) {
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
