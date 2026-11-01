/**
 * Guards against a consumer API key reaching places it must never go — prompt
 * history, attachments, or the model — when a user types or pastes it into the
 * ordinary composer instead of using the masked `/login --key` prompt.
 *
 * The composer records submissions to prompt history and routes long pastes to
 * the model as attachments BEFORE the `/login` command handler runs, so the
 * handler alone cannot prevent the leak. These predicates let the composer and
 * the submit path detect and neutralise credential-bearing input up front.
 */

/** A consumer API key token. */
const API_KEY_RE = /agav_sk_[A-Za-z0-9_-]+/;

/** True if the text contains anything resembling an Agav API key. */
export function containsApiKey(text: string): boolean {
  return API_KEY_RE.test(text);
}

/**
 * True when `text` is a `/login`/`/logout` invocation that ACTUALLY carries a
 * consumer API key — an inline `--key <value>`, `--key=<value>`, or a bare
 * `agav_sk_...` token. Such input must be kept out of history and never submitted
 * to the model; the user is redirected to the masked prompt.
 *
 * A VALUELESS `--key` is deliberately NOT flagged here: `/login --key` is the
 * supported, safe way to open the masked prompt, so it must pass through to the
 * command handler. (The handler ignores any inline value in the TUI anyway.)
 */
export function isCredentialBearingLogin(text: string): boolean {
  const t = text.trim();
  if (!/^\/(login|logout)\b/.test(t)) return false;
  if (containsApiKey(t)) return true;
  // `--key <value>` or `--key=<value>` where the value is a non-flag token.
  if (/(^|\s)--key=\S/.test(t)) return true;
  const m = /(^|\s)--key(\s+(\S+))?/.exec(t);
  if (m && m[3] && !m[3].startsWith("--")) return true;
  return false;
}

/**
 * True when a composed submission (free text, not just a /login command) carries a
 * consumer API key and so must never be submitted to the model or saved to
 * history. This catches the ways a key reaches the composer WITHOUT a /login
 * prefix — e.g. pasting the key alone, or the repeat-paste feature expanding a
 * key-containing attachment back into literal composer text. The dedicated masked
 * prompt (`/login --key`) remains the only safe entry point.
 */
export function submissionCarriesApiKey(text: string): boolean {
  return containsApiKey(text) || isCredentialBearingLogin(text);
}
