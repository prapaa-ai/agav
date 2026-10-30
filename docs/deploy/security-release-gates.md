# Release security gates

Release publication requires the validation jobs for the release event's commit: full TypeScript checks/build/tests, shell and Windows installer regressions, production dependency audit, runtime policy/live advisory checks, and native smoke tests of every release binary. A failing prerequisite blocks publication; these checks do not depend on a separate postmerge run.

## Runtime advisory monitoring

`security-monitor.yml` runs daily and can be dispatched manually. It checks both `main` and `beta`, with independent matrix results. GitHub schedules execute only after the workflow is on the repository's default branch. Both branches must contain the monitoring scripts and policy before this scheduled matrix can pass.

The monitor reads the runtime inventory from the existing Bun policy and queries the published repository advisory feeds for Bun, Brotli, c-ares, zlib-ng and libarchive. API failures, malformed responses, pagination exhaustion, and HIGH/CRITICAL advisories without an explicit fixed version at or below the recorded component version block the check. Lower-severity advisories do not block. This is conservative upstream-feed monitoring, not exhaustive NVD/OSV coverage or a reachability analysis. Bundled patches and ambiguous version ranges require human review; they are not silently exempted.

`security/runtime-review.json` records the inventory-review date and owner (`prapaa-ai/security`). The maximum review interval is 30 days. Expired/future dates and an incomplete source inventory fail. PR checks enforce freshness offline; scheduled runs and the release dependency-audit job also fetch live advisories. Renew the date only after reviewing inventory, upstream advisories and Bun's patches. Do not change the date automatically on a passing feed request.

Triage HIGH/CRITICAL findings within one business day. Workflow failures and summaries identify the component and advisory URL. Ensure the security team subscribes to Actions failures; this change does not configure GitHub notification subscriptions or create incident tickets automatically.

Initial live verification on 2026-10-25 found `GHSA-wpr3-8q3r-4q8c` for the recorded c-ares 1.34.8 inventory (upstream fixed version 1.34.9). The release live gate intentionally blocks until the runtime is remediated or upstream patch applicability is established and the policy implementation updated with evidence. There is no advisory ignore list.

## Secret scanning

`secret-scan.yml` runs Gitleaks, replacing the former regex `secret-scan` job that matched only a handful of fixed key formats. On a pull request it scans the commit range the PR introduces (`base..head`); on push to `main`/`beta`, on a daily schedule, and on manual dispatch it scans the **full git history**, so a secret committed earlier — or one only recognised after a rule update — is still caught. Gitleaks is not a GitHub Action: the pinned release tarball is downloaded and verified against a recorded SHA-256 before it runs, so a moved tag or a compromised action release cannot alter what executes. A finding fails the job.

`.gitleaks.toml` extends the default rule set (no detector is disabled) and adds one narrowly-scoped allowlist for synthetic test fixtures. The allowlist uses `condition = "AND"`: a finding is ignored only when it is under `source/__tests__/` **and** its value matches an obviously-synthetic placeholder shape. A real key pasted into a test file, or a placeholder-shaped string outside the tests, is still reported. Tracked credential files remain covered by the `sensitive-files` job, which also flags an untracked `.env` left in the worktree.

This is a required check; it runs as its own workflow rather than through the `All Checks` gate, so it must be enforced via branch protection alongside the other required contexts.

## GitHub Actions security linting

`pr-checks.yml`'s `workflow-lint` job runs on any `.github` change and fails closed in the `All Checks` gate. **actionlint** (pinned release binary, checksum-verified) catches workflow syntax/expression errors and shellcheck issues in `run:` blocks, including the template-injection class — untrusted `${{ github.event.* }}` interpolated directly into an inline script. **zizmor** (official container pinned by digest) adds Actions-specific security audits. It runs at `--min-severity high`, which fails on the dangerous class (template injection, credential exfiltration, unscoped GitHub App tokens) while leaving lower-severity hygiene findings — e.g. `artipacked` (checkout without `persist-credentials: false`) — as a tracked follow-up rather than an immediate repo-wide block. Raise the threshold once those are cleared.

Two findings surfaced and were fixed when this gate was introduced: a real shell-injection via an issue title in `agav-translate.yml` (now passed through an environment variable), and seven `create-github-app-token` steps that inherited the app's blanket permissions (now scoped with explicit `permission-*` inputs mirroring each workflow's declared needs).

## SAST (Semgrep)

`pr-checks.yml`'s `semgrep` job is pinned to a Semgrep container **digest** (not `:latest`, which a maintainer could move to a build that changes or disables the scan). It now scans `scripts/` as well as `source/`: the build/release/SBOM/advisory scripts run in CI with repo-write privileges, so an unsafe-exec or command-injection defect there is as dangerous as one in the shipped CLI, and they were previously unscanned. The job triggers on source **or** scripts changes.

## Dependency-review gate

`pr-checks.yml` runs `actions/dependency-review-action` (SHA-pinned) on any PR that touches `package.json`, `pnpm-lock.yaml` or `pnpm-workspace.yaml`. It diffs the PR base against the head and fails closed when a newly introduced direct or transitive dependency carries a HIGH/CRITICAL advisory or a license outside the allow list. The allow list mirrors the postmerge `license-check` job so the two cannot drift. A follow-up step reads the action's `invalid-license-changes` output and also fails on dependencies whose license is unknown/unresolved (`NOASSERTION`) — the action only logs those, so without this step a new dependency with no identifiable license would pass despite not being on the allow list. The job holds `pull-requests: write` so the `on-failure` summary comment can actually be posted. This catches a bad dependency at the PR that introduces it — earlier than the release `dependency-audit`, which re-checks the exact shipped commit's lockfile. The job participates in the terminal `All Checks` gate; a skipped run (no dependency change) is accepted, a failed one blocks the merge.

## SBOM retention and publishing

Two SBOMs are produced, both from `scripts/gen-sbom.mjs` so they are generated identically and cannot drift. The script reads the resolved production tree from `pnpm list --prod` (pnpm-native, no npm lockfile needed), emits a deterministic CycloneDX 1.5 document with a package-URL and declared license per component, and omits any wall-clock timestamp so the same dependency tree yields byte-identical output.

The document carries a deterministic `serialNumber` (an RFC 4122 v5 UUID derived from the root package identity and the resolved component purls), which the attestation action requires to recognise the file as CycloneDX while keeping the output reproducible.

- **Merge-time (`postmerge-ci.yml`)**: visibility only. Uploaded as a workflow artifact (`sbom.cdx.json`, 90-day retention).
- **Release (`release.yml`, `sbom` job)**: the durable record for a shipped version. Generated from the exact release commit, published as a GitHub Release asset (`agav-sbom-<version>.cdx.json`) with a `.sha256` and mirrored to R2 — that release asset, not the workflow artifact, is the long-lived copy, since public-repo workflow artifacts are capped at 90 days (the 365-day request would be silently clamped). It is backed by a Sigstore SBOM attestation (`actions/attest-sbom`, SHA-pinned, with `id-token`/`attestations` write scopes) bound to the release commit. The `release` job's `Prepare release assets` step fails closed if the SBOM or its checksum is missing, so a release never ships binaries without the attested SBOM. Consumers verify it with the CycloneDX predicate type (the default is SLSA provenance, which would reject an SBOM attestation): `gh attestation verify agav-sbom-<version>.cdx.json --repo prapaa-ai/agav --predicate-type https://cyclonedx.org/bom --signer-workflow prapaa-ai/agav/.github/workflows/release.yml --source-digest <sha>`. Publication depends on the `sbom` job, so a failed SBOM blocks the release.

The SBOM covers the npm dependency graph only. The embedded Bun runtime and its vendored C libraries (Brotli, c-ares, zlib, libarchive) are not in that graph; they are tracked by `scripts/check-bun-advisories.mjs` and the runtime advisory gate. The exclusion is also recorded in the BOM's `metadata.properties` so the file is not mistaken for an exhaustive inventory.

## Build-egress monitoring

The `build-binaries` job installs `step-security/harden-runner` (SHA-pinned) as its first step, before checkout, so every network call the build makes — dependency resolution, toolchain setup, the compile itself — is recorded and correlated to the originating process. This is **monitoring, not an isolation boundary**: `egress-policy: audit` does not restrict traffic to an allow-list on any platform (only StepSecurity's global block list of known-malicious endpoints is enforced in audit mode). It runs across the whole matrix — full support on Linux, audit-only on macOS/Windows per the action's compatibility matrix — so it never breaks a cross-platform build; an unexpected destination in a run's network report is the signal a compromised dependency fetching a second stage or exfiltrating would trip.

Enforced isolation (`egress-policy: block` with a pinned allow-list) is the follow-up once a few clean runs establish the legitimate egress baseline. It is deliberately not enabled yet because a premature allow-list would break the macOS/Windows legs, where the action cannot enforce egress blocking anyway, and would need a per-leg baseline to avoid false failures. Until then, build isolation is **partial** — observable, not enforced.

## Signing rollout remains pending

These changes do not yet introduce signed release manifests or change installer/updater trust. That requires selecting and provisioning a trusted public key or a keyless signing identity, and defining how previously published unsigned versions transition. Existing checksum verification is not publisher authentication. Do not describe these validation gates as signature enforcement.
