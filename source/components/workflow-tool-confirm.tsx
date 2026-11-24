import React from "react";
import { Box, Text, ScrollBox, useInput, useStdout } from "../ink/index.js";
import type { ScrollBoxControls } from "../ink/index.js";
import { getSandboxName } from "../utils/sandbox.js";
import { detailViewport } from "./background-confirmation.js";
import { useConfirmSurface, WorkflowConfirmControls, workflowConfirmAction } from "./confirm-control.js";

type Props = { toolName: string; input: Record<string, unknown>; onConfirm: (approved: boolean) => void };

/** Single-invocation consent; full resolved inputs, including write contents, are inspectable. */
export default function WorkflowToolConfirm(props: Props) {
  const surface = useConfirmSurface(props.input, props.toolName);
  return <ToolPrompt key={surface.revision} {...props} surface={surface} />;
}

function ToolPrompt({ toolName, input, onConfirm, surface }: Props & { surface: ReturnType<typeof useConfirmSurface> }) {
  const { stdout } = useStdout();
  const scroll = React.useRef<ScrollBoxControls | null>(null);
  const [offset, setOffset] = React.useState(Number.POSITIVE_INFINITY);
  const text = JSON.stringify(input, null, 2);
  const view = detailViewport(text.split("\n"), Math.max(1, (stdout.columns || 80) - 4), Math.max(3, Math.floor((stdout.rows || 24) / 2)));
  const decided = React.useRef(false);
  const decide = (approved: boolean) => {
    if (decided.current) return;
    decided.current = true;
    onConfirm(approved);
  };
  const approve = () => decide(true);
  const deny = () => decide(false);
  useInput((char, key) => {
    if (decided.current || key.eventType === "release") return;
    if (key.upArrow || key.downArrow) { scroll.current?.scrollBy(key.upArrow ? 1 : -1); return; }
    const action = workflowConfirmAction(char, key);
    if (action === "approve") approve();
    else if (action === "deny") deny();
  });
  return <Box flexDirection="column" paddingX={1}>
    <Text bold color="yellow">Allow workflow tool {toolName}?</Text>
    <Text dimColor>Directory: {process.cwd()}</Text>
    <Text color="yellow">{toolName === "run_command" ? `Shell backend: ${String(input.sandbox ?? getSandboxName())} (approval does not change isolation)` : "Ordinary filesystem access, including absolute paths; not OS-sandboxed."}</Text>
    <ScrollBox height={view.rows} controls={scroll} scrollOffset={offset} onScrollChange={setOffset}>
      <Text>{text}</Text>
    </ScrollBox>
    <Text dimColor>Single invocation only. Workflow approvals grant no tool permissions.</Text>
    {view.overflows && <Text dimColor>↑↓: inspect full inputs</Text>}
    <WorkflowConfirmControls surface={surface} approve={approve} deny={deny} />
    <Text dimColor>Ctrl+C / Esc: cancel workflow</Text>
  </Box>;
}
