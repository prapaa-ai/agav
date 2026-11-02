# Release pipeline failure analysis (Step 1)

Analysis of `.github/workflows/release.yml` to find why a version cannot be
re-released from the same version after a pipeline failure, and where state is
"claimed".

## How a release is triggered today

`on: push: branches: [main, beta]` → job `check-version`:

```
CURRENT = package.json version at HEAD
PREV    = package.json version at HEAD~1
changed = (CURRENT != PREV) && PREV != ""
```

Every downstream job is gated on `needs.check-version.outputs.changed == 'true'`:
`dependency-audit`, `sbom`, `validation`, `installer-windows`, `build-binaries`,
and finally `release`.

So a release only fires on the **single commit that bumps the version**. The
detection is purely a diff between HEAD and its parent — it has no knowledge of
whether `v<version>` was ever actually published.

## Where release state is recorded ("claimed")

1. **Git tag** `v<version>` — created by `softprops/action-gh-release`
   (`tag_name: v${version}`, `target_commitish: ${{ github.sha }}`) in the
   final `release` job.
2. **GitHub Release** `v<version>` — created by the same action, with binaries,
   SBOM, checksums, signatures attached.
3. **Cloudflare R2 mirror** — `mirror-release-to-r2.mjs` writes
   `<tag>/<asset>` objects with a 1-year immutable `Cache-Control`.
4. **Sigstore attestations** — build-provenance and SBOM attestations bound to
   the commit SHA (append-only, not a blocker on re-run).

## The actual blocker (root cause)

Two distinct problems, in priority order:

### A. A fix commit cannot re-trigger the release (primary)

If the pipeline fails anywhere, the fix is a **new commit** pushed to the same
branch. That commit does **not** change `package.json` version (you are fixing
pipeline/code, not releasing a new version). Therefore at the fix commit:

```
CURRENT == PREV  →  changed=false  →  release never runs again.
```

The only ways to currently recover are both bad:

- Bump to a throwaway new version (wastes a version number, which John
  explicitly wants to avoid), or
- Push an empty/noise commit that re-introduces the diff (fragile, requires the
  immediately-preceding commit to carry the old version — not generally true).

GitHub's "Re-run failed jobs" button re-runs against the **original** release
commit, which does work for transient failures — but only while that commit is
still the trigger context and nothing downstream has partially published. It
does **not** help once you need a code/config fix, because the fix lives on a
later commit.

### B. Partial-publish is not cleanly idempotent (secondary)

The `release` job creates the tag/release as part of its normal run and then
does more work after (R2 mirror). Failure ordering matters:

- `softprops/action-gh-release@v2` is largely idempotent: re-running updates an
  existing release of the same tag rather than erroring. But the tag is pinned
  to `target_commitish: github.sha` and will **not** be moved if it already
  points elsewhere — so if the tag was created on the failing commit and the
  fix is a new commit, the published release would keep pointing at the broken
  commit.
- `build-binaries` has no skip-if-exists guard; a re-run rebuilds everything
  (correct, but wasteful) — not a blocker.
- R2 mirror re-uploads the same immutable keys; re-running overwrites with
  identical bytes — safe, but if assets changed (new commit) the 1-year
  immutable cache means stale bytes could be served.

## Conclusion / direction for Step 2

The fix must **decouple "should we release version X" from "has the HEAD~1 diff
changed"**, and make the detection answer *"is there a committed version that
has not yet been successfully published as a release?"* instead. Concretely:

1. Change `check-version` to treat **"package.json version has no matching
   published `v<version>` GitHub Release"** as the release trigger (publish-gap
   detection), not the HEAD~1 diff. This lets any later fix commit on the same
   version re-trigger automatically until the release actually succeeds.
2. Add a **`workflow_dispatch`** manual entry point to force a re-release of the
   current `package.json` version on demand.
3. Make tag/release creation the **final successful step** and point the tag at
   the current (fixed) commit, with skip-if-already-published guards so a
   fully-successful release is never re-published.
4. Guard the R2 mirror so a fixed re-release can replace assets for a version
   whose release was never completed, while never rewriting a version that was
   already fully published.
