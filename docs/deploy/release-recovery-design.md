# Idempotent, failure-tolerant release flow (Step 2 — design)

Builds on `release-recovery-analysis.md`. This document fixes the chosen
strategy for Step 3's implementation. It is a design spec, not the workflow
change itself.

## Goals

1. A version whose release pipeline failed can be **re-released from the same
   `package.json` version** after fixing the problem — no throwaway version
   bump, no empty noise commit.
2. A fully-successful release is **never silently re-published** or
   double-tagged.
3. Every expensive/stateful step is **idempotent**: safe to re-run, skips when
   its output already exists and is correct, fails closed when it cannot tell.
4. There is an explicit **manual re-run** path for operator-initiated recovery.

## Core decision: publish-gap detection, not HEAD~1 diff

Replace the trigger condition in `check-version`.

**Today:** `changed = (HEAD:version != HEAD~1:version)`. A same-version fix
commit → `changed=false` → no release.

**New:** the release should run when the committed `package.json` version has
**no corresponding published GitHub Release**. Define:

```
VERSION   = package.json version at HEAD
released  = a GitHub Release with tag v$VERSION exists AND is not a draft
changed   = (released == false)        # i.e. "there is a publish gap"
```

Rationale (why this is the right primitive):

- It is **self-healing**: any later fix commit on the same version re-triggers
  automatically until the release actually lands, because the gate asks "is it
  published yet?" not "did this one commit change the number?".
- It is **idempotent at the top level**: once `v$VERSION` is published, every
  subsequent push (fix commits, follow-up merges) evaluates `changed=false` and
  the whole pipeline no-ops. No double release.
- It removes the fragile dependency on the version bump living in exactly
  `HEAD~1`.

### Detecting "released"

Use the GitHub REST API with the already-available token:

```
GET /repos/{owner}/{repo}/releases/tags/v$VERSION
  200 + draft:false  -> released=true  -> changed=false (skip)
  200 + draft:true   -> released=false -> changed=true  (finish the release)
  404                -> released=false -> changed=true  (publish it)
```

A **draft** release counts as *not released* so an interrupted run that left a
draft is completed, not treated as done.

Keep the existing version-format validation and prerelease detection (hyphen
suffix) exactly as-is — only the `changed` computation changes.

### Guard against re-releasing *old* versions

Publish-gap detection on its own would try to release every past version that
predates the mirror/tagging history. Constrain it so it only acts on a version
that is "current enough":

- Only evaluate the gap for the version at HEAD (we already do).
- Additionally require that `v$VERSION` is **newer than the latest published
  release** OR equal to a version that has an existing *draft*/incomplete
  release. This prevents an accidental downgrade-release if someone reverts
  package.json. Concretely: if a published non-draft release exists whose
  semver is **greater** than `$VERSION`, do not release (operator must bump).

## Manual re-run path: `workflow_dispatch`

Add a `workflow_dispatch` trigger so an operator can force a re-release of the
current `package.json` version without any new commit:

```yaml
on:
  push:
    branches: [main, beta]
  workflow_dispatch:
    inputs:
      force:
        description: "Re-release the current package.json version even if a non-draft release already exists"
        type: boolean
        default: false
```

- Normal `workflow_dispatch` (force=false): runs the same publish-gap logic, so
  it is a convenient "try again" button for a failed run.
- `force=true`: overrides the `released==true` short-circuit so a damaged but
  "published" release can be rebuilt and its assets replaced. This is the only
  way to overwrite an already-published non-draft release, and it is explicit
  and operator-gated.

## Order of operations: tag/publish as the final successful step

Keep the existing job DAG (`check-version → audit/sbom/validation/installer →
build-binaries → release`) but make the `release` job's publication the last
thing that happens, and make the sub-steps individually idempotent.

### Tagging

- The tag `v$VERSION` must point at the **commit being released now**
  (`github.sha`), i.e. the fixed commit — not a stale earlier commit.
- `softprops/action-gh-release` creates the tag if absent. Problem: if a tag
  `v$VERSION` already exists from a prior failed attempt pointing at the broken
  commit, the action will **not** move it. So before publishing, the release job
  must **reconcile the tag**:
  - If no tag `v$VERSION` exists → let the release action create it.
  - If a tag exists and already points at `github.sha` → leave it (idempotent).
  - If a tag exists but points elsewhere **and** there is no non-draft release
    for it → force-update the tag to `github.sha` (the old attempt never
    completed, so moving it is safe).
  - If a tag exists **and** a non-draft release exists → do not move it unless
    `force=true` (protects a real published release).

### GitHub Release

`softprops/action-gh-release@v2` is idempotent for the *release object*: given
an existing release for the tag it updates it and re-uploads the files. Make
this explicit and intentional:

- Set it to update/overwrite assets on an existing release of the same tag
  (the action already does this; document and rely on it).
- Because a re-run rebuilds binaries from the fixed commit, re-uploading
  **replaces** the broken assets with the corrected ones. Good.

## Per-step idempotency guards

| Job / step | Re-run behavior today | Design |
| --- | --- | --- |
| `check-version` | diff-based, blocks re-trigger | publish-gap + `force` input |
| `dependency-audit` | pure, re-runnable | unchanged (stateless) |
| `sbom` + attestation | re-mints attestation each run | unchanged; attestations are append-only, extra ones are harmless |
| `validation` / installers | pure | unchanged |
| `build-binaries` | always rebuilds | unchanged — deterministic rebuild from the fixed commit is *desired* on recovery; do **not** skip-if-artifact-exists, because the point of recovery is to replace bad artifacts |
| `release` → tag | pins to stale sha, won't move | reconcile tag to `github.sha` as above |
| `release` → GH release | updates existing | keep; relies on action idempotency; `force` to overwrite a completed release |
| `release` → R2 mirror | re-uploads immutable keys | guard below |

### R2 mirror idempotency

`mirror-release-to-r2.mjs` writes `<tag>/<asset>` with a 1-year immutable
`Cache-Control`. On recovery the assets for the same version can legitimately
change (rebuilt from the fixed commit). The mirror must therefore:

- **Overwrite** objects under `v$VERSION/*` on every run of the release job
  (S3 PUT is already overwrite-by-key — no change needed for the write itself).
- The existing post-upload HEAD parity check (size match) already fails closed
  if an object is missing/wrong — keep it.
- Caveat to document: because objects carry a 1-year immutable cache header,
  CDN edges may serve stale bytes for a short window after a recovery
  re-upload of an *already-served* version. This is acceptable because recovery
  of a *failed* release means those assets were never successfully served in the
  first place (GitHub Release, the fallback origin, was never completed either).
  For a `force=true` overwrite of an already-published version, document that an
  edge purge may be required.

## Failure-mode walkthrough (acceptance criteria for Step 3)

1. **Transient failure mid-build, same commit re-run:** operator clicks
   "Re-run failed jobs". `check-version` sees no non-draft release → proceeds →
   publishes. ✔
2. **Pipeline bug needs a code fix:** operator pushes a fix commit (same
   version). Push triggers the workflow. `check-version` sees no non-draft
   release for `v$VERSION` → runs → tag reconciled to the fix commit → release
   published. ✔ (This is the case that is impossible today.)
3. **Everything already succeeded, later unrelated commit pushed:**
   `check-version` sees a non-draft release for `v$VERSION` → `changed=false` →
   whole pipeline no-ops. ✔ (No double release.)
4. **Interrupted run left a draft release / stray tag:** draft counts as not
   released → pipeline completes it; stray tag not backed by a non-draft
   release is moved to the current commit. ✔
5. **Operator must rebuild an already-published release** (e.g. bad asset
   discovered post-publish): manual `workflow_dispatch` with `force=true`
   overwrites assets and, if needed, re-points the tag. ✔
6. **Accidental version downgrade** (package.json reverted): a published
   release with a higher semver exists → refuse to release, require an explicit
   bump. ✔

## Non-goals

- Automating version bumps (out of scope; humans still bump `package.json`).
- Rolling back / deleting a published release (destructive; stays manual).
- Changing the attestation/SBOM/audit security gates (they remain mandatory and
  run on every attempt, including recovery).
