import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPkce, randomToken } from "../enterprise/pkce.js";

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("pkce", () => {
  it("produces an S256 challenge that is the hash of the verifier", () => {
    const { verifier, challenge, method } = createPkce();
    expect(method).toBe("S256");
    expect(challenge).toBe(base64url(createHash("sha256").update(verifier).digest()));
  });

  it("uses url-safe base64 without padding", () => {
    const { verifier, challenge } = createPkce();
    for (const value of [verifier, challenge]) {
      expect(value).toMatch(/^[A-Za-z0-9\-_]+$/);
      expect(value).not.toContain("=");
    }
  });

  it("keeps the verifier within the RFC 7636 length range (43-128)", () => {
    const { verifier } = createPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it("generates a unique pair each call", () => {
    const a = createPkce();
    const b = createPkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });

  it("randomToken is url-safe and unique", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(a).not.toBe(b);
  });
});
