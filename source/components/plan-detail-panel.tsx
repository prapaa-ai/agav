import React from "react";
import { Box, Text } from "ink";
import type { Plan } from "../agent/planner.js";
import { terminalRelativePaths } from "../utils/display-path.js";

interface Props {
  plan: Plan;
  closeKey: string;
}

const BAR_LENGTH = 20;

const STEP_ICON: Record<Plan["steps"][number]["status"], string> = {
  done: "✓",
  in_progress: "◉",
  failed: "✗",
  pending: "○",
};

const STEP_COLOR: Record<Plan["steps"][number]["status"], string | undefined> = {
  done: "green",
  in_progress: "cyan",
  failed: "red",
  pending: undefined,
};

/**
 * The full plan — descriptions and verify commands included — so the steps can
 * be read without leaving the session for `.agav/plans`. Purely a view over the
 * plan already in state: it never touches disk and never interacts with the
 * agent loop, so opening it mid-run cannot disturb the run.
 */
export default function PlanDetailPanel({ plan, closeKey }: Props) {
  const done = plan.steps.filter((step) => step.status === "done").length;
  const total = plan.steps.length;
  const filled = total === 0 ? 0 : Math.round((done / total) * BAR_LENGTH);
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginBottom={1}>
      <Text bold dimColor>Plan Details <Text>({closeKey} to close)</Text></Text>
      <Text bold>{terminalRelativePaths(plan.goal)}</Text>
      <Text dimColor>
        {`[${"█".repeat(filled)}${"░".repeat(BAR_LENGTH - filled)}] ${pct}% (${done}/${total})`}
      </Text>

      {plan.steps.map((step) => {
        // The cursor only means anything while there is outstanding work;
        // `currentStep` is -1 once every step has been closed out.
        const isCurrent = plan.currentStep >= 0 && plan.steps[plan.currentStep]?.id === step.id;
        return (
          <Box key={step.id} flexDirection="column" marginTop={1}>
            <Text color={STEP_COLOR[step.status] as any} bold={isCurrent}>
              {`${STEP_ICON[step.status]} Step ${step.id}: ${terminalRelativePaths(step.title)}`}
              {isCurrent ? "  ← current" : ""}
            </Text>
            {step.description && (
              <Text dimColor>{`    ${terminalRelativePaths(step.description)}`}</Text>
            )}
            {step.verifyCommand && (
              <Text dimColor>{`    verify: ${terminalRelativePaths(step.verifyCommand)}`}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
