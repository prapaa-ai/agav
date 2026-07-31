import { describe, it, expect, vi } from "vitest";

vi.mock("node:os", () => ({
  homedir: () => "/Users/test",
  userInfo: () => ({ username: "agav" }),
}));

import { decrypt, encrypt, isEncrypted, maskApiKey } from "../utils/encrypt.js";

describe("utils/encrypt", () => {
  it("leaves empty and already-encrypted values unchanged", () => {
    expect(encrypt("")).toBe("");
    expect(encrypt("enc:abc")).toBe("enc:abc");
    expect(decrypt("")).toBe("");
    expect(decrypt("plain")).toBe("plain");
  });

  it("round-trips plaintext", () => {
    const ciphertext = encrypt("secret-value");
    expect(isEncrypted(ciphertext)).toBe(true);
    expect(decrypt(ciphertext)).toBe("secret-value");
  });

  it("returns original ciphertext on invalid payloads", () => {
    expect(decrypt("enc:not-base64")).toBe("enc:not-base64");
  });

  it("masks api keys predictably", () => {
    expect(maskApiKey("enc:abcd")).toBe("(encrypted)");
    expect(maskApiKey("short")).toBe("****");
    expect(maskApiKey("1234567890")).toBe("12345...890");
  });
});
