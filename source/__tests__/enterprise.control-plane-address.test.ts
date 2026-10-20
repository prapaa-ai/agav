import { describe, expect, it } from "vitest";
import {
  resolveControlPlane,
  defaultControlPlane,
  HOSTED_DEFAULT,
} from "../enterprise/control-plane-address.js";

describe("control-plane-address", () => {
  it("uses the hosted default when nothing else is set", () => {
    expect(resolveControlPlane({ env: {} })).toBe(HOSTED_DEFAULT);
  });

  it("lets AGAV_DEFAULT_CONTROL_PLANE override the built-in default", () => {
    expect(defaultControlPlane({ AGAV_DEFAULT_CONTROL_PLANE: "https://staging.agav.dev" }))
      .toBe("https://staging.agav.dev");
    expect(resolveControlPlane({ env: { AGAV_DEFAULT_CONTROL_PLANE: "https://staging.agav.dev" } }))
      .toBe("https://staging.agav.dev");
  });

  it("prefers the org-config address over the default (self-hosted via MDM)", () => {
    expect(resolveControlPlane({ orgConfig: "https://auth.corp", env: {} })).toBe("https://auth.corp");
  });

  it("prefers AGAV_CONTROL_PLANE env over org-config and default", () => {
    expect(resolveControlPlane({
      orgConfig: "https://auth.corp",
      env: { AGAV_CONTROL_PLANE: "https://env.corp" },
    })).toBe("https://env.corp");
  });

  it("prefers the explicit flag over everything", () => {
    expect(resolveControlPlane({
      flag: "https://flag.corp",
      orgConfig: "https://auth.corp",
      env: { AGAV_CONTROL_PLANE: "https://env.corp", AGAV_DEFAULT_CONTROL_PLANE: "https://staging" },
    })).toBe("https://flag.corp");
  });
});
