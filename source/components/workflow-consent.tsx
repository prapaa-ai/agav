import React from "react";
import { Box, Text, useInput, useStdout } from "../ink/index.js";
import type { ConsentRequest } from "../workflows/consent-prompt.js";
import ConfirmControl, { useConfirmSurface, WorkflowConfirmControls, workflowConfirmAction } from "./confirm-control.js";
import { pointerSelect } from "./hover-text.js";
import { wheelSelect } from "./wheel-select.js";
const CHECKLIST_CONTROLS = "↑↓: Move · Space: Toggle · a: Select all · x: Deselect all · Enter: Approve";

/**
 * Per-invocation consent for a background workflow run: capabilities plus an env-var checklist.
 * Only the selected NAMES are handed to `onDecide`; values are never read here.
 */
export default function WorkflowConsent({ request, onDecide }: {
  request: ConsentRequest;
  /** Selected env names on approve, undefined on deny. */
  onDecide: (envNames: string[] | undefined) => void;
}) {
  const surface = useConfirmSurface(request);
  return <ConsentPrompt key={surface.revision} request={request} onDecide={onDecide} surface={surface} />;
}

function ConsentPrompt({ request, onDecide, surface }: Parameters<typeof WorkflowConsent>[0] & {
  surface: ReturnType<typeof useConfirmSurface>;
}) {
  const { stdout } = useStdout();
  const names = request.envNames;
  const [checklist, setChecklist] = React.useState({ cursor: 0, selected: new Set<string>() });
  const { cursor, selected } = checklist;
  // Input may contain several actions before React repaints (e.g. Space then Enter).
  const live = React.useRef(checklist);
  const decided = React.useRef(false);
  const update = (next: typeof checklist) => {
    if (decided.current) return;
    live.current = next;
    setChecklist(next);
  };
  const move = (delta: number) => {
    if (!names.length) return;
    update({ ...live.current, cursor: (live.current.cursor + delta + names.length) % names.length });
  };
  const toggle = (index: number) => {
    const name = names[index];
    if (name === undefined) return;
    const next = new Set(live.current.selected);
    if (!next.delete(name)) next.add(name);
    update({ cursor: index, selected: next });
  };
  const decide = (value: string[] | undefined): void => {
    if (decided.current) return;
    decided.current = true;
    onDecide(value);
  };
  const approve = () => decide(names.filter(name => live.current.selected.has(name)));
  const deny = () => decide(undefined);
  useInput((char, key) => {
    if (decided.current || key.eventType === "release") return;
    const action = workflowConfirmAction(char, key, true);
    if (action === "approve") { approve(); return; }
    if (action === "deny") { deny(); return; }
    if (!names.length) return;
    if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (!key.ctrl && !key.meta && !key.super && !key.hyper) {
      if (char === " ") toggle(live.current.cursor);
      else if (char === "a") update({ ...live.current, selected: new Set(names) });
      else if (char === "x") update({ ...live.current, selected: new Set() });
    }
  });
  const { tools, jobCommands } = request.capabilities;
  // Window the checklist so the controls line stays on screen.
  const rows = Math.max(3, Math.floor((stdout.rows || 24) / 2) - 2);
  const start = Math.min(Math.max(0, cursor - Math.floor(rows / 2)), Math.max(0, names.length - rows));
  const visible = names.slice(start, start + rows);
  return <Box flexDirection="column" paddingX={1}>
    <Text bold color="yellow">Run workflow "{request.workflowName}" in the background?</Text>
    <Text dimColor>Directory: {request.cwd}</Text>
    <Text dimColor>Permission mode: {request.permissionMode}</Text>
    <Text>Tools: {tools.length ? tools.join(", ") : "(none)"}</Text>
    <Text>Job commands:{jobCommands.length ? "" : " (none)"}</Text>
    {jobCommands.map(command => <Text key={command}>  $ {command}</Text>)}
    {names.length > 0 ? <>
      <Text dimColor>Environment variables for the runner ({selected.size}/{names.length} selected; names only, values are never stored):</Text>
      <Box flexDirection="column" onWheel={wheelSelect(move)}>
        {start > 0 && <Text dimColor>  ↑ {start} more</Text>}
        {visible.map((name, i) => {
          const index = start + i;
          const active = index === cursor;
          return <ConfirmControl key={name} surface={surface} padded={false} bold={false}
            color={active ? "cyan" : undefined} active={active}
            label={`${active ? "❯" : " "} [${selected.has(name) ? "x" : " "}] ${name}`}
            onPoint={pointerSelect(() => { if (live.current.cursor !== index) update({ ...live.current, cursor: index }); })}
            onActivate={() => toggle(index)} />;
        })}
        {start + rows < names.length && <Text dimColor>  ↓ {names.length - start - rows} more</Text>}
      </Box>
      <Text dimColor>{CHECKLIST_CONTROLS}</Text>
    </> : <Text dimColor>Enter: Approve</Text>}
    <WorkflowConfirmControls surface={surface} approve={approve} deny={deny} />
  </Box>;
}
