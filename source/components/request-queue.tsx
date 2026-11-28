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

interface Selection { id?: number; ids: number[] }

function sameIds(ids: number[], requests: Props["requests"]) {
  return ids.length === requests.length && ids.every((id, i) => id === requests[i]!.id);
}

/** Index of the selected request, or of its nearest surviving neighbour (next first) once it is removed. */
function selectedIndex(requests: Props["requests"], selection: Selection) {
  const found = requests.findIndex(request => request.id === selection.id);
  if (found >= 0 || !requests.length) return Math.max(0, found);
  const at = selection.id === undefined ? -1 : selection.ids.indexOf(selection.id);
  if (at < 0) return 0;
  for (const id of [...selection.ids.slice(at + 1), ...selection.ids.slice(0, at).reverse()]) {
    const neighbour = requests.findIndex(request => request.id === id);
    if (neighbour >= 0) return neighbour;
  }
  return Math.min(at, requests.length - 1);
}

/** A bounded footer queue with stable-ID cancellation, independent of the editor. */
export default function RequestQueue({ requests, onCancel, active, onClose, onActivate, columns }: Props) {
  const [selection, setSelection] = useState<Selection>(() => ({ id: requests[0]?.id, ids: requests.map(request => request.id) }));
  const index = selectedIndex(requests, selection);
  const selectedId = requests[index]?.id;
  useEffect(() => {
    setSelection(prev => prev.id === selectedId && sameIds(prev.ids, requests)
      ? prev : { id: selectedId, ids: requests.map(request => request.id) });
    if (active && requests.length === 0) onClose();
  }, [selectedId, requests, active, onClose]);
  const select = (next: number) => {
    const request = requests[next];
    if (request) setSelection({ id: request.id, ids: requests.map(r => r.id) });
  };
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "q")) { onClose(); return; }
    if (key.upArrow) select(Math.max(0, index - 1));
    if (key.downArrow) select(Math.min(requests.length - 1, index + 1));
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
