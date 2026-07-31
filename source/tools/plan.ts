import type { ToolDefinition, ToolResult } from "./types.js";
import { loadPlan, savePlan } from "../agent/planner.js";

export const updatePlanTool: ToolDefinition = {
  schema: {
    name: "update_plan",
    description:
      "Update the status of a step in the active plan. Mark steps as done, failed, or in_progress as you work through them.",
    inputSchema: {
      type: "object",
      properties: {
        step: {
          type: "number",
          description: "Step number to update (1-based)",
        },
        status: {
          type: "string",
          enum: ["in_progress", "done", "failed"],
          description: "New status for the step",
        },
      },
      required: ["step", "status"],
    },
  },

  async execute(input): Promise<ToolResult> {
    const stepNum = Number(input.step);
    const status = String(input.status) as "in_progress" | "done" | "failed";

    const plan = await loadPlan();
    if (!plan) {
      return { output: "No active plan found.", isError: true };
    }

    const step = plan.steps.find((s) => s.id === stepNum);
    if (!step) {
      return { output: `Step ${stepNum} not found. Plan has ${plan.steps.length} steps.`, isError: true };
    }

    step.status = status;

    // Advance currentStep
    const doneCount = plan.steps.filter((s) => s.status === "done").length;
    const totalCount = plan.steps.length;
    const allDone = doneCount === totalCount;
    plan.currentStep = allDone
      ? -1
      : plan.steps.findIndex((s) => s.status === "pending" || s.status === "in_progress");

    await savePlan(plan);

    return {
      output: allDone
        ? `Step ${stepNum} marked ${status}. All ${totalCount} steps complete! Plan finished.`
        : `Step ${stepNum} marked ${status}. Progress: ${doneCount}/${totalCount} steps done.`,
      isError: false,
    };
  },
};
