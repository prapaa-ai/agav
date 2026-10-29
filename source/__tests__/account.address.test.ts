import { describe, expect, it } from "vitest";
import { resolveAccountService, defaultAccountService, HOSTED_DEFAULT } from "../account/account-address.js";

describe("resolveAccountService", () => {
  it("prefers an explicit flag over everything", () => {
    expect(resolveAccountService({ flag: "https://staging.agav.dev", env: { AGAV_ACCOUNT_SERVICE: "https://env.agav.dev" } }))
      .toBe("https://staging.agav.dev");
  });

  it("falls back to the env var when no flag is given", () => {
    expect(resolveAccountService({ env: { AGAV_ACCOUNT_SERVICE: "https://env.agav.dev" } }))
      .toBe("https://env.agav.dev");
  });

  it("falls back to the built-in hosted default", () => {
    expect(resolveAccountService({ env: {} })).toBe(HOSTED_DEFAULT);
  });

  it("honours a build-time default override", () => {
    expect(defaultAccountService({ AGAV_DEFAULT_ACCOUNT_SERVICE: "https://build.agav.dev" }))
      .toBe("https://build.agav.dev");
  });
});
