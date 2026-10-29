import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../account/browser-auth-client.js", () => ({
  startAuthorization: vi.fn(),
  pollToken: vi.fn(),
  acknowledge: vi.fn(),
}));
vi.mock("../account/account-client.js", () => ({ whoami: vi.fn() }));
vi.mock("../account/account-store.js", () => ({
  saveStoredAccount: vi.fn().mockResolvedValue(undefined),
  SaveCancelledError: class SaveCancelledError extends Error {},
}));

const { signInWithBrowser } = await import("../account/browser-auth.js");
const client = await import("../account/browser-auth-client.js");
const { whoami } = await import("../account/account-client.js");
const { saveStoredAccount } = await import("../account/account-store.js");
import { AccountError } from "../account/types.js";

const startMock = vi.mocked(client.startAuthorization);
const pollMock = vi.mocked(client.pollToken);
const ackMock = vi.mocked(client.acknowledge);
const whoamiMock = vi.mocked(whoami);
const saveMock = vi.mocked(saveStoredAccount);

const REQUEST = {
  deviceCode: "dev_abc", userCode: "ABCD-2345",
  verificationUrl: "https://agav.dev/cli-auth",
  verificationUrlComplete: "https://agav.dev/cli-auth?code=ABCD-2345",
  expiresIn: 600, interval: 2,
};
const nosleep = async () => {};

beforeEach(() => {
  startMock.mockReset().mockResolvedValue(REQUEST);
  pollMock.mockReset();
  ackMock.mockReset().mockResolvedValue(true);
  whoamiMock.mockReset().mockResolvedValue({ accountId: "acct_1", email: "u@x.com", status: "active" });
  saveMock.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

function opts(overrides: Partial<Parameters<typeof signInWithBrowser>[0]> = {}) {
  return {
    accountService: "https://agav.dev",
    openBrowser: vi.fn(async () => true),
    onPrompt: vi.fn(),
    sleep: nosleep,
    ...overrides,
  };
}

describe("signInWithBrowser", () => {
  it("runs start → open browser → poll until approved → whoami → save → ack", async () => {
    pollMock.mockResolvedValueOnce({ status: "pending" }).mockResolvedValueOnce({ status: "approved", key: "agav_sk_delivered" });
    const o = opts();
    const identity = await signInWithBrowser(o);

    expect(startMock).toHaveBeenCalledTimes(1);
    expect(o.openBrowser).toHaveBeenCalledWith(REQUEST.verificationUrlComplete);
    expect(o.onPrompt).toHaveBeenCalledWith({ userCode: "ABCD-2345", verificationUrl: REQUEST.verificationUrl, openedBrowser: true });
    expect(whoamiMock.mock.calls[0]!.slice(0, 2)).toEqual(["https://agav.dev", "agav_sk_delivered"]);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0]![0]).toMatchObject({ apiKey: "agav_sk_delivered", accountId: "acct_1" });
    // Ack happens AFTER the save, with the device code + key.
    expect(ackMock.mock.calls[0]!.slice(0, 3)).toEqual(["https://agav.dev", "dev_abc", "agav_sk_delivered"]);
    expect(identity.email).toBe("u@x.com");
  });

  it("reports openedBrowser=false when the browser can't launch, still polling", async () => {
    pollMock.mockResolvedValue({ status: "approved", key: "agav_sk_delivered" });
    const o = opts({ openBrowser: vi.fn(async () => false) });
    await signInWithBrowser(o);
    expect(o.onPrompt).toHaveBeenCalledWith(expect.objectContaining({ openedBrowser: false }));
  });

  it("throws on denial without saving", async () => {
    pollMock.mockResolvedValue({ status: "denied" });
    await expect(signInWithBrowser(opts())).rejects.toThrow(/declined/i);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("throws on expiry", async () => {
    pollMock.mockResolvedValue({ status: "expired" });
    await expect(signInWithBrowser(opts())).rejects.toThrow(/expired/i);
  });

  it("backs off on slow_down then succeeds", async () => {
    pollMock
      .mockResolvedValueOnce({ status: "slow_down" })
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "approved", key: "agav_sk_delivered" });
    await signInWithBrowser(opts());
    expect(pollMock).toHaveBeenCalledTimes(3);
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it("times out when the deadline passes before approval", async () => {
    pollMock.mockResolvedValue({ status: "pending" });
    // expiresIn 0 → deadline already passed at first poll check.
    startMock.mockResolvedValue({ ...REQUEST, expiresIn: 0 });
    await expect(signInWithBrowser(opts())).rejects.toThrow(/timed out/i);
  });

  it("stops promptly when the caller aborts", async () => {
    const controller = new AbortController();
    pollMock.mockImplementation(async () => { controller.abort(); return { status: "pending" }; });
    await expect(signInWithBrowser(opts({ signal: controller.signal }))).rejects.toThrow(AccountError);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("retries a failed acknowledgement but still reports success (key already stored)", async () => {
    pollMock.mockResolvedValue({ status: "approved", key: "agav_sk_delivered" });
    ackMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const identity = await signInWithBrowser(opts());
    expect(ackMock).toHaveBeenCalledTimes(2);
    expect(identity.accountId).toBe("acct_1");
  });
});
