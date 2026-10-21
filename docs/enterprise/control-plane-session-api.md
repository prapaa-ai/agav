# Control Plane `/session` API Contract

**Status:** Specification for the backend. The Agav CLI already implements this
client (`source/enterprise/control-plane.ts`); this document describes exactly
what it sends and what it expects back, so the hosted/self-hosted control plane
can be built to match. **Derived from the shipped CLI code, not aspirational** —
if the CLI changes, update this doc.

---

## Overview

`agav login` authenticates the user via one of three flows, producing an OIDC
`id_token` (the *identity proof*). It then makes a single request to the control
plane's `POST /session` endpoint and expects an *enrollment session* in return:
the enforced organization policy plus an optional short-lived gateway credential.

The control plane brokers identity and policy only. It is **never on the
inference path** — it returns a policy and (optionally) a token the CLI uses to
reach the customer's gateway directly.

```
agav login ──POST /session { idToken, flow, nonce }──► Control Plane
           ◄──── { policy, gatewayToken?, subject?, expiresAt? } ────
```

---

## `GET /auth-config` (optional, enables the SaaS path)

Interactive flows (`auth-code`, `device`) need an OIDC issuer and client id. So
developers don't have to supply them, `agav login` first calls this endpoint when
`--issuer`/`--client-id` are not provided. If the control plane publishes them
here, SaaS sign-in works with a bare `agav login`.

```
GET {controlPlane}/auth-config        accept: application/json
```

**Response — `200 OK`:**
```jsonc
{
  "issuer": "https://idp.corp",   // required (HTTPS)
  "clientId": "agav-cli",         // required
  "scopes": ["email"]             // optional; "openid" is always added by the CLI
}
```

- `404` — the control plane does not advertise coordinates; the CLI falls back to
  explicit flags, and if none are given, reports that setup isn't finished.
- Any other non-2xx, non-JSON, or a response missing `issuer`/`clientId` is an
  error. An insecure (`http:`) `issuer` is rejected.
- Explicit `--issuer`/`--client-id` on the CLI skip this call entirely.

The `oidc-token` (CI) flow does not use this endpoint.

---

## Endpoint

```
POST {controlPlane}/session
```

- `{controlPlane}` is the resolved base URL (`--control-plane` > `AGAV_CONTROL_PLANE`
  > org policy `controlPlane` > built-in hosted default `https://auth.agav.dev`).
- The CLI appends `session` to the base URL (preserving any base path), so a base
  of `https://auth.corp/base/` yields `https://auth.corp/base/session`.
- **HTTPS is required** (HTTP permitted only on loopback, for local dev). URLs with
  embedded credentials are rejected by the client.
- The client sets `redirect: "error"` — the endpoint **must not** 3xx-redirect.

### Request headers
```
content-type: application/json
accept: application/json
```

### Request body
```jsonc
{
  "idToken": "<OIDC id_token JWT>",  // required — the identity proof
  "flow": "auth-code",               // "auth-code" | "device" | "oidc-token"
  "nonce": "<base64url>"             // present for auth-code; omitted for device/oidc-token
}
```

The control plane **must verify `idToken` server-side** — do not trust the CLI's
own checks. At minimum: signature via the IdP JWKS, `iss`, `aud` (pinned to the
control plane's audience), `exp`/`nbf`, and `nonce` when provided. See
`docs/enterprise/threat-model.md` (T3–T5) for the full verification checklist,
including algorithm pinning.

---

## Response

### Success — `200 OK`, JSON body

```jsonc
{
  "policy": {                         // REQUIRED — the enforced org policy
    "provider": "openai",
    "model": "gpt-5.4",
    "openaiBaseURL": "https://gateway.corp/v1",
    "openaiHeaders": { "x-tenant": "team-a" },
    "permissionMode": "ask",
    "allowedProviders": ["openai", "anthropic"],
    "allowedModels": ["gpt-5.4", "claude-sonnet-4"],
    "allowedTools": ["read_file", "grep_search"],
    "controlPlane": "https://auth.corp"
  },
  "gatewayToken": "<short-lived, gateway-scoped>",  // optional
  "subject": "user@corp.com",                        // optional (shown on success)
  "expiresAt": 1730000000000                         // optional, Unix ms
}
```

Field requirements the CLI enforces when parsing (`parseSession`):

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `policy` | **Yes** | object | Missing/非-object ⇒ CLI rejects the whole response. Shape = `OrgConfig` (see below). |
| `gatewayToken` | No | string | Opaque to Agav. Short-lived credential scoped to the customer's gateway. |
| `subject` | No | string | Echoed in the "Signed in as …" message. |
| `expiresAt` | No | number | Unix ms; when the session/policy should be refreshed. |

The CLI ignores unknown fields, so the response may include more (e.g. audit ids)
without breaking the client.

### `policy` object = `OrgConfig`

The policy is the **same shape** as the admin-shipped org config file, so the
server and file sources are interchangeable. Fields (all optional; omit to impose
no restriction):

| Field | Enforcement |
| --- | --- |
| `provider`, `model` | Hard pin. |
| `openaiBaseURL`, `openaiHeaders` | Hard pin (route through the org gateway). |
| `permissionMode` | Floor: user may be stricter, never looser (`deny-writes` > `ask` > `auto-accept`). |
| `allowedProviders` | Allowlist; out-of-policy provider rejected at startup. Empty/omitted = no restriction. |
| `allowedModels` | Allowlist; out-of-policy model rejected at startup. Empty/omitted = no restriction. |
| `allowedTools` | Additive; merged with the user's allowlist. |
| `controlPlane` | The self-hosted control-plane address (for refresh/consistency). |

### Error responses (status codes the CLI branches on)

| Status | CLI behavior / message |
| --- | --- |
| `401`, `403` | "Control plane rejected the sign-in (not authorized or no seat)." Use these when the token is invalid or the user has no seat. |
| other non-2xx | "Control plane enrollment failed (HTTP {status})." |
| 2xx but non-JSON body | "Control plane returned a non-JSON session response." |
| 2xx JSON without `policy` | "Control plane session response is missing a policy." |
| network failure / unreachable | "Could not reach the control plane at {origin}: …" |

A redirect (3xx) is treated as a transport error because the client sets
`redirect: "error"`.

---

## What the CLI does with the response

1. Validates and narrows the body into an `EnrollmentSession`.
2. Caches it encrypted (AES-256-GCM), owner-only (`0600`), atomically, at
   `~/.agav/enterprise/policy.json` — storing `policy`, `controlPlane`, `subject`,
   and `expiresAt`.
3. Every subsequent startup reads that cache and enforces the policy as the
   highest-precedence configuration tier.

The `gatewayToken` is accepted and carried in the session; wiring it into live
model requests (injecting it at the gateway) is a separate follow-up.

---

## Server responsibilities (summary)

1. **Verify `idToken`** (JWKS, `iss`, `aud`, `exp`, `nonce`) — never trust the client.
2. **Authorize** the subject: confirm an active seat and resolve the org/role.
3. **Resolve the policy** the admin authored (file/UI/API) for that org/role and
   return it as `policy`.
4. **(Optional) Mint a short-lived, gateway-scoped `gatewayToken`.** Keep it short
   so revocation ≈ token lifetime.
5. Return `200` with the JSON above, or a documented error status.

### SaaS note

For Agav's hosted control plane, the interactive flows (`auth-code`/`device`)
should let the control plane drive IdP selection. Today the CLI requires
`--issuer`/`--client-id` for those flows; the hosted service is expected to supply
the IdP coordinates (for example via a discovery step) so SaaS developers do not
have to know them. The `oidc-token` flow needs no IdP coordinates and works
against the default today.

---

## Versioning

Add fields additively; the CLI ignores unknown response fields. Any breaking
change to the request shape or required response fields must be coordinated with
a CLI release, since this contract is implemented by the shipped client.
