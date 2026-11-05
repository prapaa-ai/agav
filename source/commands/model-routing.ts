import type { SlashCommand, CommandResult, CommandContext } from "./types.js"

/** Default fast-model choices keyed by provider name. */
const FAST_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-5-5",
  openai: "gpt-6-luna",
  openrouter: "nvidia/nemotron-3.5-lightning:free",
  nvidia: "nvidia/nemotron-3.5-bolt-e4b",
  deepseek: "deepseek-flash",
  gemini: "gemini-3.8-flash",
  "vertex-ai": "vertex/gemini-3.8-flash",
  ollama: "gemma4:e4b",
}

/** Default deep-model choices keyed by provider name. */
const DEEP_MODELS: Record<string, string> = {
  anthropic: "claude-opus-5-5",
  openai: "gpt-6.1-sol",
  openrouter: "anthropic/claude-fable-5.1",
  nvidia: "nvidia/nemotron-3-ultra-550b-a55b",
  deepseek: "deepseek-v4-pro",
  gemini: "gemini-3.1-pro-preview",
  "vertex-ai": "vertex/claude-opus-5-5",
  ollama: "qwen3.8:27b",
}

/** Switch to the configured fast model for the active provider. */
export const fastCommand: SlashCommand = {
  name: "fast",
  description: "Switch to a fast, lightweight model",
  autoSubmit: true,
  usage: "Usage: /fast\n\nSwitches to the fastest model for the current provider.\nUse for simple questions, quick lookups, or when speed matters more than depth.",
  async execute(_args: string, context: CommandContext): Promise<CommandResult> {
    const model = FAST_MODELS[context.config.provider] ?? FAST_MODELS.openai!
    const error = context.setModel(model)
    if (error) return { type: "message", text: error }
    return { type: "message", text: `Switched to fast model: ${model}` }
  },
}

/** Switch to the configured deep model for the active provider. */
export const deepCommand: SlashCommand = {
  name: "deep",
  description: "Switch to a powerful model for complex tasks",
  autoSubmit: true,
  usage: "Usage: /deep\n\nSwitches to the most capable model for the current provider.\nUse for complex reasoning, large refactors, or architecture decisions.",
  async execute(_args: string, context: CommandContext): Promise<CommandResult> {
    const model = DEEP_MODELS[context.config.provider] ?? DEEP_MODELS.openai!
    const error = context.setModel(model)
    if (error) return { type: "message", text: error }
    return { type: "message", text: `Switched to deep model: ${model}` }
  },
}
