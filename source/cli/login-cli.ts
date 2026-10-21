import { loadConfig } from "../config/config.js";
import { enroll, persistSession } from "../enterprise/control-plane.js";
import { clearEnrolledPolicy } from "../config/enterprise-policy-store.js";
import { hasOidcTokenSource } from "../enterprise/flow-oidc-token.js";
import { openExternal } from "../utils/open-external.js";
import { recordAuditEvent } from "../enterprise/audit.js";
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

/** Entry point for `agav login` / `agav logout`. Returns a process exit code. */
export async function runLoginCommand(command: string | undefined, args: string[]): Promise<number> {
  if (command === "logout") {
    // Capture the effective audit settings BEFORE clearing the cache: an
    // enrollment-delivered auditSink / controlPlane lives in the policy store we
    // are about to delete, so reading them afterward would lose them and drop (or
    // misroute) the logout event.
    const audit = await resolveLogoutAudit(args);
    try {
      await clearEnrolledPolicy();
    } catch (error) {
      console.error(
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
    console.log("Signed out of your organization. Restart Agav to apply.");
    return 0;
  }

  const parsed = parseLoginArgs(args);
  if ("error" in parsed) {
    console.error(`${parsed.error}\nUsage: agav login [--device | --oidc | --auth-code | --saml] [--control-plane URL] [--issuer URL] [--client-id ID]`);
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
    // Await the terminal event: the CLI calls process.exit right after this
    // returns, which would otherwise kill an in-flight fire-and-forget request
    // before it is delivered. recordAuditEvent is bounded (own timeout) and never
    // throws, so awaiting it cannot stall or fail login.
    await recordAuditEvent(
      { action: "login.success", flow, controlPlane: cpOrigin, subject: session.subject },
      { sink: auditSink },
    );
    const who = session.subject ? ` as ${session.subject}` : "";
    console.log(`Signed in${who}. Your organization's settings are now active — restart Agav to use them.`);
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Awaited for the same reason as login.success: survive the imminent exit.
    await recordAuditEvent({ action: "login.failure", flow, controlPlane: cpOrigin, reason }, { sink: auditSink });
    console.error(reason);
    return 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
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
 * Resolve the audit settings for a logout, read from config BEFORE the enrollment
 * cache is cleared. Resolves the sink and control-plane origin the same way the
 * login path does, so a self-hosted org's sink receives the sign-out too. Never
 * throws — auditing is best-effort and must not affect logout.
 */
async function resolveLogoutAudit(args: string[]): Promise<{ sink?: string; controlPlane?: string }> {
  try {
    const parsed = parseLoginArgs(args);
    const flag = "error" in parsed ? undefined : parsed.controlPlane;
    const config = await loadConfig();
    const { resolveControlPlane } = await import("../enterprise/control-plane-address.js");
    const controlPlane = resolveControlPlane({ flag, orgConfig: config.controlPlane });
    return { sink: config.auditSink, controlPlane: controlPlaneOrigin(controlPlane) };
  } catch {
    return {};
  }
}

export { parseLoginArgs, autoSelectFlow };
