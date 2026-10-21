# Enterprise Auth & Policy — Threat Model

**Status:** Design reference. Covers the trust boundaries, attacks, and
mitigations for Agav's organization policy enforcement and `agav login`. Mirrors
the reasoning already encoded in the CLI (`PROJECT_CONFIG_DENY`, `secureURL`, the
loopback server, encrypted storage) and states what the **control-plane backend**
must do, since parts of the defense live server-side.

---

## Assets to protect

1. **Developer credentials / identity** — never handled by Agav directly;
   delegated to the org IdP.
2. **Model-provider spend / gateway access** — must stay on the customer's
   account; a short-lived, scoped gateway token at most reaches the CLI.
3. **Policy integrity** — a developer (or a malicious repo) must not be able to
   loosen or bypass the organization policy.
4. **Tokens at rest** — the cached policy and any gateway token on disk.

## Trust boundaries

| Actor | Trusted for | Not trusted for |
| --- | --- | --- |
| Developer machine / CLI | Running the agent locally | Holding long-lived secrets; self-asserting identity to the control plane |
| Cloned repository | Nothing | Any config that could redirect credentials or escalate permissions |
| Org IdP | Authenticating the human/workload | — |
| Control plane | Verifying identity, issuing policy + short-lived creds | Being on the inference path; holding model keys |
| Customer gateway | Authorizing/billing inference | — |

---

## Threats and mitigations

### T1 — Malicious repository redirects credentials or escalates permissions
A cloned repo ships a poisoned `./.agav/config.json` that sets `openaiBaseURL` to
an attacker server (to capture the bearer token) or flips `permissionMode` to
`auto-accept`.

**Mitigation (built):** `PROJECT_CONFIG_DENY` strips endpoint overrides, API
keys, `permissionMode`, and automation flags from project config before merge.
The organization tier sits **above** project config and is non-overridable, so a
repo can never loosen an org floor. This is the core reason the org tier applies
*last* in `loadConfig`.

### T2 — Developer tries to bypass the org policy
A user edits their global config, sets env vars, or passes CLI flags to use a
disallowed model/provider or a looser permission mode.

**Mitigation (built):** the org tier overrides global, project, **and env**;
`permissionMode` is a floor (tighten-only); `orgPolicyError` rejects an
out-of-policy provider/model at startup, before any provider is constructed.

### T3 — Forged or replayed identity proof at the control plane
An attacker presents a crafted or captured `id_token` to `/session`.

**Mitigation (server-side — must be implemented by the control plane):**
- Verify the JWT signature against the IdP JWKS; **pin the algorithm** (reject
  `alg: none` and HS/RS confusion).
- Enforce `iss` (exact match), `aud` (the control plane's audience — stops a token
  minted for another app), `exp`/`nbf` (small skew), and **`nonce`** when present
  (the CLI generates and sends it for the auth-code flow; binds the token to this
  login and defeats replay).
- Do **not** trust the CLI's own token checks; the CLI is on an untrusted machine.

### T4 — Authorization-code interception (auth-code flow)
An attacker on the loopback path tries to steal or inject the authorization code.

**Mitigation (built):** PKCE (S256) binds the code to a one-time verifier that
never leaves the process — an intercepted code is useless. The loopback server
validates `state` with a **constant-time** compare, requires exactly one `state`
and one `code` parameter, the `/callback` path and `GET` method, and is
single-use. Redirect is loopback-only (`127.0.0.1`) on an ephemeral port.

### T5 — Man-in-the-middle / credential redirect over the network
A downgraded or attacker-controlled endpoint intercepts the flow.

**Mitigation (built):** `secureURL` enforces **HTTPS** for every control-plane,
IdP, and discovery URL (HTTP allowed only on loopback for local dev), and rejects
URLs with embedded credentials. OIDC discovery additionally verifies the
document's `issuer` matches the requested issuer and that every discovered
endpoint is transport-safe. `fetch` uses `redirect: "error"` so a 3xx cannot
silently reroute the token exchange.

### T6 — Tokens / policy stolen from disk
Another local process or a backup reads the cached policy or gateway token.

**Mitigation (built):** the enrolled policy is stored **encrypted at rest**
(AES-256-GCM), written **atomically** (temp file + rename) with **`0600`** perms
in a **`0700`** directory, and the loader **refuses a plaintext file**. Residual
risk: the encryption key is derived from the local user/home, which is
obfuscation rather than a hardware-backed secret — see Residual risks.

### T7 — Stale policy after a user is deprovisioned
A revoked user keeps using a cached policy offline.

**Mitigation (design):** cached policies carry `expiresAt`; the control plane
revokes by refusing to re-issue on the next authenticated refresh. **Revocation
latency ≈ token/policy lifetime**, so keep `expiresAt` and any gateway token
short. For near-instant revocation, the gateway can check a revocation list per
request (a cost/latency tradeoff). SCIM deprovisioning at the control plane
removes the seat so no new session is issued.

### T8 — Token resale / inference-path exposure
Routing inference through Agav would expose code and create a billing liability.

**Mitigation (architectural):** the control plane is **never on the inference
path**. It returns a policy and an optional gateway-scoped token; the CLI talks to
the customer's gateway directly, and spend stays on the customer's account.

### T9a — SAML broker interception (SAML flow)
An attacker on the loopback path tries to steal or inject the control plane's
broker code, or the SAML assertion is forged/replayed.

**Mitigation (built + server-side):** the browser round-trip for `--saml` goes to
the **control plane**, not the IdP; the CLI never parses SAML. The same loopback
hardening as T4 applies — constant-time `state`, single `state`/`code`, loopback
path/method, single-use. Crucially, the broker code carries **PKCE
proof-of-possession** exactly like the auth-code flow: the CLI sends a
`code_challenge` on `/saml/initiate` and the matching `code_verifier` (which never
leaves the process) on `/saml/exchange`, so an attacker who intercepts the loopback
redirect and races to redeem the code *first* still fails — short expiry and
single-use only stop *later* replay, not first-redemption theft, so PKCE is what
closes that gap. The broker code must also be **short-lived and single-use**
(server-side). The control plane, as SAML Service Provider, **must verify the
assertion** server-side: signature, `Conditions` audience, `NotOnOrAfter`,
`InResponseTo`/replay — the CLI trusts only the final minted `id_token`, which
`/session` re-verifies.

### T9 — Device-flow phishing (device grant)
An attacker starts a device flow and tricks a victim into entering the attacker's
`user_code`.

**Mitigation (design):** short `expires_in`; the IdP consent screen names the
requesting app; high-security orgs can bind the flow to an authenticated session.
The CLI honors `slow_down`/`expired_token` and bounds polling by the IdP's
`expires_in`.

### T10 — Poisoned org policy file on a shared machine
A non-admin writes a fake `org-config.json` to loosen policy.

**Mitigation (deployment):** admins ship the file to a **system path** via
MDM with OS permissions that only admins can write; `AGAV_ORG_CONFIG` and the
system paths are the trusted sources. (Note: unlike the control-plane path, a
file is only as trustworthy as the filesystem permissions around it — prefer the
authenticated control-plane source where integrity matters most.)

---

## Residual risks (state plainly; do not overclaim)

- **At-rest key strength:** the local encryption key is derived from home +
  username — it protects against casual disk reads, not a determined local
  attacker with the user's privileges. A fully compromised machine can exfiltrate
  any live token during its lifetime; short TTLs limit blast radius, they do not
  eliminate it. Consider OS keychain/DPAPI/libsecret for a stronger store.
- **File-sourced policy integrity** depends on filesystem permissions, not a
  signature. The control-plane source is the stronger integrity path.
- **"Instant" revocation** is not free: short-TTL expiry is the default guarantee;
  per-request gateway introspection is required for immediate cutoff.

---

## Split of responsibility

| Defense | Where |
| --- | --- |
| Project-config stripping, org-tier precedence, permission floor, model/provider allowlist | CLI (built) |
| PKCE, loopback hardening, HTTPS/no-redirect, discovery issuer match | CLI (built) |
| Encrypted/atomic/0600 token storage | CLI (built) |
| Client-side audit events (login/logout) → SIEM sink, secret-free, best-effort | CLI (built) |
| id_token verification (JWKS, iss, aud, exp, nonce, alg pinning) | **Control plane** |
| SAML assertion verification + broker code minting (single-use, short-lived) | **Control plane** |
| Seat check, RBAC, policy issuance, revocation, server-side audit of `/session` | **Control plane** |
| Short-lived gateway credential minting | **Control plane / gateway** |
| Inference authorization, rate/budget limits | **Customer gateway** |
