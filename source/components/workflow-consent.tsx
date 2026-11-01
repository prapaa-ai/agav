import React from "react";
import { Box, Text, useInput, useStdout } from "../ink/index.js";
import type { ConsentRequest } from "../workflows/consent-prompt.js";

/** Same confirmation footer as the jobs TUI; Enter also approves. */
export const WORKFLOW_CONSENT_CONTROLS = "y: Approve · n/ESC: Deny";
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
  const { stdout } = useStdout();
  const names = request.envNames;
  const [cursor, setCursor] = React.useState(0);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set());
  const decided = React.useRef(false);
  const decide = (value: string[] | undefined): void => {
    if (decided.current) return;
    decided.current = true;
    onDecide(value);
  };
  useInput((char, key) => {
    if (key.escape || (key.ctrl && char === "c") || char === "n" || char === "N") { decide(undefined); return; }
    if (key.return || char === "y" || char === "Y") { decide(names.filter(name => selected.has(name))); return; }
    if (!names.length) return;
    if (key.upArrow) setCursor(c => (c - 1 + names.length) % names.length);
    else if (key.downArrow) setCursor(c => (c + 1) % names.length);
    else if (char === " ") {
      const name = names[cursor]!;
      setSelected(prev => { const next = new Set(prev); if (next.has(name)) next.delete(name); else next.add(name); return next; });
    } else if (char === "a") setSelected(new Set(names));
    else if (char === "x") setSelected(new Set());
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
    <Text dimColor>Environment variables for the runner ({selected.size}/{names.length} selected; names only, values are never stored):</Text>
    {start > 0 && <Text dimColor>  ↑ {start} more</Text>}
    {visible.map((name, i) => {
      const index = start + i;
      return <Text key={name} color={index === cursor ? "cyan" : undefined}>{index === cursor ? "❯" : " "} [{selected.has(name) ? "x" : " "}] {name}</Text>;
    })}
    {start + rows < names.length && <Text dimColor>  ↓ {names.length - start - rows} more</Text>}
    <Text dimColor>{CHECKLIST_CONTROLS}</Text>
    <Text color="yellow">{WORKFLOW_CONSENT_CONTROLS}</Text>
  </Box>;
}
