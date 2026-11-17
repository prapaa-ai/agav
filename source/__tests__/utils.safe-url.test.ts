import { describe, expect, it } from "vitest";
import type { LookupAddress } from "node:dns";
import { assertSafeUrl, isForbiddenAddress, pinnedLookup, UnsafeUrlError } from "../utils/safe-url.js";

/** A stub resolver so tests never touch real DNS. */
function resolveTo(...addresses: Array<{ address: string; family: 4 | 6 }>) {
  return async (): Promise<LookupAddress[]> => addresses;
}

describe("isForbiddenAddress", () => {
  it.each([
    "127.0.0.1", "127.1.2.3", "0.0.0.0", "10.0.0.1", "10.255.255.255",
    "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "169.254.0.1",
    "100.64.0.1", "192.0.2.5", "198.18.0.1", "198.51.100.3", "203.0.113.9",
    "224.0.0.1", "255.255.255.255",
  ])("rejects private/reserved IPv4 %s", (address) => {
    expect(isForbiddenAddress(address)).toBe(true);
  });

  it.each([
    "::1", "::", "fe80::1", "fe80::abcd%en0", "fc00::1", "fd12:3456::1", "fd00:ec2::254",
    "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:10.0.0.1", "64:ff9b::7f00:1",
  ])("rejects private/reserved IPv6 %s", (address) => {
    expect(isForbiddenAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "172.15.255.255", "192.167.1.1", "100.63.0.1", "100.128.0.1"])(
    "allows public IPv4 %s", (address) => {
      expect(isForbiddenAddress(address)).toBe(false);
    },
  );

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"])(
    "allows public IPv6 %s", (address) => {
      expect(isForbiddenAddress(address)).toBe(false);
    },
  );

  it.each([
    "fec0::", "fec0::1", "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "64:ff9b:1::", "64:ff9b:1::808:808", "64:ff9b:1:ffff:ffff:ffff:ffff:ffff",
    "64:ff9b:1:a00::808:808",
    "64:ff9b::10.0.0.1", "0064:ff9b:0000:0000:0000:0000:a9fe:a9fe",
    "168.63.129.16", "::ffff:168.63.129.16", "64:ff9b::a83f:8110",
  ])("rejects site-local, local NAT64, and platform endpoints %s", (address) => {
    expect(isForbiddenAddress(address)).toBe(true);
  });

  it.each([
    "168.63.129.15", "168.63.129.17",
    "64:ff9b::1.0.0.0", "64:ff9b::8.8.8.8", "64:ff9b::dfff:ffff",
    "0064:ff9b:0000:0000:0000:0000:0808:0808",
  ])("allows public addresses and well-known NAT64 targets %s", (address) => {
    expect(isForbiddenAddress(address)).toBe(false);
  });

  it.each([
    "64:ff9b:0:0:0:1:7f00:1", "64:ff9b:0:0:1:0:7f00:1",
    "64:ff9b:0:1::7f00:1", "64:ff9b:2::7f00:1",
    "64:ff9b:0:ffff:ffff:ffff:ffff:ffff", "64:ff9b:2::",
    "64:ff9a::7f00:1", "64:ff9c::7f00:1",
  ])("does not extract IPv4 outside the well-known NAT64 /96 or local-use /48: %s", (address) => {
    expect(isForbiddenAddress(address)).toBe(false);
  });

  it("keeps link-local and site-local boundaries distinct from other IPv6 space", () => {
    expect(isForbiddenAddress("fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(false);
    expect(isForbiddenAddress("fe80::")).toBe(true);
    expect(isForbiddenAddress("febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(true);
    expect(isForbiddenAddress("2001:4860:4860::8888")).toBe(false);
  });

  it("fails closed on unparseable input", () => {
    expect(isForbiddenAddress("not-an-ip")).toBe(true);
    expect(isForbiddenAddress("999.999.999.999")).toBe(true);
    expect(isForbiddenAddress("")).toBe(true);
  });
});

describe("assertSafeUrl", () => {
  it("rejects non-http(s) schemes without resolving", async () => {
    for (const url of ["file:///etc/passwd", "ftp://host/x", "gopher://host", "data:text/plain,hi"]) {
      await expect(assertSafeUrl(url)).rejects.toBeInstanceOf(UnsafeUrlError);
    }
  });

  it("rejects malformed URLs", async () => {
    await expect(assertSafeUrl("http://")).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertSafeUrl("not a url")).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("rejects literal private/metadata hosts without DNS", async () => {
    const reject = (url: string) => expect(assertSafeUrl(url, { resolve: async () => { throw new Error("should not resolve"); } }))
      .rejects.toThrow(/private\/reserved/);
    await reject("http://127.0.0.1/");
    await reject("http://169.254.169.254/latest/meta-data/");
    await reject("http://[::1]/");
    await reject("http://[fd00:ec2::254]/");
  });

  it.each([
    { address: "fec0::1", family: 6 as const },
    { address: "64:ff9b:1::808:808", family: 6 as const },
    { address: "168.63.129.16", family: 4 as const },
  ])("rejects internal endpoint $address both literally and in mixed DNS results", async ({ address, family }) => {
    const host = family === 6 ? `[${address}]` : address;
    await expect(assertSafeUrl(`https://${host}/`, {
      resolve: async () => { throw new Error("should not resolve literals"); },
    })).rejects.toThrow(/private\/reserved address/);
    await expect(assertSafeUrl("https://mixed.example/", {
      resolve: resolveTo({ address: "93.184.216.34", family: 4 }, { address, family }),
    })).rejects.toThrow(/private\/reserved address/);
  });

  it("pins public NAT64 literals and DNS records", async () => {
    const address = "64:ff9b::808:808";
    const literal = await assertSafeUrl(`https://[${address}]/`, {
      resolve: async () => { throw new Error("should not resolve literals"); },
    });
    const resolved = await assertSafeUrl("https://nat64.example/", {
      resolve: resolveTo({ address, family: 6 }),
    });
    expect(literal).toMatchObject({ address, family: 6 });
    expect(resolved).toMatchObject({ address, family: 6 });
  });

  it("pins to a validated public literal address", async () => {
    const target = await assertSafeUrl("https://93.184.216.34/path", { resolve: async () => { throw new Error("nope"); } });
    expect(target.address).toBe("93.184.216.34");
    expect(target.family).toBe(4);
  });

  it("rejects when ANY resolved record is private (split-horizon protection)", async () => {
    await expect(assertSafeUrl("https://sneaky.example/", {
      resolve: resolveTo({ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }),
    })).rejects.toThrow(/private\/reserved address \(10\.0\.0\.5\)/);
  });

  it("pins to the first public address when all records are public", async () => {
    const target = await assertSafeUrl("https://public.example/", {
      resolve: resolveTo({ address: "93.184.216.34", family: 4 }, { address: "8.8.8.8", family: 4 }),
    });
    expect(target.address).toBe("93.184.216.34");
  });

  it("surfaces resolution failure as UnsafeUrlError", async () => {
    await expect(assertSafeUrl("https://nx.example/", { resolve: async () => { throw new Error("ENOTFOUND"); } }))
      .rejects.toThrow(/Could not resolve host/);
    await expect(assertSafeUrl("https://empty.example/", { resolve: async () => [] }))
      .rejects.toThrow(/did not resolve/);
  });
});

describe("pinnedLookup", () => {
  it("returns only the validated address in both callback shapes", () => {
    const lookup = pinnedLookup({ url: new URL("https://x/"), address: "93.184.216.34", family: 4 });
    lookup("x", { all: true }, (err, result) => {
      expect(err).toBeNull();
      expect(result).toEqual([{ address: "93.184.216.34", family: 4 }]);
    });
    lookup("x", {}, (err, address, family) => {
      expect(err).toBeNull();
      expect(address).toBe("93.184.216.34");
      expect(family).toBe(4);
    });
  });
});
