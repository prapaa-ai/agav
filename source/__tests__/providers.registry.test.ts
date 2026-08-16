import { describe, expect, it } from "vitest";

import { createProvider } from "../providers/registry.js";
import { isKnownProvider, PROVIDERS, type AgavConfig } from "../config/config.js";

const base: AgavConfig = {
  provider: "groq",
  model: "llama-3.3-70b-versatile",
  effort: "medium",
} as AgavConfig;

describe("providers/registry", () => {
  it("builds a Groq provider from a groq config", () => {
    const provider = createProvider({ ...base, groqApiKey: "test-key" });
    expect(provider.name).toBe("groq");
  });

  it("names the missing key and where to set it", () => {
    expect(() => createProvider({ ...base, groqApiKey: undefined })).toThrow(/GROQ_API_KEY/);
  });

  // The CLI flag, session resume, and /history all gate on isKnownProvider, so
  // a provider the registry can build must pass that guard — otherwise the
  // feature is unreachable from the command line, as groq briefly was.
  it("accepts every provider the registry knows how to build", () => {
    for (const name of PROVIDERS) {
      expect(isKnownProvider(name)).toBe(true);
      expect(() => createProvider({ ...base, provider: name } as AgavConfig)).not.toThrow(/Unknown provider/);
    }
  });

  it("rejects anything outside the list", () => {
    expect(isKnownProvider("grok")).toBe(false);
    expect(isKnownProvider(undefined)).toBe(false);
  });
});
