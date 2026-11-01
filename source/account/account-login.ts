import { resolveAccountService } from "./account-address.js";
import { whoami } from "./account-client.js";
import { saveStoredAccount, clearStoredAccount, SaveCancelledError } from "./account-store.js";
import { AccountError, type AccountIdentity, type StoredAccount } from "./types.js";

/**
 * Consumer account sign-in orchestration: validate a pasted Agav API key against
 * the account service and persist it locally. This is the "paste-key" half of the
 * smart /login; the browser OAuth flow is a later slice that converges on the
 * same persisted StoredAccount.
 */

/** A pasted Agav API key looks like `agav_sk_<token>`. */
const API_KEY_PREFIX = "agav_sk_";
/**
 * The full, strict shape of a valid key: the prefix plus a token of URL-safe
 * base64 characters only. Validating the ENTIRE string (not just the prefix)
 * before it ever reaches a request header is a security requirement: a control
 * character would otherwise trip fetch's invalid-header error, whose message
 * echoes the full Authorization value — leaking the key into stderr.
 */
const API_KEY_RE = /^agav_sk_[A-Za-z0-9_-]{8,}$/;

/** Strict shape check before any network call: full charset, no control bytes. */
export function looksLikeAgavApiKey(value: string): boolean {
  return API_KEY_RE.test(value.trim());
}

/**
 * Parsed login intent, shared by the CLI and the slash command so the two never
 * diverge. `consumer` is the DEFAULT: a bare `/login`, `--consumer`/`--account`,
 * or `--account-service <url>` all open the consumer flow. Only an explicit
 * ENTERPRISE flag routes to enrollment (`consumer: false`). There is deliberately
 * no `--key` flag — the key is entered in the masked wizard, never via argv.
 */
export interface ConsumerArgs {
  consumer: boolean;
  accountService?: string;
}

/** Consumer boolean selectors (optional; bare /login already means consumer). */
const CONSUMER_BOOL_FLAGS = new Set(["--consumer", "--account"]);
/** The one consumer value flag: override the account-service base URL. */
const CONSUMER_VALUE_FLAGS = new Set(["--account-service"]);
/**
 * Enterprise flags, with arity, so we can consume their VALUES while deciding the
 * mode — an enterprise option's value is never mistaken for an operand.
 */
const ENTERPRISE_VALUE_FLAGS = new Set(["--control-plane", "--issuer", "--client-id"]);
const ENTERPRISE_BOOL_FLAGS = new Set(["--device", "--oidc", "--auth-code", "--saml"]);

const KEY_ON_CMDLINE_ERROR =
  "Don't pass your API key on the command line (it could be saved in shell history). " +
  "Run `/login` (or `agav login`) and paste it in the sign-in wizard, which hides it.";

interface Token {
  flag: string;        // "" for a bare operand
  value?: string;      // for value flags, incl. the =form
  raw: string;
  hasInlineEq?: boolean; // true when written as --flag=value (for boolean-flag rejection)
}

/** Split argv into tokens, pairing value flags with their value. Order-preserving. */
function tokenize(argv: string[]): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      tokens.push({ flag: "", raw: arg });
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    const takesValue = CONSUMER_VALUE_FLAGS.has(name) || ENTERPRISE_VALUE_FLAGS.has(name);
    if (takesValue) {
      let value = inlineValue;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) { value = next; i++; }
      }
      tokens.push({ flag: name, value, raw: arg });
    } else {
      tokens.push({ flag: name, raw: arg, hasInlineEq: eq !== -1 });
    }
  }
  return tokens;
}

/**
 * Parse login arguments in an ORDER-INDEPENDENT, mode-aware way.
 *
 * Consumer is the default. Only an explicit enterprise flag selects enrollment.
 * Mixing enterprise + consumer flags, unknown consumer flags, boolean `=value`,
 * and a bare `agav_sk_` key typed on the command line are all rejected.
 */
export function parseConsumerArgs(argv: string[]): ConsumerArgs | { error: string } {
  const tokens = tokenize(argv);
  // Never echo removed credential flags or secret-bearing unknown operands,
  // including when enterprise flags would otherwise route to another parser.
  if (tokens.some(t => t.flag === "--key")) {
    return { error: "--key is no longer supported. Open /login and choose Paste an Agav API key." };
  }
  if (tokens.some(t => !CONSUMER_VALUE_FLAGS.has(t.flag) && !ENTERPRISE_VALUE_FLAGS.has(t.flag)
    && t.raw.includes(API_KEY_PREFIX))) return { error: KEY_ON_CMDLINE_ERROR };

  const hasEnterprise = tokens.some((t) => ENTERPRISE_VALUE_FLAGS.has(t.flag) || ENTERPRISE_BOOL_FLAGS.has(t.flag));
  const hasConsumer = tokens.some((t) => CONSUMER_BOOL_FLAGS.has(t.flag) || CONSUMER_VALUE_FLAGS.has(t.flag));

  if (hasEnterprise) {
    if (hasConsumer) {
      return { error: "Mixing Agav account flags with enterprise flags isn't supported. Use one or the other." };
    }
    // A bare key alongside enterprise flags is still unsafe to accept.
    for (const t of tokens) {
      if (t.flag === "" && t.raw.startsWith("agav_sk_")) return { error: KEY_ON_CMDLINE_ERROR };
    }
    return { consumer: false };
  }

  // Consumer mode (the default). Validate the consumer grammar.
  const out: ConsumerArgs = { consumer: true };
  for (const t of tokens) {
    if (t.flag === "") {
      if (t.raw.startsWith("agav_sk_")) return { error: KEY_ON_CMDLINE_ERROR };
      return { error: `Unexpected argument for Agav account sign-in: ${t.raw}` };
    }
    if (CONSUMER_BOOL_FLAGS.has(t.flag)) {
      if (t.hasInlineEq) return { error: `${t.flag} does not take a value.` };
      continue;
    }
    if (t.flag === "--account-service") {
      if (t.value === undefined) return { error: "Missing value for --account-service." };
      out.accountService = t.value;
      continue;
    }
    return { error: `Unknown option for Agav account sign-in: ${t.raw}` };
  }
  return out;
}

export interface SignInOptions {
  /** Explicit account-service override (--account-service); else resolved. */
  accountService?: string;
  signal?: AbortSignal;
}

/**
 * Validate `apiKey` and persist the signed-in account. Returns the account
 * identity on success; throws AccountError on an invalid key, unreachable
 * service, or persistence failure.
 */
export async function signInWithApiKey(
  apiKey: string,
  options: SignInOptions = {},
): Promise<AccountIdentity> {
  const key = apiKey.trim();
  if (!looksLikeAgavApiKey(key)) {
    throw new AccountError(
      "That doesn't look like an Agav API key. Keys start with \"agav_sk_\" — create one at https://agav.dev/account.",
    );
  }

  const accountService = resolveAccountService({ flag: options.accountService });
  const identity = await whoami(accountService, key, options.signal);

  // Honour a cancellation that landed between validation and persistence: do not
  // start writing a new account the user asked to abort.
  if (options.signal?.aborted) throw new AccountError("Sign-in cancelled.");

  const record: StoredAccount = {
    apiKey: key,
    accountId: identity.accountId,
    email: identity.email,
    status: identity.status,
    accountService: new URL(accountService).origin,
    storedAt: new Date().toISOString(),
  };
  try {
    // Pass the signal: saveStoredAccount cancels BEFORE its commit, deleting only
    // the new credential and leaving any previously signed-in account intact. We
    // deliberately do NOT clear afterwards — a post-commit cancel means the switch
    // already succeeded, and clearing would wrongly sign the user out entirely.
    await saveStoredAccount(record, { signal: options.signal });
  } catch (error) {
    if (error instanceof SaveCancelledError) {
      throw new AccountError("Sign-in cancelled.");
    }
    throw new AccountError(
      "Signed in, but could not save your account locally. Check local storage permissions and try again.",
      { cause: error },
    );
  }
  return identity;
}

/** Sign out of the consumer account (clear the local store). */
export async function signOutAccount(): Promise<void> {
  await clearStoredAccount();
}
