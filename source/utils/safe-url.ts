import { isIP } from "node:net";
import { lookup as dnsLookupCallback, type LookupAddress, type LookupAllOptions } from "node:dns";

/**
 * SSRF guard shared by every Agav network tool.
 *
 * `fetch_url` (and `web_search`, and any future network tool) runs inside
 * Agav's own process, outside the OS sandbox, so the "deny network egress"
 * protection for sandboxed shell commands does not cover it. A model — or a
 * prompt-injected one — must not be able to reach cloud instance metadata,
 * loopback, or private/internal services and exfiltrate credentials to them.
 *
 * The guard does two things that a bare hostname check cannot:
 *   1. Resolves DNS itself and rejects the request if ANY resolved address is
 *      private/reserved/metadata. Resolving all addresses (not just the first)
 *      closes the "public A record, private AAAA record" split-horizon trick.
 *   2. Pins the connection to the exact validated address via a custom
 *      `lookup`, so a second resolution at connect time (DNS rebinding) cannot
 *      swap in an internal IP after the check passed.
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

/** A resolved, validated target: the hostname to connect to and the pinned IP. */
export interface SafeTarget {
  url: URL;
  /** The single validated address the connection must be pinned to. */
  address: string;
  family: 4 | 6;
}

/**
 * A `dns.lookup`-compatible function that returns ONLY the pre-validated
 * address. Passing this to `http(s).request`/`Agent` pins the socket to the IP
 * that was checked, eliminating the rebinding window between check and connect.
 */
export function pinnedLookup(target: SafeTarget) {
  return (
    _hostname: string,
    options: unknown,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ): void => {
    const all = typeof options === "object" && options !== null && (options as LookupAllOptions).all === true;
    if (all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
}

function dnsLookupAll(hostname: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookupCallback(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

/** Parse an IPv4 dotted-quad into its four octets, or `undefined` if malformed. */
function ipv4Octets(address: string): [number, number, number, number] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) return undefined;
  return octets as [number, number, number, number];
}

/** True if an IPv4 address is loopback / private / link-local / reserved / metadata. */
function isForbiddenIpv4(address: string): boolean {
  const octets = ipv4Octets(address);
  if (!octets) return true; // Unparseable: fail closed.
  const [a, b] = octets;
  if (a === 0) return true; // "this" network / 0.0.0.0
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
  if (a === 168 && b === 63 && octets[2] === 129 && octets[3] === 16) return true; // Azure WireServer platform endpoint
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
  if (a === 192 && b === 0 && octets[2] === 0) return true; // 192.0.0.0/24 IETF protocol
  if (a === 192 && b === 0 && octets[2] === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && octets[2] === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && octets[2] === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // multicast (224/4) + reserved/broadcast (240/4, 255.255.255.255)
  return false;
}

/** Normalise an IPv6 address to its 8 16-bit hextets, expanding "::". */
function ipv6Hextets(address: string): number[] | undefined {
  let value = address;
  const zone = value.indexOf("%"); // strip scope id (fe80::1%en0)
  if (zone !== -1) value = value.slice(0, zone);
  // A trailing dotted-quad (e.g. ::ffff:8.8.8.8) encodes the last two hextets.
  const dotted = value.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const octets = ipv4Octets(dotted[1]!);
    if (!octets) return undefined;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    value = value.slice(0, dotted.index) + `${hi}:${lo}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const parse = (segment: string): number[] =>
    segment.length === 0 ? [] : segment.split(":").map((hextet) => parseInt(hextet, 16));
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 && head.length !== 8) return undefined;
  if (halves.length === 2 && fill < 0) return undefined;
  const hextets = [...head, ...new Array(Math.max(0, fill)).fill(0), ...tail];
  if (hextets.length !== 8 || hextets.some((h) => Number.isNaN(h) || h < 0 || h > 0xffff)) return undefined;
  return hextets;
}

/** True if an IPv6 address is loopback / link-local / ULA / metadata, including IPv4-mapped forms. */
function isForbiddenIpv6(address: string): boolean {
  const hextets = ipv6Hextets(address);
  if (!hextets) return true; // Unparseable: fail closed.
  const [h0, h1] = hextets;
  if (hextets.every((h) => h === 0)) return true; // :: unspecified
  if (hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1) return true; // ::1 loopback
  if ((h0! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h0! & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if (h0 === 0x0064 && h1 === 0xff9b && hextets[2] === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  if ((h0! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local (ULA)
  if (h0 === 0xfd00 && h1 === 0x0ec2) return true; // fd00:ec2::254 AWS IPv6 metadata prefix
  // IPv4-mapped / IPv4-compatible / NAT64 (::ffff:a.b.c.d, 64:ff9b::a.b.c.d):
  // validate the embedded IPv4 against the IPv4 rules.
  if (
    (hextets.slice(0, 5).every((h) => h === 0) && (hextets[5] === 0 || hextets[5] === 0xffff)) ||
    (h0 === 0x0064 && h1 === 0xff9b && hextets.slice(2, 6).every((h) => h === 0)) // 64:ff9b::/96 only
  ) {
    const a = (hextets[6]! >> 8) & 0xff;
    const b = hextets[6]! & 0xff;
    const c = (hextets[7]! >> 8) & 0xff;
    const d = hextets[7]! & 0xff;
    return isForbiddenIpv4(`${a}.${b}.${c}.${d}`);
  }
  return false;
}

/** True if a literal IP address must not be reached by a network tool. */
export function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isForbiddenIpv4(address);
  if (family === 6) return isForbiddenIpv6(address);
  return true; // Not an IP literal: caller must have resolved first.
}

export interface AssertSafeUrlOptions {
  /** Override DNS resolution — used by tests to avoid real network access. */
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
}

/**
 * Validate a URL for outbound requests. Rejects non-`http(s)` schemes, resolves
 * DNS, and rejects the request if ANY resolved address is private/reserved/
 * metadata. Returns a `SafeTarget` pinned to the first usable public address so
 * the caller can connect without a second (rebindable) resolution.
 */
export async function assertSafeUrl(input: string | URL, options?: AssertSafeUrlOptions): Promise<SafeTarget> {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : input;
  } catch {
    throw new UnsafeUrlError(`Invalid URL: ${String(input)}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError(`Refusing to fetch non-http(s) URL (scheme "${url.protocol.replace(/:$/, "")}").`);
  }

  // Strip brackets from IPv6 literal hosts: new URL("http://[::1]/").hostname === "[::1]".
  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (!host) throw new UnsafeUrlError("Refusing to fetch a URL with no host.");

  // A literal IP needs no DNS; validate it directly and pin to it.
  const literalFamily = isIP(host);
  if (literalFamily !== 0) {
    if (isForbiddenAddress(host)) {
      throw new UnsafeUrlError(`Refusing to connect to private/reserved address ${host}.`);
    }
    return { url, address: host, family: literalFamily === 4 ? 4 : 6 };
  }

  let addresses: LookupAddress[];
  try {
    addresses = await (options?.resolve ?? dnsLookupAll)(host);
  } catch (error) {
    throw new UnsafeUrlError(`Could not resolve host "${host}": ${error instanceof Error ? error.message : String(error)}`);
  }
  if (addresses.length === 0) throw new UnsafeUrlError(`Host "${host}" did not resolve to any address.`);

  // Fail closed: if ANY resolved record is forbidden, reject the whole request
  // rather than cherry-picking a public one (split-horizon DNS protection).
  for (const { address } of addresses) {
    if (isForbiddenAddress(address)) {
      throw new UnsafeUrlError(`Host "${host}" resolves to a private/reserved address (${address}).`);
    }
  }

  const chosen = addresses[0]!;
  return { url, address: chosen.address, family: chosen.family === 4 ? 4 : 6 };
}
