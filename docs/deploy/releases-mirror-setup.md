# releases.agav.dev — R2 mirror setup (Step 1: storage + DNS)

Serves Agav release binaries from Cloudflare R2 as the **primary**, with GitHub
Releases as the **fallback** mirror. This file documents the Cloudflare-side
setup for `releases.agav.dev`.

## Current state

`releases.agav.dev` does NOT currently resolve (verified: `dig releases.agav.dev`
returns nothing, `curl` reports "Could not resolve host"). The earlier
`agav-releases-proxy` Worker attachment that previously pointed here has been
removed, so there is no stale record to conflict with the R2 custom-domain
attach.

If the hostname ever DOES resolve again before you attach R2 (e.g. a leftover
CNAME to `agav-releases-proxy.agav.workers.dev`), clear it first:
1. Cloudflare -> **Workers & Pages -> `agav-releases-proxy` -> Settings ->
   Domains & Routes** -> remove the `releases.agav.dev` custom domain.
2. Cloudflare -> **DNS** for `agav.dev` -> delete any leftover `releases`
   record. Do NOT delete unrelated records.
Otherwise, proceed straight to the R2 bucket + custom-domain steps below.

(The old Worker can be deleted entirely once R2 serving is verified in Step 2 —
or repurposed as the fallback layer. Decide in Step 2.)

## Object key layout (authoritative)

Keys in the bucket mirror the GitHub release download path exactly, so the
Worker in Step 2 can map one to the other by string substitution:

```
<tag>/<asset>
```

Examples for the current release (tag `v0.2.1`):

```
v0.2.1/agav-darwin-arm64
v0.2.1/agav-darwin-arm64.gz
v0.2.1/agav-darwin-arm64.gz.sha256
v0.2.1/agav-darwin-arm64.sha256
v0.2.1/agav-darwin-x64(.gz|.sha256|.gz.sha256)
v0.2.1/agav-linux-arm64(.gz|.sha256|.gz.sha256)
v0.2.1/agav-linux-x64(.gz|.sha256|.gz.sha256)
v0.2.1/agav-windows-x64.exe(.gz|.sha256|.gz.sha256)
v0.2.1/agav-windows-x64-baseline.exe(.gz|.sha256|.gz.sha256)
v0.2.1/SHA256SUMS
```

The installer downloads `<asset>.gz` plus the per-asset `<asset>.gz.sha256`
(and falls back to the raw `<asset>` + `<asset>.sha256`), and `SHA256SUMS`
exists too. All of these must be present per release.

Immutable per-tag paths -> safe to cache for a year.

## Step 1 — R2 bucket + custom domain

1. Cloudflare -> **Storage & databases -> R2** -> **Create bucket**
   - Name: `agav-releases`
   - Location: Automatic, class Standard
   - CLI: `npx wrangler r2 bucket create agav-releases`

2. After clearing the old attachment (above), connect the custom domain:
   - R2 -> `agav-releases` -> **Settings -> Custom Domains -> Connect Domain**
     -> `releases.agav.dev`
   - The `agav.dev` zone is already on Cloudflare, so DNS + TLS are issued
     automatically. Wait for **Active** + cert issued.

   NOTE: R2 custom domains serve the bucket **directly**. This makes the bucket
   publicly readable at `releases.agav.dev/<key>`. That is what we want for
   release binaries — never store anything private in this bucket.

   The GitHub fallback is handled by the Worker in `releases-worker/` (Step 2),
   which binds this bucket as `RELEASES` and proxies GitHub when a key is
   absent from R2. Therefore attach `releases.agav.dev` to the **Worker**
   (`agav-releases-proxy`), NOT directly to the bucket:
   Workers & Pages -> `agav-releases-proxy` -> Settings -> Domains & Routes ->
   Add Custom Domain -> `releases.agav.dev`.

3. Cache rule (edge caching safety net):
   - Cloudflare -> `agav.dev` zone -> **Caching -> Cache Rules -> Create rule**
   - When: Hostname equals `releases.agav.dev`
   - Then: Eligible for cache = Yes; Edge TTL = 1 year (or Respect origin)
   - Durable cache-control comes from the upload headers in Step 3
     (`Cache-Control: public, max-age=31536000, immutable`).

## Step 1 — Credentials for CI (used in Step 3)

R2 speaks the S3 API. Create a scoped token now so CI is ready:

1. R2 -> **Manage R2 API Tokens -> Create API Token**
   - Permissions: **Object Read & Write**
   - Scope: bucket `agav-releases` only
   - Copy once: Access Key ID, Secret Access Key, S3 endpoint
     (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`). Note the Account ID.

2. GitHub repo -> **Settings -> Secrets and variables -> Actions**:
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_ACCOUNT_ID`
   - `R2_BUCKET` = `agav-releases`
   - `R2_PUBLIC_BASE` = `https://releases.agav.dev`

## Step 3 — Sync releases to R2 (CI)

The release workflow (`.github/workflows/release.yml`) mirrors every published
asset to R2 **after** the GitHub Release is created (so the fallback origin is
never empty while R2 fills). The step runs
`scripts/mirror-release-to-r2.mjs <tag> release`, which:

- uploads each file in `release/` to key `<tag>/<file>` with
  `Cache-Control: public, max-age=31536000, immutable`,
- re-checks (HEAD) every uploaded key and fails the release if any object is
  missing or the wrong size (parity gate),
- skips gracefully (exit 0) when `R2_*` secrets are absent (e.g. on forks).

Requires the GitHub Actions secrets from Step 1 (`R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`).

To backfill an existing release manually, download its assets into a directory
and run the same script locally with the `R2_*` env vars set.

## Verify (end of Step 1)

Custom domain resolves and serves (empty bucket -> 404 is fine; it proves TLS
and routing work):

```
dig CNAME releases.agav.dev +short         # -> R2 / cloudflare
curl -sI https://releases.agav.dev/        # TLS ok; 404/no-key is expected
```

A real object check happens after Step 3 (upload) / Step 4 (verify).
