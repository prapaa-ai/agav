import type { SlashCommand, CommandResult, CommandContext } from "./types.js"
import { FAST_MODELS, DEEP_MODELS } from "../agent/model-tiers.js"

/** Switch to the configured fast model for the active provider. */
export const fastCommand: SlashCommand = {
  name: "fast",
  description: "Switch to a fast, lightweight model",
  usage: "Usage: /fast\n\nSwitches to the fastest model for the current provider.\nUse for simple questions, quick lookups, or when speed matters more than depth.",
  async execute(_args: string, context: CommandContext): Promise<CommandResult> {
    const model = FAST_MODELS[context.config.provider] ?? FAST_MODELS.openai!
    context.setModel(model)
    return { type: "message", text: `Switched to fast model: ${model}` }
  },
}

/** Switch to the configured deep model for the active provider. */
export const deepCommand: SlashCommand = {
  name: "deep",
  description: "Switch to a powerful model for complex tasks",
  usage: "Usage: /deep\n\nSwitches to the most capable model for the current provider.\nUse for complex reasoning, large refactors, or architecture decisions.",
  async execute(_args: string, context: CommandContext): Promise<CommandResult> {
    const model = DEEP_MODELS[context.config.provider] ?? DEEP_MODELS.openai!
    context.setModel(model)
    return { type: "message", text: `Switched to deep model: ${model}` }
  },
}
