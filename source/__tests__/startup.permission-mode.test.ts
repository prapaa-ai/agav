import { describe, expect, it } from "vitest";
import type { AgavConfig, PermissionMode } from "../config/config.js";
import { resolveResumePermissionMode } from "../config/startup.js";

const base: AgavConfig = {
  provider: "anthropic",
  model: "configured-claude",
  effort: "high",
  maxTokens: 1024,
  maxIterations: 10,
  errorRetries: 1,
  permissionMode: "ask",
};

const modes: PermissionMode[] = ["auto-accept", "ask", "deny-writes"];

describe("resume permission mode resolution", () => {
  it.each(modes)("keeps explicit -y authoritative over saved %s", (savedPermissionMode) => {
    const config = Object.freeze({ ...base, permissionMode: "auto-accept" as const });
    expect(resolveResumePermissionMode(config, {
      cliPermissionMode: "auto-accept",
      savedPermissionMode,
    })).toBe("auto-accept");
    expect(config.permissionMode).toBe("auto-accept");
  });

  it.each(modes)("keeps explicit --deny-writes authoritative over saved %s", (savedPermissionMode) => {
    const config = Object.freeze({ ...base, permissionMode: "deny-writes" as const });
    expect(resolveResumePermissionMode(config, {
      cliPermissionMode: "deny-writes",
      savedPermissionMode,
    })).toBe("deny-writes");
    expect(config.permissionMode).toBe("deny-writes");
  });

  it.each(modes)("restores saved %s without changing the launch default for /new", (savedPermissionMode) => {
    const config = Object.freeze({ ...base });
    expect(resolveResumePermissionMode(config, { savedPermissionMode })).toBe(savedPermissionMode);
    expect(config).toEqual(base);
  });

  it.each(modes)("uses launch default %s for legacy sessions without a saved mode", (permissionMode) => {
    const config = Object.freeze({ ...base, permissionMode });
    expect(resolveResumePermissionMode(config, {})).toBe(permissionMode);
    expect(config.permissionMode).toBe(permissionMode);
  });

  it.each(["auto-accept", "deny-writes"] as const)("uses explicit %s for legacy sessions", (cliPermissionMode) => {
    expect(resolveResumePermissionMode(base, { cliPermissionMode })).toBe(cliPermissionMode);
  });

  it.each(["ask", "deny-writes"] as const)("clamps CLI, saved, and legacy modes to org floor %s", (orgPermissionFloor) => {
    const config = Object.freeze({ ...base, permissionMode: "auto-accept" as const, orgPermissionFloor });
    expect(resolveResumePermissionMode(config, {
      cliPermissionMode: "auto-accept",
      savedPermissionMode: "deny-writes",
    })).toBe(orgPermissionFloor);
    expect(resolveResumePermissionMode(config, {
      savedPermissionMode: "auto-accept",
    })).toBe(orgPermissionFloor);
    expect(resolveResumePermissionMode(config, {})).toBe(orgPermissionFloor);
    expect(config.permissionMode).toBe("auto-accept");
  });

  it("preserves a saved mode stricter than the org floor without a CLI override", () => {
    expect(resolveResumePermissionMode({ ...base, orgPermissionFloor: "ask" }, {
      savedPermissionMode: "deny-writes",
    })).toBe("deny-writes");
  });
});
