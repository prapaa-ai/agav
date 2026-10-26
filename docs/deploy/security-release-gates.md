# Release security gates

Release publication requires the validation jobs for the release event's commit: full TypeScript checks/build/tests, shell and Windows installer regressions, production dependency audit, runtime policy/live advisory checks, and native smoke tests of every release binary. A failing prerequisite blocks publication; these checks do not depend on a separate postmerge run.

## Runtime advisory monitoring

`security-monitor.yml` runs daily and can be dispatched manually. It checks both `main` and `beta`, with independent matrix results. GitHub schedules execute only after the workflow is on the repository's default branch. Both branches must contain the monitoring scripts and policy before this scheduled matrix can pass.

The monitor reads the runtime inventory from the existing Bun policy and queries the published repository advisory feeds for Bun, Brotli, c-ares, zlib-ng and libarchive. API failures, malformed responses, pagination exhaustion, and HIGH/CRITICAL advisories without an explicit fixed version at or below the recorded component version block the check. Lower-severity advisories do not block. This is conservative upstream-feed monitoring, not exhaustive NVD/OSV coverage or a reachability analysis. Bundled patches and ambiguous version ranges require human review; they are not silently exempted.

`security/runtime-review.json` records the inventory-review date and owner (`prapaa-ai/security`). The maximum review interval is 30 days. Expired/future dates and an incomplete source inventory fail. PR checks enforce freshness offline; scheduled runs and the release dependency-audit job also fetch live advisories. Renew the date only after reviewing inventory, upstream advisories and Bun's patches. Do not change the date automatically on a passing feed request.

Triage HIGH/CRITICAL findings within one business day. Workflow failures and summaries identify the component and advisory URL. Ensure the security team subscribes to Actions failures; this change does not configure GitHub notification subscriptions or create incident tickets automatically.

Initial live verification on 2026-10-25 found `GHSA-wpr3-8q3r-4q8c` for the recorded c-ares 1.34.8 inventory (upstream fixed version 1.34.9). The release live gate intentionally blocks until the runtime is remediated or upstream patch applicability is established and the policy implementation updated with evidence. There is no advisory ignore list.

## Dependency-review gate

`pr-checks.yml` runs `actions/dependency-review-action` (SHA-pinned) on any PR that touches `package.json`, `pnpm-lock.yaml` or `pnpm-workspace.yaml`. It diffs the PR base against the head and fails closed when a newly introduced direct or transitive dependency carries a HIGH/CRITICAL advisory or a license outside the allow list. The allow list mirrors the postmerge `license-check` job so the two cannot drift. This catches a bad dependency at the PR that introduces it — earlier than the release `dependency-audit`, which re-checks the exact shipped commit's lockfile. The job participates in the terminal `All Checks` gate; a skipped run (no dependency change) is accepted, a failed one blocks the merge.

## SBOM retention and publishing

Two SBOMs are produced, both from `scripts/gen-sbom.mjs` so they are generated identically and cannot drift. The script reads the resolved production tree from `pnpm list --prod` (pnpm-native, no npm lockfile needed), emits a deterministic CycloneDX 1.5 document with a package-URL and declared license per component, and omits any wall-clock timestamp so the same dependency tree yields byte-identical output.

- **Merge-time (`postmerge-ci.yml`)**: visibility only. Uploaded as a workflow artifact (`sbom.cdx.json`, 90-day retention).
- **Release (`release.yml`, `sbom` job)**: the record of record for a shipped version. Generated from the exact release commit, published as a release asset (`agav-sbom-<version>.cdx.json`) with a `.sha256`, kept on the workflow run for a year, and backed by a Sigstore SBOM attestation (`actions/attest-sbom`, SHA-pinned, with `id-token`/`attestations` write scopes) bound to the release commit. Consumers verify it like the binary attestations: `gh attestation verify agav-sbom-<version>.cdx.json --repo prapaa-ai/agav --signer-workflow prapaa-ai/agav/.github/workflows/release.yml --source-digest <sha>`. Publication depends on the `sbom` job, so a failed SBOM blocks the release.

The SBOM covers the npm dependency graph only. The embedded Bun runtime and its vendored C libraries (Brotli, c-ares, zlib, libarchive) are not in that graph; they are tracked by `scripts/check-bun-advisories.mjs` and the runtime advisory gate. The exclusion is also recorded in the BOM's `metadata.properties` so the file is not mistaken for an exhaustive inventory.

## Build isolation

The `build-binaries` job installs `step-security/harden-runner` (SHA-pinned) as its first step, before checkout, so every network call the build makes — dependency resolution, toolchain setup, the compile itself — is recorded and correlated to the originating process. It runs in audit mode across the matrix (enforced on Linux, recording on macOS/Windows), which never breaks a cross-platform build; an unexpected destination in a run's network report is the signal a compromised dependency fetching a second stage or exfiltrating would trip. Moving to enforcement with a pinned egress allow-list is the follow-up once a few clean runs establish the legitimate egress baseline.

## Signing rollout remains pending

These changes do not yet introduce signed release manifests or change installer/updater trust. That requires selecting and provisioning a trusted public key or a keyless signing identity, and defining how previously published unsigned versions transition. Existing checksum verification is not publisher authentication. Do not describe these validation gates as signature enforcement.
