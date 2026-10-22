import type { AgavConfig } from "./config.js";

/**
 * Provider identifiers and their default models.
 *
 * Kept in a tiny standalone module (no runtime deps on config/startup) so both
 * startup selection and the org-policy layer can resolve a provider's default
 * model without creating an import cycle.
 */

export type ProviderName = AgavConfig["provider"];

export const PROVIDERS: readonly ProviderName[] = [
  "anthropic",
  "openai",
  "openrouter",
  "nvidia",
  "deepseek",
  "gemini",
  "vertex-ai",
  "ollama",
];

const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-5.4-mini",
  openrouter: "openrouter/auto",
  nvidia: "nvidia/nemotron-3.5-lightning-30b-a3b",
  deepseek: "deepseek-v4-pro",
  gemini: "gemini-3.5-flash-lite",
  "vertex-ai": "vertex/gemini-3.5-flash",
  ollama: "",
};

export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && PROVIDERS.includes(value as ProviderName);
}

export function defaultModelForProvider(provider: ProviderName): string {
  return DEFAULT_MODELS[provider];
}
