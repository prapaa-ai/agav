import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(async () => { throw new Error("ENOENT"); }) };
});

const { loadGlobalConfig } = await import("../config/config.js");
const { defaultModelForProvider } = await import("../config/provider-defaults.js");

// Anthropic retired claude-sonnet-4-20250514 on 2026-06-15:
// https://platform.claude.com/docs/en/about-claude/model-deprecations
const RETIRED = ["claude-sonnet-4-20250514", "claude-opus-4-20250514"];

describe("the Anthropic default model", () => {
  it("is a model Anthropic still serves", () => {
    expect(RETIRED).not.toContain(defaultModelForProvider("anthropic"));
  });

  it("is what a fresh install with no config file starts with", async () => {
    const config = await loadGlobalConfig();
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe(defaultModelForProvider("anthropic"));
  });
});
