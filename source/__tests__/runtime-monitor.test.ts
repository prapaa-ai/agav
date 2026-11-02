import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
// @ts-expect-error scripts are executed by Node, not part of the application build
import { validateReview, needsReview, monitorAdvisories, liveAcknowledgedAdvisories } from '../../scripts/runtime-monitor.mjs';
const policy = JSON.parse(readFileSync('security/runtime-review.json', 'utf8'));
const now = Date.parse(policy.reviewedAt);
const versions = { bun: '1.4.4', brotli: '1.2.1', 'c-ares': '1.34.8', 'zlib-ng': '2.3.3', libarchive: '3.8.9', 'whisper.cpp': '1.7.6', miniaudio: '0.11.22' };
const advisory = { ghsa_id: 'GHSA-wpr3-8q3r-4q8c', severity: 'high', vulnerabilities: [{ patched_versions: '1.34.9' }] };
// A HIGH advisory that is NOT acknowledged in the policy, for asserting the
// unsuppressed fail-closed path (the shared `advisory` above is acknowledged).
const unackedAdvisory = { ghsa_id: 'GHSA-aaaa-bbbb-cccc', severity: 'high', vulnerabilities: [{ patched_versions: '1.34.9' }] };
describe('runtime monitoring', () => {
  it('expires at the review deadline, rejects future and malformed dates and missing sources', () => {
    expect(validateReview(policy, now)).toEqual(policy);
    expect(() => validateReview(policy, now + 30 * 86400000)).toThrow(/expired/);
    expect(() => validateReview(policy, now - 1)).toThrow(/future/);
    expect(() => validateReview({ ...policy, reviewedAt: '2026-02-30T00:00:00Z' }, now)).toThrow();
    expect(() => validateReview({ ...policy, maxAgeDays: 365 }, now)).toThrow();
    expect(() => validateReview({ ...policy, sources: { bun: 'oven-sh/bun' } }, now)).toThrow();
  });
  it('detects the actual vulnerable c-ares version and accepts an explicit fixed version', () => {
    expect(needsReview(advisory, '1.34.8')).toBe(true);
    expect(needsReview(advisory, '1.34.9')).toBe(false);
    expect(needsReview({ ...advisory, vulnerabilities: [] }, '1.34.9')).toBe(true);
    expect(needsReview({ ...advisory, vulnerabilities: [{ patched_versions: 'unknown' }] }, '1.34.9')).toBe(true);
    expect(needsReview({ ...advisory, withdrawn_at: '2026-10-25' }, '1.34.8')).toBe(false);
    expect(() => needsReview({}, '1.34.8')).toThrow();
  });
  it('queries every source and propagates auth, timeouts, and no redirects', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    await expect(monitorAdvisories(versions, policy, fetcher, 'fixture')).resolves.toContain('not exhaustive');
    // One advisory-feed request per recorded source (now 7: Bun + 3 vendored C
    // libs + the two native voice components).
    expect(fetcher).toHaveBeenCalledTimes(7);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer fixture' } });
  });
  it.each([403, 429, 500])('fails closed on HTTP %i', async status => {
    await expect(monitorAdvisories(versions, policy, async () => ({ ok: false, status }))).rejects.toThrow(`HTTP ${status}`);
  });
  it('fails on malformed responses and unresolved findings', async () => {
    await expect(monitorAdvisories(versions, policy, async () => ({ ok: true, json: async () => ({}) }))).rejects.toThrow(/Invalid/);
    await expect(monitorAdvisories(versions, policy, async (url: string) => ({ ok: true, json: async () => url.includes('c-ares') ? [unackedAdvisory] : [] }))).rejects.toThrow(unackedAdvisory.ghsa_id);
  });
  it('follows pagination and fails if the bounded scan cannot finish', async () => {
    const withdrawn = { ...advisory, withdrawn_at: '2026-10-25' };
    const fetcher = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('page=2') ? [] : Array(100).fill(withdrawn) }));
    await monitorAdvisories(versions, policy, fetcher);
    // Two pages fetched per source (full page 1, empty page 2) across all 7 sources.
    expect(fetcher).toHaveBeenCalledTimes(14);
    await expect(monitorAdvisories(versions, policy, async () => ({ ok: true, json: async () => Array(100).fill(withdrawn) }))).rejects.toThrow(/pagination/);
  });
  it('suppresses an acknowledged advisory until it expires, scoped per component', () => {
    // The policy acknowledges c-ares GHSA-wpr3-8q3r-4q8c. A live ack suppresses
    // that exact (component, advisory) pair; it does not mask the same id on a
    // different component, nor any other advisory.
    const acks = liveAcknowledgedAdvisories(policy, now);
    expect(acks.has('c-ares:GHSA-wpr3-8q3r-4q8c')).toBe(true);
    expect(needsReview(advisory, '1.34.8', acks, 'c-ares')).toBe(false);
    expect(needsReview(advisory, '1.34.8', acks, 'bun')).toBe(true);
    expect(needsReview(unackedAdvisory, '1.34.8', acks, 'c-ares')).toBe(true);
  });
  it('ignores an expired acknowledgment and fails closed again', async () => {
    const expires = policy.acknowledgedAdvisories[0].expires;
    const afterExpiry = Date.parse(expires) + 1;
    // Past expiry the ack is gone, so the acknowledged advisory re-blocks.
    expect(liveAcknowledgedAdvisories(policy, afterExpiry).size).toBe(0);
    expect(needsReview(advisory, '1.34.8', liveAcknowledgedAdvisories(policy, afterExpiry), 'c-ares')).toBe(true);
    await expect(monitorAdvisories(versions, policy,
      async (url: string) => ({ ok: true, json: async () => url.includes('c-ares') ? [advisory] : [] }),
      undefined, afterExpiry)).rejects.toThrow(advisory.ghsa_id);
  });
  it('live monitoring honours the acknowledgment within its window', async () => {
    // The acknowledged c-ares advisory does not fail the run before expiry.
    await expect(monitorAdvisories(versions, policy,
      async (url: string) => ({ ok: true, json: async () => url.includes('c-ares') ? [advisory] : [] }),
      undefined, now)).resolves.toContain('not exhaustive');
  });
  it('rejects a malformed or over-long-lived acknowledgment', () => {
    const base = policy.acknowledgedAdvisories[0];
    // Missing/short reason, bad ghsa, unknown component, non-UTC date, and an
    // expiry at/ before the review date are all invalid (fail closed).
    expect(() => validateReview({ ...policy, acknowledgedAdvisories: [{ ...base, ghsa: 'not-a-ghsa' }] }, now)).toThrow();
    expect(() => validateReview({ ...policy, acknowledgedAdvisories: [{ ...base, component: 'openssl' }] }, now)).toThrow();
    expect(() => validateReview({ ...policy, acknowledgedAdvisories: [{ ...base, reason: 'short' }] }, now)).toThrow();
    expect(() => validateReview({ ...policy, acknowledgedAdvisories: [{ ...base, expires: '2027-01-23' }] }, now)).toThrow();
    expect(() => validateReview({ ...policy, acknowledgedAdvisories: [{ ...base, expires: policy.reviewedAt }] }, now)).toThrow(/after the review date/);
    expect(() => validateReview({ ...policy, acknowledgedAdvisories: 'nope' }, now)).toThrow();
  });
  it('gates releases on live monitoring and runs scheduled monitoring on both branches', () => {
    const release = parse(readFileSync('.github/workflows/release.yml', 'utf8'));
    expect(release.jobs['dependency-audit'].steps.some((s: any) => s.run === 'node scripts/check-runtime-security.mjs --live')).toBe(true);
    const workflow = parse(readFileSync('.github/workflows/security-monitor.yml', 'utf8'));
    expect(workflow.on.schedule).toHaveLength(1);
    expect(workflow.jobs.monitor.strategy.matrix.branch).toEqual(['main', 'beta']);
    expect(workflow.jobs.monitor.strategy['fail-fast']).toBe(false);
    expect(workflow.jobs.monitor.steps.some((s: any) => s['continue-on-error'])).toBe(false);
  });
});
