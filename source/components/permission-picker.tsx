import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "../ink/index.js";
import { PERMISSION_MODES, type PermissionMode } from "../config/config.js";
import { clampPermissionMode } from "../config/org-config.js";
import { getTheme } from "../config/theme.js";
import { MODE_HELP } from "../commands/permission.js";

interface Props {
  current: PermissionMode;
  floor?: PermissionMode;
  onDone: (mode?: PermissionMode) => void;
}

/** A session-scoped choice: navigation previews only; Enter applies, Esc cancels. */
export function PermissionPicker({ current, floor, onDone }: Props) {
  const theme = getTheme();
  const effective = clampPermissionMode(current, floor);
  const [selected, setSelected] = useState(() => PERMISSION_MODES.indexOf(effective));
  const finished = useRef(false);
  const [notice, setNotice] = useState<string>();
  const finish = (mode?: PermissionMode) => {
    if (finished.current) return;
    finished.current = true;
    onDone(mode);
  };

  useInput((input, key) => {
    if (finished.current) return;
    if (key.escape || (key.ctrl && input === "c")) { finish(); return; }
    if (key.upArrow || key.downArrow) {
      setSelected((index) => (index + (key.upArrow ? -1 : 1) + PERMISSION_MODES.length) % PERMISSION_MODES.length);
      setNotice(undefined);
      return;
    }
    if (key.return) {
      const mode = PERMISSION_MODES[selected]!;
      if (clampPermissionMode(mode, floor) !== mode) {
        setNotice(`Blocked by organization policy. Choose ${floor} or a stricter mode.`);
        return;
      }
      finish(mode);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.bannerColor} paddingX={1}>
      <Text bold color={theme.bannerColor}>Session permissions</Text>
      <Text>Current mode: {effective}</Text>
      {floor && <Text dimColor>Organization minimum: {floor}</Text>}
      <Box flexDirection="column" marginTop={1}>
        {PERMISSION_MODES.map((mode, index) => {
          const blocked = clampPermissionMode(mode, floor) !== mode;
          const active = index === selected;
          return (
            <Box key={mode} flexDirection="column">
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
        <Text dimColor>↑/↓ Navigate · Enter Apply · Esc Cancel</Text>
      </Box>
    </Box>
  );
}
