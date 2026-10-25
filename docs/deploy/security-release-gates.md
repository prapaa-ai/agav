# Release security gates

Release publication requires the validation jobs for the release event's commit: full TypeScript checks/build/tests, shell and Windows installer regressions, production dependency audit, runtime policy/live advisory checks, and native smoke tests of every release binary. A failing prerequisite blocks publication; these checks do not depend on a separate postmerge run.

## Runtime advisory monitoring

`security-monitor.yml` runs daily and can be dispatched manually. It checks both `main` and `beta`, with independent matrix results. GitHub schedules execute only after the workflow is on the repository's default branch. Both branches must contain the monitoring scripts and policy before this scheduled matrix can pass.

The monitor reads the runtime inventory from the existing Bun policy and queries the published repository advisory feeds for Bun, Brotli, c-ares, zlib-ng and libarchive. API failures, malformed responses, pagination exhaustion, and HIGH/CRITICAL advisories without an explicit fixed version at or below the recorded component version block the check. Lower-severity advisories do not block. This is conservative upstream-feed monitoring, not exhaustive NVD/OSV coverage or a reachability analysis. Bundled patches and ambiguous version ranges require human review; they are not silently exempted.

`security/runtime-review.json` records the inventory-review date and owner (`prapaa-ai/security`). The maximum review interval is 30 days. Expired/future dates and an incomplete source inventory fail. PR checks enforce freshness offline; scheduled runs and the release dependency-audit job also fetch live advisories. Renew the date only after reviewing inventory, upstream advisories and Bun's patches. Do not change the date automatically on a passing feed request.

Triage HIGH/CRITICAL findings within one business day. Workflow failures and summaries identify the component and advisory URL. Ensure the security team subscribes to Actions failures; this change does not configure GitHub notification subscriptions or create incident tickets automatically.

Initial live verification on 2026-10-25 found `GHSA-wpr3-8q3r-4q8c` for the recorded c-ares 1.34.8 inventory (upstream fixed version 1.34.9). The release live gate intentionally blocks until the runtime is remediated or upstream patch applicability is established and the policy implementation updated with evidence. There is no advisory ignore list.

## Signing rollout remains pending

These changes do not yet introduce signed release manifests or change installer/updater trust. That requires selecting and provisioning a trusted public key or a keyless signing identity, and defining how previously published unsigned versions transition. Existing checksum verification is not publisher authentication. Do not describe these validation gates as signature enforcement.
