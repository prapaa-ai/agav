# Release recovery runbook

How the release pipeline (`.github/workflows/release.yml`) behaves when a run
fails, and how to re-release the **same** `package.json` version after fixing the
problem — without burning a version number.

For the reasoning behind this design, see `release-recovery-analysis.md`
(root-cause) and `release-recovery-design.md` (design spec).

## How a release is triggered

The `check-version` job uses **publish-gap detection**: it releases whenever the
version in `package.json` has no *completed* (non-draft) GitHub Release yet.

```
VERSION  = package.json version at the pushed commit
released = a non-draft GitHub Release exists for tag vVERSION
changed  = NOT released        # "there is a publish gap"
```

Consequences:

- The version bump commit publishes the release as before.
- If anything in the pipeline fails, **any later fix commit on the same
  version** (or a manual re-run) re-triggers the release automatically, because
  the gate asks "is it published yet?" — not "did this commit change the
  number?".
- Once `vVERSION` is published non-draft, every subsequent push evaluates
  `changed=false` and the whole pipeline no-ops. No double release.
- A **draft** release counts as *not released*, so an interrupted run that left
  a draft is completed, not treated as done.

### Downgrade guard

`check-version` refuses to auto-release a version **older** than the latest
published release (e.g. `package.json` was reverted). Bump the version, or use a
forced manual re-run (below) to override deliberately.

## Recovery scenarios

### 1. Transient failure, no code change needed

Example: a runner flaked, a network blip, a dependency registry hiccup.

**Action:** GitHub → Actions → the failed *Release* run → **Re-run failed
jobs**. It re-runs against the same commit; `check-version` still sees no
completed release and proceeds to publish.

### 2. Pipeline needs a code or config fix

Example: a test, a build script, or the workflow itself was wrong.

**Action:** push the fix commit to the same branch (`beta` or `main`). Do **not**
change the version. The push triggers the workflow; publish-gap detection sees
no completed release for `vVERSION` and runs. The tag is reconciled to the fix
commit (see *Tag reconciliation*), so the release points at the corrected tree.

> This is the case that was impossible before: previously the trigger was a
> `HEAD~1` version diff, so a same-version fix commit produced `changed=false`
> and the release never re-ran.

### 3. Force a re-release manually

Example: the release completed but shipped a bad asset, or you want to retry
without any new commit.

**Action:** GitHub → Actions → *Release* → **Run workflow** → choose the branch.

- Leave **force** unchecked to simply retry publish-gap detection (useful when a
  previous attempt left no completed release).
- Check **force** to rebuild and overwrite a release that **already published**.
  This is the only way to overwrite a completed non-draft release; it also lets
  the tag be re-pointed and overrides the downgrade guard.

After a `force` overwrite of an already-served version, the R2 mirror re-uploads
the objects, but CDN edges may serve the previous bytes until the 1-year
immutable cache expires — **purge the affected `vVERSION/*` keys** at the edge if
users must see the corrected assets immediately. (For a *failed* release that
never completed, no purge is needed: those assets were never successfully
served.)

## Tag reconciliation

`softprops/action-gh-release` creates the tag if absent but will **not move** an
existing one. The `Reconcile release tag` step (just before the release is
created) handles the stale-tag case:

| State | Action |
| --- | --- |
| No tag `vVERSION` | Leave it; the release action creates it at this commit. |
| Tag already at this commit | No-op (idempotent). |
| Tag elsewhere, no non-draft release | Move it to this commit (prior attempt never completed → safe). |
| Tag elsewhere, non-draft release exists | Refuse unless **force** (protects a published release). |

This guarantees the published release always points at the commit actually being
released, even on a recovery run where the fix lives on a later commit.

## Idempotency of individual stages

- **dependency-audit / sbom / validation / installers** — stateless; re-running
  is always safe. SBOM/provenance attestations are append-only; extra ones from
  a re-run are harmless.
- **build-binaries** — deterministically rebuilds from the current commit on
  every run. On recovery this is *desired*: it replaces the bad artifacts with
  corrected ones. There is intentionally no skip-if-artifact-exists guard.
- **GitHub Release** — `action-gh-release` updates an existing release of the
  same tag and re-uploads assets, so a recovery run replaces broken assets.
- **R2 mirror** — writes `vVERSION/<asset>` by key (overwrite-by-key), then
  HEAD-checks every object for size parity and fails closed on a mismatch.

## What is intentionally NOT automated

- Version bumps — humans still edit `package.json`.
- Deleting or rolling back a published release — destructive; do it manually.
- The security gates (advisory floors, audits, attestations) always run on every
  attempt, including recovery runs. Recovery never bypasses them.
