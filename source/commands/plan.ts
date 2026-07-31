import type { SlashCommand, CommandResult } from "./types.js"
import { loadPlan, clearPlan } from "../agent/planner.js"

/** Show the active plan, its progress, or clear it. */
export const planCommand: SlashCommand = {
  name: "plan",
  description: "Show or manage the active plan",
  usage: "Usage: /plan [action]\n\n  /plan          Show the current plan and step status\n  /plan clear    Delete the active plan\n\nPlans are auto-created for complex multi-step tasks.\nUse 'no plan' in your prompt to skip auto-planning.",
  async execute(args: string): Promise<CommandResult> {
    const sub = args.trim().toLowerCase()

    if (sub === "clear") {
      await clearPlan()
      return { type: "message", text: "Plan cleared." }
    }

    const plan = await loadPlan()

    if (!plan) {
      return {
        type: "message",
        text: "No active plan. Send a complex task to auto-create one, or prefix with 'plan:' to force.",
      }
    }

    const lines: string[] = []
    lines.push(`Plan: ${plan.goal}`)
    lines.push("")

    const doneCount = plan.steps.filter((s) => s.status === "done").length
    const totalCount = plan.steps.length
    const pct = Math.round((doneCount / totalCount) * 100)

    const barLen = 20
    const filled = Math.round((doneCount / totalCount) * barLen)
    const bar = "█".repeat(filled) + "░".repeat(barLen - filled)
    lines.push(`Progress: [${bar}] ${pct}% (${doneCount}/${totalCount})`)
    lines.push("")

    for (const step of plan.steps) {
      const icon = step.status === "done" ? "✅"
        : step.status === "in_progress" ? "🔄"
        : step.status === "failed" ? "❌"
        : "⬜"
      lines.push(`  ${icon} Step ${step.id}: ${step.title}`)
      lines.push(`     ${step.description}`)
      if (step.verifyCommand) {
        lines.push(`     Verify: ${step.verifyCommand}`)
      }
    }

    lines.push("")
    lines.push("Use /plan clear to remove this plan.")

    return { type: "message", text: lines.join("\n") }
  },
}
