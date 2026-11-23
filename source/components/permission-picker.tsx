import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "../ink/index.js";
import { PERMISSION_MODES, type PermissionMode } from "../config/config.js";
import { clampPermissionMode } from "../config/org-config.js";
import { getTheme } from "../config/theme.js";
import { MODE_HELP } from "../commands/permission.js";
import { wheelSelect } from "./wheel-select.js";

interface Props {
  current: PermissionMode;
  floor?: PermissionMode;
  onDone: (mode?: PermissionMode) => void;
}

/** A session-scoped choice: navigation and row clicks preview only. */
export function PermissionPicker({ current, floor, onDone }: Props) {
  const theme = getTheme();
  const effective = clampPermissionMode(current, floor);
  const [selected, setSelected] = useState(() => PERMISSION_MODES.indexOf(effective));
  const selectedRef = useRef(selected);
  const finished = useRef(false);
  const [notice, setNotice] = useState<string>();
  const finish = (mode?: PermissionMode) => {
    if (finished.current) return;
    finished.current = true;
    onDone(mode);
  };

  const preview = (index: number) => {
    if (finished.current) return;
    // A terminal read can carry a preview and an Apply before React repaints.
    selectedRef.current = index;
    setSelected(index);
    setNotice(undefined);
  };
  const move = (delta: number) => preview((selectedRef.current + delta + PERMISSION_MODES.length) % PERMISSION_MODES.length);
  const apply = () => {
    if (finished.current) return;
    const mode = PERMISSION_MODES[selectedRef.current]!;
    if (clampPermissionMode(mode, floor) !== mode) {
      setNotice(`Blocked by organization policy. Choose ${floor} or a stricter mode.`);
      return;
    }
    finish(mode);
  };
  const cancel = () => finish();

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) cancel();
    else if (key.upArrow || key.downArrow) move(key.upArrow ? -1 : 1);
    else if (key.return) apply();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.bannerColor} paddingX={1}>
      <Text bold color={theme.bannerColor}>Session permissions</Text>
      <Text>Current mode: {effective}</Text>
      {floor && <Text dimColor>Organization minimum: {floor}</Text>}
      <Box flexDirection="column" marginTop={1} onWheel={wheelSelect(move)}>
        {PERMISSION_MODES.map((mode, index) => {
          const blocked = clampPermissionMode(mode, floor) !== mode;
          const active = index === selected;
          return (
            <Box key={mode} flexDirection="column" onClick={() => preview(index)}>
              <Text bold={active} dimColor={blocked} color={active ? theme.promptColor : undefined}>
                {active ? "❯ " : "  "}{mode}{mode === effective ? " (current)" : ""}{blocked ? " [blocked by organization]" : ""}
              </Text>
              <Text dimColor>  {MODE_HELP[mode]}</Text>
            </Box>
          );
        })}
      </Box>
      {PERMISSION_MODES[selected] === "auto-accept" && <Text color="yellow">Warning: sensitive tool actions will run without confirmation.</Text>}
      {notice && <Text color="yellow">{notice}</Text>}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Applies to this session and is saved for resume.</Text>
        <Box flexWrap="wrap">
          <Text dimColor>↑/↓ Navigate · </Text>
          <Text underline onClick={apply}>Enter Apply</Text>
          <Text dimColor> · </Text>
          <Text underline onClick={cancel}>Esc Cancel</Text>
        </Box>
      </Box>
    </Box>
  );
}
