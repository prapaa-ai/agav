import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../account/account-store.js", () => ({
  saveStoredAccount: vi.fn().mockResolvedValue(undefined),
  clearStoredAccount: vi.fn().mockResolvedValue(undefined),
  SaveCancelledError: class SaveCancelledError extends Error {},
}));

const { signInWithApiKey, signOutAccount, looksLikeAgavApiKey, parseConsumerArgs } = await import("../account/account-login.js");
const { saveStoredAccount, clearStoredAccount } = await import("../account/account-store.js");
import { AccountError } from "../account/types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.mocked(saveStoredAccount).mockClear();
  vi.mocked(clearStoredAccount).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("looksLikeAgavApiKey", () => {
  it("accepts a well-formed key and rejects obvious non-keys", () => {
    expect(looksLikeAgavApiKey("agav_sk_abcdefghijklmnop")).toBe(true);
    expect(looksLikeAgavApiKey("  agav_sk_abcdefghijklmnop  ")).toBe(true);
    expect(looksLikeAgavApiKey("sk-openai-xxx")).toBe(false);
    expect(looksLikeAgavApiKey("agav_sk_")).toBe(false);
    expect(looksLikeAgavApiKey("")).toBe(false);
  });

  it("rejects a key with control characters or non-charset bytes (header-injection guard)", () => {
    // A control char would trip fetch's invalid-header error, whose message
    // echoes the whole Authorization value — so these must fail BEFORE any fetch.
    expect(looksLikeAgavApiKey("agav_sk_abcdef\u0000ghij")).toBe(false);
    expect(looksLikeAgavApiKey("agav_sk_abcdef\nghij")).toBe(false);
    expect(looksLikeAgavApiKey("agav_sk_abcdef ghij")).toBe(false);
    expect(looksLikeAgavApiKey("agav_sk_abc$def%ghi")).toBe(false);
  });
});

describe("signInWithApiKey", () => {
  it("rejects a key that doesn't look like an Agav key before any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(signInWithApiKey("sk-not-agav")).rejects.toThrow(/doesn't look like an Agav API key/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveStoredAccount).not.toHaveBeenCalled();
  });

  it("validates the key via whoami and persists the account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ accountId: "acct_9", email: "u@x.com", status: "active" })),
    );
    const identity = await signInWithApiKey("agav_sk_validkey123456", { accountService: "https://agav.dev" });
    expect(identity.accountId).toBe("acct_9");
    expect(saveStoredAccount).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveStoredAccount).mock.calls[0]![0];
    expect(saved.apiKey).toBe("agav_sk_validkey123456");
    expect(saved.accountId).toBe("acct_9");
    expect(saved.accountService).toBe("https://agav.dev");
  });

  it("does not persist when whoami rejects the key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401)));
    await expect(signInWithApiKey("agav_sk_badkey123456")).rejects.toThrow(AccountError);
    expect(saveStoredAccount).not.toHaveBeenCalled();
  });

  it("surfaces a persistence failure as an AccountError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ accountId: "acct_9", status: "active" })));
    vi.mocked(saveStoredAccount).mockRejectedValueOnce(new Error("EACCES"));
    await expect(signInWithApiKey("agav_sk_validkey123456")).rejects.toThrow(/could not save/i);
  });

  it("does not expose a secret-bearing persistence error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ accountId: "acct_9", status: "active" })));
    vi.mocked(saveStoredAccount).mockRejectedValueOnce(new Error("agav_sk_validkey123456"));
    const error = await signInWithApiKey("agav_sk_validkey123456").catch(error => error);
    expect(error).toBeInstanceOf(AccountError);
    expect(error.message).toContain("could not save");
    expect(error.message).not.toContain("agav_sk_validkey123456");
  });

  it("does not persist when cancelled between validation and save", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ accountId: "acct_9", status: "active" })));
    const controller = new AbortController();
    controller.abort(); // already aborted when we reach persistence
    await expect(signInWithApiKey("agav_sk_validkey123456", { signal: controller.signal }))
      .rejects.toThrow(/cancelled/i);
    expect(saveStoredAccount).not.toHaveBeenCalled();
  });

  it("passes the abort signal to saveStoredAccount so it can cancel before commit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ accountId: "acct_9", status: "active" })));
    const controller = new AbortController();
    await signInWithApiKey("agav_sk_validkey123456", { signal: controller.signal });
    // The signal is forwarded; saveStoredAccount owns the pre-commit cancel point.
    expect(vi.mocked(saveStoredAccount).mock.calls[0]![1]).toMatchObject({ signal: controller.signal });
  });

  it("reports cancellation (and does NOT destroy the prior account) on a pre-commit cancel", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ accountId: "acct_9", status: "active" })));
    // saveStoredAccount signals it cancelled before committing (prior account kept).
    const { SaveCancelledError } = await import("../account/account-store.js");
    vi.mocked(saveStoredAccount).mockRejectedValueOnce(new SaveCancelledError());
    await expect(signInWithApiKey("agav_sk_validkey123456", { signal: new AbortController().signal }))
      .rejects.toThrow(/cancelled/i);
    // Must NOT call clearStoredAccount — that would sign the user out entirely.
    expect(clearStoredAccount).not.toHaveBeenCalled();
  });
});

describe("signOutAccount", () => {
  it("clears the stored account", async () => {
    await signOutAccount();
    expect(clearStoredAccount).toHaveBeenCalledTimes(1);
  });
});

describe("parseConsumerArgs", () => {
  it("defaults a bare /login to the consumer wizard", () => {
    expect(parseConsumerArgs([])).toEqual({ consumer: true });
  });

  it("routes explicit enterprise flags to enterprise (consumer: false)", () => {
    expect(parseConsumerArgs(["--device"])).toEqual({ consumer: false });
    expect(parseConsumerArgs(["--control-plane", "https://auth.corp"])).toEqual({ consumer: false });
    expect(parseConsumerArgs(["--oidc", "--client-id", "x"])).toEqual({ consumer: false });
  });

  it("accepts the explicit consumer selectors", () => {
    expect(parseConsumerArgs(["--consumer"])).toEqual({ consumer: true });
    expect(parseConsumerArgs(["--account"])).toEqual({ consumer: true });
  });

  it("captures --account-service (flag and =form)", () => {
    expect(parseConsumerArgs(["--account-service", "https://staging.agav.dev"]))
      .toEqual({ consumer: true, accountService: "https://staging.agav.dev" });
    expect(parseConsumerArgs(["--account-service=https://s.dev"]))
      .toEqual({ consumer: true, accountService: "https://s.dev" });
  });

  it("does NOT mistake an enterprise option's value for an operand", () => {
    expect(parseConsumerArgs(["--oidc", "--client-id", "agav_sk_lookslikeakey"]))
      .toEqual({ consumer: false });
    expect(parseConsumerArgs(["--client-id", "agav_sk_x", "--oidc"]))
      .toEqual({ consumer: false });
  });

  it("there is no --key flag anymore (rejected as unknown)", () => {
    expect(parseConsumerArgs(["--key"])).toHaveProperty("error");
    expect(parseConsumerArgs(["--key", "agav_sk_x"])).toHaveProperty("error");
  });

  it("rejects a bare agav_sk_ operand with guidance (never on the command line)", () => {
    const r = parseConsumerArgs(["agav_sk_rawkey123456"]);
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/shell history/i);
    // Also when accompanied by enterprise flags.
    expect(parseConsumerArgs(["--oidc", "agav_sk_rawkey123456"])).toHaveProperty("error");
  });

  it("rejects an unknown consumer flag instead of ignoring it", () => {
    expect(parseConsumerArgs(["--bogus"])).toHaveProperty("error");
    expect(parseConsumerArgs(["--consumer", "--bogus"])).toHaveProperty("error");
  });

  it("rejects mixing enterprise and consumer flags (either order)", () => {
    expect(parseConsumerArgs(["--control-plane", "https://corp", "--consumer"])).toHaveProperty("error");
    expect(parseConsumerArgs(["--consumer", "--device"])).toHaveProperty("error");
    expect(parseConsumerArgs(["--device", "--account"])).toHaveProperty("error");
  });

  it("rejects unexpected operands in consumer mode", () => {
    expect(parseConsumerArgs(["unexpected"])).toHaveProperty("error");
    expect(parseConsumerArgs(["--consumer", "extra"])).toHaveProperty("error");
  });

  it("requires a value for --account-service", () => {
    expect(parseConsumerArgs(["--account-service"])).toHaveProperty("error");
  });

  it("rejects an =value attached to a boolean selector", () => {
    expect(parseConsumerArgs(["--account=false"])).toHaveProperty("error");
    expect(parseConsumerArgs(["--consumer=false"])).toHaveProperty("error");
    expect(parseConsumerArgs(["--account"])).toEqual({ consumer: true });
  });
});

describe("signInWithApiKey account-service override", () => {
  it("validates against the explicit account-service", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ accountId: "acct_s", status: "active" }));
    vi.stubGlobal("fetch", fetchMock);
    await signInWithApiKey("agav_sk_validkey123456", { accountService: "https://staging.agav.dev" });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://staging.agav.dev/api/account/whoami");
  });
});

describe("secret-safe removed option errors", () => {
  it.each([
    ["--key=agav_sk_secret123456"],
    ["--device", "--key=agav_sk_secret123456"],
    ["--key=agav_sk_secret123456", "--device"],
    ["--unknown=agav_sk_secret123456"],
    ["prefix-agav_sk_secret123456"],
  ])("does not echo credentials in %j", (...args) => {
    const result = parseConsumerArgs(args);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).not.toContain("agav_sk_secret123456");
  });
});
