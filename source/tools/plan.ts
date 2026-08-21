import type { ToolDefinition, ToolResult } from "./types.js";
import { updatePlanStep } from "../agent/planner.js";

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

    const result = await updatePlanStep(stepNum, status);
    if ("error" in result) {
      return { output: result.error, isError: true };
    }

    const { doneCount, totalCount, allDone } = result;

    return {
      output: allDone
        ? `Step ${stepNum} marked ${status}. All ${totalCount} steps complete! Plan finished.`
        : `Step ${stepNum} marked ${status}. Progress: ${doneCount}/${totalCount} steps done.`,
      isError: false,
    };
  },
};
