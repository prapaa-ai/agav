# Runbook — `agav login` → `agav -P` End-to-End Verification

**Status:** Operational runbook. Verifies that an enterprise enrollment actually
takes effect on a real binary: sign in, confirm the org policy is cached and
enforced, run a non-interactive (`-P`) task through the org gateway, then sign out.

This is the **manual** round-trip that the automated test suite cannot perform in
a sandbox (it needs a real browser, a reachable control plane, and outbound
network). Run it against a staging control plane before every release that touches
`source/enterprise/`, `source/config/org-config.ts`, or
`source/config/enterprise-policy-store.ts`.

---

## Prerequisites

- A built Agav binary (or `pnpm build` + `node build/cli.js`).
- A reachable control plane (staging or self-hosted) that implements the
  [`/session` contract](./control-plane-session-api.md). For SaaS, the built-in
  default `https://auth.agav.dev` is used automatically.
- A test seat/user provisioned in that control plane.
- For `--saml`: the control plane's SAML broker endpoints configured and an IdP
  test user.
- (Optional) An audit sink (e.g. `https://siem.staging/ingest`) to confirm SIEM
  events; set `AGAV_AUDIT_SINK` or ship `auditSink` in the policy.

Start from a clean slate so a stale cache can't mask a problem:

```bash
rm -rf ~/.agav/enterprise          # remove any cached enrollment
ls ~/.agav/enterprise 2>/dev/null  # expect: no such directory
```

---

## 1. Sign in

Pick the flow that matches the environment under test. All flows end the same way:
a cached, enforced org policy.

```bash
# Laptop / browser (default on a TTY)
agav login --control-plane https://auth.staging

# SSH / headless
agav login --device --control-plane https://auth.staging

# CI / automation (needs AGAV_OIDC_TOKEN or a CI token endpoint)
AGAV_OIDC_TOKEN=... agav login --oidc --control-plane https://auth.staging

# SAML (non-OIDC IdP; brokered by the control plane; needs a local browser)
agav login --saml --control-plane https://auth.staging
```

**Expected:** `Signed in as <subject>. Your organization's settings are now
active — restart Agav to use them.` and exit code `0`.

**If it fails:** the message is the failure reason. Common cases:
`not authorized or no seat` (seat not provisioned), `isn't fully set up`
(control plane publishes no auth-config and no `--issuer`/`--client-id` given),
`Could not open a browser` (use `--device`).

---

## 2. Confirm the policy was cached

```bash
ls -l ~/.agav/enterprise/policy.json
```

**Expected:** the file exists, mode `-rw-------` (`0600`), in a `0700` directory.
It is **encrypted at rest** — it must *not* be readable JSON:

```bash
head -c 32 ~/.agav/enterprise/policy.json   # expect ciphertext, not "{...policy...}"
```

If the file is plaintext JSON, that is a bug — the store must always be encrypted.

---

## 3. Confirm the policy is enforced

Restart Agav (a new process reads the cache on startup). Verify the org pins and
restrictions are in effect. For example, if the policy pins a provider/model:

```bash
# Attempt a disallowed provider/model; the org policy must reject it at startup.
agav -P "say hi" --provider <disallowed-provider>
# Expected: a clear "…not permitted by your organization's policy…" error, exit 1.
```

```bash
# The in-policy path should run and route through the org gateway.
agav -P "print the word OK and nothing else"
# Expected: completes using the org-pinned provider/model and openaiBaseURL.
```

If the policy ships a `gatewayToken` + `openaiBaseURL`, confirm inference reaches
the org gateway (check the gateway's access logs for the request), and that no
personal API key was required for a gateway-only developer.

---

## 4. (Optional) Confirm audit events reached the SIEM

With a sink configured (`AGAV_AUDIT_SINK` or policy `auditSink`), each sign-in and
sign-out posts a secret-free event. In the sink/SIEM, expect to see, with
`source: "agav-cli"`:

- `login.attempt` and `login.success` from step 1 (or `login.failure` on a failed
  attempt),
- `logout` after step 5.

Verify no event contains an `id_token`, gateway token, or authorization code.

---

## 5. Sign out

```bash
agav logout
```

**Expected:** `Signed out of your organization. Restart Agav to apply.`, exit `0`,
and `~/.agav/enterprise/policy.json` removed:

```bash
ls ~/.agav/enterprise/policy.json 2>/dev/null   # expect: no such file
```

Restart Agav and confirm the org restrictions no longer apply (back to the user's
own config).

---

## Pass criteria

- [ ] `agav login` exits `0` with a "Signed in" message.
- [ ] `policy.json` exists, `0600`, encrypted (not plaintext).
- [ ] A disallowed provider/model is rejected with an org-policy error.
- [ ] An in-policy `agav -P` task runs and routes through the org gateway.
- [ ] (If a sink is set) the expected audit events appear, with no secrets.
- [ ] `agav logout` exits `0` and removes the cache; restrictions lift on restart.

Record the control-plane address, flow, Agav version, and date with each run.
