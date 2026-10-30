import { describe, expect, it } from "vitest";
import { containsApiKey, isCredentialBearingLogin, submissionCarriesApiKey } from "../account/credential-input.js";

describe("containsApiKey", () => {
  it("detects an Agav key anywhere in the text", () => {
    expect(containsApiKey("here is agav_sk_abc123 in text")).toBe(true);
    expect(containsApiKey("no key here")).toBe(false);
  });
});

describe("isCredentialBearingLogin", () => {
  it("flags a /login that ACTUALLY carries a key (inline value or bare token)", () => {
    expect(isCredentialBearingLogin("/login --key agav_sk_abc123")).toBe(true);
    expect(isCredentialBearingLogin("/login agav_sk_abc123")).toBe(true);
    expect(isCredentialBearingLogin("/login --key=agav_sk_x")).toBe(true);
    expect(isCredentialBearingLogin("/login --key somevalue")).toBe(true); // a value is present
  });

  it("does NOT flag a valueless --key (that opens the safe masked prompt)", () => {
    expect(isCredentialBearingLogin("/login --key")).toBe(false);
    expect(isCredentialBearingLogin("/login --key ")).toBe(false);
  });

  it("does not flag a plain /login or unrelated input", () => {
    expect(isCredentialBearingLogin("/login")).toBe(false);
    expect(isCredentialBearingLogin("/login --device")).toBe(false);
    expect(isCredentialBearingLogin("just some agav_sk_abc123 text")).toBe(false); // not a login command
    expect(isCredentialBearingLogin("/status")).toBe(false);
  });
});

describe("submissionCarriesApiKey", () => {
  it("flags a bare key pasted into the composer WITHOUT a /login prefix", () => {
    // The repeat-paste-expansion / raw-key-paste bypass: a key reaches the text
    // with no command prefix. It must still be blocked from model + history.
    expect(submissionCarriesApiKey("agav_sk_abc123def456")).toBe(true);
    expect(submissionCarriesApiKey("here: agav_sk_abc123 ok")).toBe(true);
  });

  it("flags a credential-bearing /login too", () => {
    expect(submissionCarriesApiKey("/login --key agav_sk_abc123")).toBe(true);
  });

  it("does not flag ordinary input or a valueless /login --key", () => {
    expect(submissionCarriesApiKey("please refactor this file")).toBe(false);
    expect(submissionCarriesApiKey("/login --key")).toBe(false);
    expect(submissionCarriesApiKey("/login")).toBe(false);
  });
});
