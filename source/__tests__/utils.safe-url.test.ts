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
