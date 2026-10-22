import { loadConfig } from "../config/config.js";
import { enroll, persistSession } from "../enterprise/control-plane.js";
import { clearEnrolledPolicy } from "../config/enterprise-policy-store.js";
import { hasOidcTokenSource } from "../enterprise/flow-oidc-token.js";
import { openExternal } from "../utils/open-external.js";
import { recordAuditEvent, classifyFailureReason } from "../enterprise/audit.js";
import { EnterpriseAuthError, type AuthFlow, type IdentityProof } from "../enterprise/types.js";

/**
 * `agav login` / `agav logout` — enterprise enrollment.
 *
 * login: obtain an identity proof via the appropriate flow, exchange it at the
 * control plane for an org policy + short-lived gateway credential, and cache it
 * so subsequent sessions enforce the policy. logout: clear the cached policy.
 *
 * Flow selection (override with --device / --oidc / --auth-code / --saml):
 *   - a CI OIDC token source present, or no TTY  -> oidc-token
 *   - a TTY with an openable browser             -> auth-code
 *   - otherwise                                  -> device
 *
 * SAML is never auto-selected (it needs an org whose IdP isn't OIDC); the user
 * opts in with --saml, and the control plane brokers the SAML assertion.
 */

interface LoginArgs {
  flow?: AuthFlow;
  controlPlane?: string;
  issuer?: string;
  clientId?: string;
}

function parseLoginArgs(args: string[]): LoginArgs | { error: string } {
  const out: LoginArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const take = (): string => args[++i] ?? "";
    if (arg === "--device") out.flow = "device";
    else if (arg === "--oidc") out.flow = "oidc-token";
    else if (arg === "--auth-code") out.flow = "auth-code";
    else if (arg === "--saml") out.flow = "saml";
    else if (arg === "--control-plane") out.controlPlane = take();
    else if (arg.startsWith("--control-plane=")) out.controlPlane = arg.slice("--control-plane=".length);
    else if (arg === "--issuer") out.issuer = take();
    else if (arg.startsWith("--issuer=")) out.issuer = arg.slice("--issuer=".length);
    else if (arg === "--client-id") out.clientId = take();
    else if (arg.startsWith("--client-id=")) out.clientId = arg.slice("--client-id=".length);
    else if (arg === "--") continue;
    else return { error: `unknown argument: ${arg}` };
  }
  return out;
}

/** Decide which flow to run when the user did not force one. */
function autoSelectFlow(): AuthFlow {
  if (hasOidcTokenSource() || !process.stdin.isTTY) return "oidc-token";
  // A TTY without a usable browser (e.g. SSH) should use device; but we cannot
  // know if the browser opens until we try, so prefer auth-code on a TTY and let
  // it fall back with a clear "use --device" hint if the browser cannot open.
  return "auth-code";
}

/** Produce an identity proof using the selected flow. */
async function obtainProof(
  flow: AuthFlow,
  opts: { issuer?: string; clientId?: string; controlPlane: string },
  signal?: AbortSignal,
): Promise<IdentityProof> {
  if (flow === "oidc-token") {
    const { obtainIdTokenViaOidc } = await import("../enterprise/flow-oidc-token.js");
    return obtainIdTokenViaOidc({ audience: opts.controlPlane, signal });
  }

  if (flow === "saml") {
    // SAML is brokered entirely by the control plane; the CLI needs no IdP
    // coordinates — the control plane is the SAML Service Provider.
    const { obtainIdTokenViaSaml } = await import("../enterprise/flow-saml.js");
    return obtainIdTokenViaSaml({ controlPlane: opts.controlPlane, openBrowser: openExternal, signal });
  }

  // Interactive flows need IdP coordinates. Prefer explicit flags; otherwise ask
  // the control plane for them (the SaaS path, so developers needn't know them).
  let issuer = opts.issuer;
  let clientId = opts.clientId;
  let scopes: string[] | undefined;
  if (!issuer || !clientId) {
    const { fetchAuthConfig } = await import("../enterprise/control-plane.js");
    const authConfig = await fetchAuthConfig(opts.controlPlane, signal);
    issuer = issuer ?? authConfig?.issuer;
    clientId = clientId ?? authConfig?.clientId;
    scopes = authConfig?.scopes;
  }
  if (!issuer || !clientId) {
    throw new EnterpriseAuthError(
      "Agav sign-in isn't fully set up for your organization yet. Ask your Agav administrator to finish setup.\n" +
      "  (Admins: have the control plane publish its auth-config, or pass --issuer and --client-id.)",
    );
  }

  if (flow === "device") {
    const { obtainIdTokenViaDevice } = await import("../enterprise/flow-device.js");
    return obtainIdTokenViaDevice({ issuer, clientId, scopes, signal });
  }
  const { obtainIdTokenViaAuthCode } = await import("../enterprise/flow-auth-code.js");
  return obtainIdTokenViaAuthCode({ issuer, clientId, scopes, openBrowser: openExternal, signal });
}

/**
 * Options for in-process callers (e.g. the `/login` slash command).
 *
 *   - `signal`: the TUI holds stdin in raw mode, so Ctrl-C arrives as an input
 *     byte, not a signal. This lets such a caller abort the in-flight flow;
 *     when it fires, login is cancelled exactly as a SIGINT would.
 *   - `onMessage` / `onError`: where the human-readable outcome lines go.
 *     Default to console.log / console.error (the CLI). An in-process caller
 *     passes sinks that capture the text so it can be shown in the TUI
 *     transcript, which survives the repaint that clears the terminal — far more
 *     robust than intercepting process.stdout/stderr writes.
 */
export interface RunLoginOptions {
  signal?: AbortSignal;
  onMessage?: (text: string) => void;
  onError?: (text: string) => void;
}

/** Entry point for `agav login` / `agav logout`. Returns a process exit code. */
export async function runLoginCommand(
  command: string | undefined,
  args: string[],
  options: RunLoginOptions = {},
): Promise<number> {
  const report = options.onMessage ?? ((text: string) => console.log(text));
  const reportError = options.onError ?? ((text: string) => console.error(text));
  if (command === "logout") {
    // Capture the effective audit settings BEFORE clearing the cache: an
    // enrollment-delivered auditSink / controlPlane lives in the policy store we
    // are about to delete, so reading them afterward would lose them and drop (or
    // misroute) the logout event.
    const audit = await resolveLogoutAudit(args);
    try {
      await clearEnrolledPolicy();
    } catch (error) {
      reportError(
        `Could not sign out: the enrollment cache could not be removed (${error instanceof Error ? error.message : String(error)}).\n` +
        "Your organization's settings are still active. Fix the file permissions and try again.",
      );
      return 1;
    }
    // Emit after a successful deletion, awaited so the event is delivered before
    // the process exits. recordAuditEvent is bounded (own timeout) and never
    // throws, so this cannot stall or fail logout.
    await recordAuditEvent(
      { action: "logout", controlPlane: audit.controlPlane },
      { sink: audit.sink },
    );
    report("Signed out of your organization. Restart Agav to apply.");
    return 0;
  }

  const parsed = parseLoginArgs(args);
  if ("error" in parsed) {
    reportError(`${parsed.error}\nUsage: agav login [--device | --oidc | --auth-code | --saml] [--control-plane URL] [--issuer URL] [--client-id ID]`);
    return 1;
  }

  // Resolve the control-plane address: explicit flag -> env -> org policy
  // (self-hosted) -> Agav's hosted default. There is always an address, so login
  // works out of the box against the SaaS control plane.
  const config = await loadConfig();
  const { resolveControlPlane } = await import("../enterprise/control-plane-address.js");
  const controlPlane = resolveControlPlane({ flag: parsed.controlPlane, orgConfig: config.controlPlane });

  const flow = parsed.flow ?? autoSelectFlow();

  // Resolve the audit sink once: org policy (self-hosted) takes precedence over
  // the AGAV_AUDIT_SINK env var. Events are dropped when neither is set.
  const auditSink = config.auditSink;
  const cpOrigin = controlPlaneOrigin(controlPlane);

  const controller = new AbortController();
  const cancel = () => controller.abort(new EnterpriseAuthError("Login cancelled."));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  // An in-process caller (the /login slash command) cannot deliver SIGINT while
  // the TUI holds stdin in raw mode, so it supplies an AbortSignal instead.
  // Mirror it onto the same controller so cancellation behaves identically.
  const onExternalAbort = () => controller.abort(options.signal?.reason ?? new EnterpriseAuthError("Login cancelled."));
  if (options.signal) {
    if (options.signal.aborted) onExternalAbort();
    else options.signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    // The attempt event may race the rest of login; fire-and-forget is fine since
    // a terminal (success/failure) event always follows and is awaited.
    void recordAuditEvent({ action: "login.attempt", flow, controlPlane: cpOrigin }, { sink: auditSink });
    const proof = await obtainProof(flow, {
      issuer: parsed.issuer,
      clientId: parsed.clientId,
      controlPlane,
    }, controller.signal);
    const session = await enroll(controlPlane, proof, controller.signal);
    await persistSession(session);
    // Resolve the success sink SOLELY from the post-enrollment effective config
    // (admin-shipped file > the just-persisted policy), with the env fallback
    // applied downstream by recordAuditEvent. We must NOT fall back to the
    // pre-enrollment `auditSink`: this login may have *replaced* a previous
    // enrollment (e.g. switching from org A to org B). Reusing A's sink would ship
    // B's identity and control-plane origin to A's SIEM, and would also prevent a
    // refreshed policy from removing an enrollment-provided sink. An undefined
    // result here correctly means "no org/file sink → env only (or nothing)".
    const successSink = await resolveEffectiveAuditSink();
    // Await the terminal event: the CLI calls process.exit right after this
    // returns, which would otherwise kill an in-flight fire-and-forget request
    // before it is delivered. recordAuditEvent is bounded (own timeout) and never
    // throws, so awaiting it cannot stall or fail login.
    await recordAuditEvent(
      { action: "login.success", flow, controlPlane: cpOrigin, subject: session.subject },
      { sink: successSink },
    );
    const who = session.subject ? ` as ${session.subject}` : "";
    report(`Signed in${who}. Your organization's settings are now active — restart Agav to use them.`);
    return 0;
  } catch (error) {
    // The audit event carries only an ALLOWLISTED reason code — never the raw
    // message, which can echo server response content (and thus secrets). The
    // full message still goes to stderr for local debugging. Awaited for the same
    // reason as login.success: survive the imminent exit.
    await recordAuditEvent(
      { action: "login.failure", flow, controlPlane: cpOrigin, reason: classifyFailureReason(error) },
      { sink: auditSink },
    );
    reportError(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Normalize a control-plane URL to its origin for audit events. Falls back to
 * the raw value if it cannot be parsed, so auditing never throws on a bad URL.
 */
function controlPlaneOrigin(controlPlane: string): string {
  try {
    return new URL(controlPlane).origin;
  } catch {
    return controlPlane;
  }
}

/**
 * Resolve the effective audit sink with the correct org-policy precedence:
 * an admin-shipped file outranks the enrolled policy. Returns the org-policy
 * value (file or, failing that, enrollment); the env fallback (AGAV_AUDIT_SINK)
 * is applied downstream by recordAuditEvent/resolveAuditSink. Undefined when no
 * org-policy sink is set. Never throws.
 */
async function resolveEffectiveAuditSink(): Promise<string | undefined> {
  try {
    const { loadOrgPolicy } = await import("../config/org-config.js");
    return (await loadOrgPolicy()).config?.auditSink;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the audit settings for a logout, read BEFORE the enrollment cache is
 * cleared. Two subtleties the earlier version got wrong:
 *
 *   - **Sink:** read with admin-file-over-enrollment precedence, including a sink
 *     that only exists in the enrolled policy (loadOrgPolicy reads the policy store
 *     we are about to delete), so a self-hosted org's sink still receives sign-out.
 *   - **Origin:** use the enrolled record's *actual* `controlPlane` metadata — the
 *     origin the session was issued by — not `config.controlPlane` (the policy's
 *     optional field, which a returned policy may omit). Otherwise a self-hosted
 *     login via --control-plane whose policy omits `controlPlane` would later be
 *     logged against the hosted default. Falls back to the resolved address.
 *
 * Never throws — auditing is best-effort and must not affect logout.
 */
async function resolveLogoutAudit(args: string[]): Promise<{ sink?: string; controlPlane?: string }> {
  try {
    const parsed = parseLoginArgs(args);
    const flag = "error" in parsed ? undefined : parsed.controlPlane;
    const sink = await resolveEffectiveAuditSink();

    // Prefer the enrolled record's stored origin (the true issuer). Fall back to
    // the resolved address (flag -> env -> policy -> hosted default) when there is
    // no enrolled record (e.g. logout with nothing enrolled).
    let origin: string | undefined;
    try {
      const { loadEnrolledPolicy } = await import("../config/enterprise-policy-store.js");
      const enrolled = await loadEnrolledPolicy();
      if (enrolled?.controlPlane) origin = controlPlaneOrigin(enrolled.controlPlane);
    } catch {
      // ignore — fall through to the resolved address
    }
    if (!origin) {
      const config = await loadConfig();
      const { resolveControlPlane } = await import("../enterprise/control-plane-address.js");
      origin = controlPlaneOrigin(resolveControlPlane({ flag, orgConfig: config.controlPlane }));
    }
    return { sink, controlPlane: origin };
  } catch {
    return {};
  }
}

export { parseLoginArgs, autoSelectFlow };
