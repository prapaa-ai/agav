import React from "react";
import { Box, Text } from "../ink/index.js";
import { wrapToWidth } from "../utils/wrap-text.js";

const MAX_PREVIEW_LINES = 2000;

export interface PreviewContent {
  /** Header line shown above the body, e.g. "Pasted #1 · 2k chars, 40 lines" or a file path. */
  title: string;
  /** Plain text to preview — already read/decoded by the caller. */
  text: string;
}

interface Props {
  content: PreviewContent;
  closeKey: string;
  copyKey: string;
  columns: number;
}

/**
 * Read-only in-document preview of a pasted block or a file's text, following
 * the same pattern as `ToolDetailPanel` / `PlanDetailPanel` — a panel inside
 * the scrolling document, not a footer modal, since a read-only view has no
 * reason to seize the keyboard.
 */
export default function AttachmentPreview({ content, closeKey, copyKey, columns }: Props) {
  const lines = wrapToWidth(content.text, Math.max(10, columns - 4));
  const truncated = lines.length > MAX_PREVIEW_LINES;
  const visible = truncated ? lines.slice(0, MAX_PREVIEW_LINES) : lines;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginBottom={1}>
      <Text bold dimColor>{content.title} <Text>({closeKey} to close · {copyKey} to copy)</Text></Text>
      {visible.map((line, i) => (
        <Text key={i}>{line || " "}</Text>
      ))}
      {truncated && (
        <Text dimColor>... {lines.length - MAX_PREVIEW_LINES} more lines</Text>
      )}
    </Box>
  );
}
