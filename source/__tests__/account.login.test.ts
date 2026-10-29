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
  it("does not select consumer mode for a plain /login (enterprise default)", () => {
    expect(parseConsumerArgs([])).toEqual({ consumer: false });
  });

  it("does not treat enterprise flags as consumer", () => {
    expect(parseConsumerArgs(["--device"])).toEqual({ consumer: false });
    expect(parseConsumerArgs(["--control-plane", "https://auth.corp"])).toEqual({ consumer: false });
  });

  it("selects consumer mode on --key or --consumer", () => {
    expect(parseConsumerArgs(["--key"])).toMatchObject({ consumer: true });
    expect(parseConsumerArgs(["--consumer"])).toMatchObject({ consumer: true });
  });

  it("captures an inline --key value and --account-service", () => {
    expect(parseConsumerArgs(["--key", "agav_sk_x", "--account-service", "https://staging.agav.dev"]))
      .toEqual({ consumer: true, inlineKey: "agav_sk_x", accountService: "https://staging.agav.dev" });
    expect(parseConsumerArgs(["--key=agav_sk_y", "--account-service=https://s.dev"]))
      .toEqual({ consumer: true, inlineKey: "agav_sk_y", accountService: "https://s.dev" });
  });

  it("does NOT mistake an enterprise option's value for a consumer key", () => {
    // `agav_sk_...` here is the --client-id VALUE, consumed as such → enterprise.
    expect(parseConsumerArgs(["--oidc", "--client-id", "agav_sk_lookslikeakey"]))
      .toEqual({ consumer: false });
    expect(parseConsumerArgs(["--client-id", "agav_sk_x", "--oidc"]))
      .toEqual({ consumer: false });
  });

  it("rejects a bare agav_sk_ operand with guidance (never on the command line)", () => {
    const r = parseConsumerArgs(["agav_sk_rawkey123456"]);
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/shell history/i);
  });

  it("rejects an unknown consumer flag instead of ignoring it", () => {
    expect(parseConsumerArgs(["--key", "--bogus"])).toHaveProperty("error");
    expect(parseConsumerArgs(["--consumer", "--bogus"])).toHaveProperty("error");
  });

  it("is order-independent (foreign flag before or after consumer flag behaves the same)", () => {
    // Mixing enterprise + consumer flags is rejected regardless of order.
    expect(parseConsumerArgs(["--device", "--key"])).toHaveProperty("error");
    expect(parseConsumerArgs(["--key", "--device"])).toHaveProperty("error");
  });

  it("rejects mixing enterprise and consumer flags", () => {
    const r = parseConsumerArgs(["--control-plane", "https://corp", "--consumer"]);
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/mixing/i);
  });

  it("rejects unexpected operands in consumer mode", () => {
    expect(parseConsumerArgs(["--consumer", "unexpected"])).toHaveProperty("error");
    expect(parseConsumerArgs(["--consumer", "-x"])).toHaveProperty("error");
  });

  it("requires a value for --account-service", () => {
    expect(parseConsumerArgs(["--consumer", "--account-service"])).toHaveProperty("error");
  });

  it("rejects an =value attached to a boolean selector (not treated as logout)", () => {
    expect(parseConsumerArgs(["--account=false"])).toHaveProperty("error");
    expect(parseConsumerArgs(["--consumer=false"])).toHaveProperty("error");
    // Plain boolean selectors remain valid.
    expect(parseConsumerArgs(["--account"])).toEqual({ consumer: true });
  });

  it("rejects a stray subcommand operand (malformed mixed command)", () => {
    // `agav logout login --key` leaves ["login","--key"] after the consumed
    // subcommand; "login" is an unexpected operand and must be rejected, not
    // silently turned into a credential-clearing consumer action.
    const r = parseConsumerArgs(["login", "--key"]);
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/unexpected argument/i);
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
