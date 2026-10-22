/**
 * Validate a URL used in an auth/enrollment flow: HTTPS only, except HTTP on
 * loopback (for the local redirect server), and never with embedded credentials.
 * Mirrors the rule enforced in mcp/oauth.ts so enterprise auth holds the same
 * transport-security bar. Returns the parsed URL or throws.
 */
export function secureURL(value: string | URL): URL {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error(
      "Enterprise auth requires HTTPS (HTTP is allowed only on loopback), without URL credentials.",
    );
  }
  return url;
}
