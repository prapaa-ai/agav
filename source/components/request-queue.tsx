import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "../ink/index.js";
import { wrapToWidth } from "../utils/wrap-text.js";

interface Props {
  requests: { id: number; text: string; attachmentCount: number }[];
  onCancel: (id: number) => void;
  active: boolean;
  onClose: () => void;
  onActivate: () => void;
  columns: number;
}

/** A bounded footer queue with stable-ID cancellation, independent of the editor. */
export default function RequestQueue({ requests, onCancel, active, onClose, onActivate, columns }: Props) {
  const [selected, setSelected] = useState(0);
  const index = Math.min(selected, Math.max(0, requests.length - 1));
  useEffect(() => {
    setSelected(index);
    if (active && requests.length === 0) onClose();
  }, [index, requests.length, active, onClose]);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "q")) { onClose(); return; }
    if (key.upArrow) setSelected(Math.max(0, index - 1));
    if (key.downArrow) setSelected(Math.min(requests.length - 1, index + 1));
    if (key.delete || key.backspace) {
      const request = requests[index];
      if (request) onCancel(request.id);
    }
  }, { isActive: active });
  if (!requests.length) return null;
  const start = active ? Math.max(0, index - 3) : 0;
  const visible = requests.slice(start, start + (active ? 4 : 2));
  const summary = (text: string, width: number) => {
    const lines = wrapToWidth(text.slice(0, Math.max(16, width * 4)).replace(/[\x00-\x1f\x7f]/g, " "), Math.max(1, width));
    return lines[0] + (lines.length > 1 || text.length > Math.max(16, width * 4) ? "…" : "");
  };
  return <Box flexDirection="column">
    <Text color="cyan" onClick={onActivate}>Queued {requests.length} · {active ? "↑↓ select · Delete cancel · Esc back" : "Ctrl+Q manage · click × to cancel"}</Text>
    {visible.map((request, row) => <Box key={request.id} flexDirection="row">
      <Text color={active && start + row === index ? "cyan" : undefined}>{active && start + row === index ? "› " : "  "}{start + row + 1}. {summary(request.text || "Attached content", columns - 20)}{request.attachmentCount ? ` [${request.attachmentCount}]` : ""} </Text>
      <Text color="red" onClick={() => onCancel(request.id)}>×</Text>
    </Box>)}
    {!active && requests.length > visible.length && <Text dimColor>  +{requests.length - visible.length} more</Text>}
    {active && <Text dimColor>{start + 1}–{Math.min(start + 4, requests.length)} of {requests.length}</Text>}
    {active && requests[index] && <Text dimColor>{wrapToWidth(
      requests[index]!.text.slice(0, Math.max(16, columns * 6)).replace(/[\x00-\x1f\x7f]/g, " "),
      Math.max(1, columns - 2),
    ).slice(0, 2).join("\n")}</Text>}
  </Box>;
}
