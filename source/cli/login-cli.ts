import { loadConfig } from "../config/config.js";
import { enroll, persistSession } from "../enterprise/control-plane.js";
import { clearEnrolledPolicy } from "../config/enterprise-policy-store.js";
import { hasOidcTokenSource } from "../enterprise/flow-oidc-token.js";
import { openExternal } from "../utils/open-external.js";
import { EnterpriseAuthError, type AuthFlow, type IdentityProof } from "../enterprise/types.js";

/**
 * `agav login` / `agav logout` — enterprise enrollment.
 *
 * login: obtain an identity proof via the appropriate flow, exchange it at the
 * control plane for an org policy + short-lived gateway credential, and cache it
 * so subsequent sessions enforce the policy. logout: clear the cached policy.
 *
 * Flow selection (override with --device / --oidc / --auth-code):
 *   - a CI OIDC token source present, or no TTY  -> oidc-token
 *   - a TTY with an openable browser             -> auth-code
 *   - otherwise                                  -> device
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
): Promise<IdentityProof> {
  if (flow === "oidc-token") {
    const { obtainIdTokenViaOidc } = await import("../enterprise/flow-oidc-token.js");
    return obtainIdTokenViaOidc({ audience: opts.controlPlane });
  }
  if (!opts.issuer || !opts.clientId) {
    throw new EnterpriseAuthError(
      "Interactive login needs an identity provider. Provide --issuer and --client-id, " +
      "or configure them in your organization policy.",
    );
  }
  if (flow === "device") {
    const { obtainIdTokenViaDevice } = await import("../enterprise/flow-device.js");
    return obtainIdTokenViaDevice({ issuer: opts.issuer, clientId: opts.clientId });
  }
  const { obtainIdTokenViaAuthCode } = await import("../enterprise/flow-auth-code.js");
  return obtainIdTokenViaAuthCode({
    issuer: opts.issuer,
    clientId: opts.clientId,
    openBrowser: openExternal,
  });
}

/** Entry point for `agav login` / `agav logout`. Returns a process exit code. */
export async function runLoginCommand(command: string | undefined, args: string[]): Promise<number> {
  if (command === "logout") {
    await clearEnrolledPolicy();
    console.log("Signed out. Removed the cached organization policy. Restart Agav to apply.");
    return 0;
  }

  const parsed = parseLoginArgs(args);
  if ("error" in parsed) {
    console.error(`${parsed.error}\nUsage: agav login [--device | --oidc | --auth-code] [--control-plane URL] [--issuer URL] [--client-id ID]`);
    return 1;
  }

  // Resolve configuration: explicit flags win, else the org policy seed.
  const config = await loadConfig();
  const controlPlane = parsed.controlPlane ?? config.controlPlane;
  if (!controlPlane) {
    console.error(
      "No control plane configured. Pass --control-plane <url>, or ship it in your organization policy.",
    );
    return 1;
  }

  const flow = parsed.flow ?? autoSelectFlow();

  const controller = new AbortController();
  const cancel = () => controller.abort(new EnterpriseAuthError("Login cancelled."));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const proof = await obtainProof(flow, {
      issuer: parsed.issuer,
      clientId: parsed.clientId,
      controlPlane,
    });
    const session = await enroll(controlPlane, proof, controller.signal);
    await persistSession(session);
    const who = session.subject ? ` as ${session.subject}` : "";
    console.log(`Signed in${who}. Organization policy applied. Restart Agav to use it.`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

export { parseLoginArgs, autoSelectFlow };
