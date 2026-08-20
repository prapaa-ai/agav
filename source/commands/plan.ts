import type { SlashCommand, CommandResult, CommandContext } from "./types.js"
import {
  loadPlan,
  clearPlan,
  listPlans,
  updatePlanStep,
  planFilePath,
  getPlanScope,
  type PlanStep,
} from "../agent/planner.js"

const STATUSES: PlanStep["status"][] = ["pending", "in_progress", "done", "failed"]

/** Render "3d ago" style ages for the plan list. */
function relativeAge(when: Date): string {
  const minutes = Math.max(0, Math.round((Date.now() - when.getTime()) / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Show the active plan, list saved ones, update a step, or clear it. */
export const planCommand: SlashCommand = {
  name: "plan",
  description: "Show or manage the active plan",
  usage: "Usage: /plan [action]\n\n  /plan                    Show this session's plan and step status\n  /plan list               List every plan saved for this project\n  /plan <n> <status>       Set step <n> to pending, in_progress, done or failed\n  /plan clear              Delete this session's plan\n\nPlans belong to the session that created them and survive restarts.\nResume that session with 'agav --resume <id>' to pick a plan back up.\nUse 'no plan' in your prompt to skip auto-planning.",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const sub = args.trim().toLowerCase()

    if (sub === "clear") {
      await clearPlan()
      // The panel renders from hook state, not from disk — tell it to re-read.
      context.refreshPlan()
      return { type: "message", text: "Plan cleared." }
    }

    // Plans outlive their session, so there has to be a way to find one again.
    if (sub === "list") {
      const stored = await listPlans()
      if (stored.length === 0) {
        return { type: "message", text: "No saved plans for this project." }
      }

      const current = getPlanScope()
      const lines: string[] = [`Saved plans (${stored.length}):`, ""]
      for (const { scope, plan, updatedAt } of stored) {
        const done = plan.steps.filter((s) => s.status === "done").length
        const marker = scope === current ? "▸" : " "
        const label = scope === "draft" ? "unsaved session" : scope.slice(0, 8)
        lines.push(`${marker} ${label}  ${done}/${plan.steps.length}  ${relativeAge(updatedAt)}  ${plan.goal}`)
      }
      lines.push("")
      lines.push("▸ marks this session. Resume another with: agav --resume <id>")
      return { type: "message", text: lines.join("\n") }
    }

    // /plan <step> <status> — the only way to correct a plan by hand; without it
    // step status could only ever be changed by the model.
    const setMatch = sub.match(/^(\d+)\s+([a-z_]+)$/)
    if (setMatch) {
      const stepNum = Number(setMatch[1])
      const status = setMatch[2] as PlanStep["status"]
      if (!STATUSES.includes(status)) {
        return { type: "message", text: `Unknown status '${status}'. Use one of: ${STATUSES.join(", ")}.` }
      }
      const result = await updatePlanStep(stepNum, status)
      if ("error" in result) {
        return { type: "message", text: result.error }
      }
      context.refreshPlan()
      return {
        type: "message",
        text: `Step ${stepNum} marked ${status}. Progress: ${result.doneCount}/${result.totalCount} steps done.`,
      }
    }

    if (sub) {
      return { type: "message", text: planCommand.usage ?? "" }
    }

    const plan = await loadPlan()

    if (!plan) {
      const others = (await listPlans()).filter((p) => p.scope !== getPlanScope())
      const hint = others.length > 0
        ? `\n\n${others.length} plan(s) saved for this project — see /plan list.`
        : ""
      return {
        type: "message",
        text: "No active plan for this session. Send a complex task to auto-create one, or prefix with 'plan:' to force." + hint,
      }
    }

    const lines: string[] = []
    lines.push(`Plan: ${plan.goal}`)
    lines.push("")

    const doneCount = plan.steps.filter((s) => s.status === "done").length
    const totalCount = plan.steps.length
    const pct = totalCount === 0 ? 0 : Math.round((doneCount / totalCount) * 100)

    const barLen = 20
    const filled = totalCount === 0 ? 0 : Math.round((doneCount / totalCount) * barLen)
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
    lines.push(`Saved at ${planFilePath()}`)
    lines.push("Use /plan <n> <status> to update a step, /plan list to see other plans, or /plan clear to remove this one.")

    return { type: "message", text: lines.join("\n") }
  },
}
