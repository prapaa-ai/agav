import React from "react";
import { Box, Text } from "../ink/index.js";
import type { MouseEventData } from "../ink/index.js";

/** One clickable or plain run within a single pre-wrapped visual line. */
export interface LineRun {
  /**
   * Text for this run. May be pre-styled with ANSI SGR codes (as produced by
   * `renderMarkdown`/`sliceStyled`) — but only when `color`/`underline` below
   * are both omitted, since `<Text>` chalk-transforms its children when those
   * props are set, and doing so on top of an already-styled run would nest
   * escape sequences incorrectly.
   */
  text: string;
  /** Present only for clickable runs. Opaque to this component — passed through verbatim to onOpen. */
  targetId?: string;
  /** Rendered with this color when set (used for the "clickable" affordance). */
  color?: string;
  /** Rendered with this background color when set — e.g. the user-message band. */
  backgroundColor?: string;
  /** Rendered underlined when set (used for the "clickable" affordance). */
  underline?: boolean;
  /** Rendered dim when set — used to keep a plain run's styling consistent with the surrounding text. */
  dimColor?: boolean;
  /** Rendered bold when set. */
  bold?: boolean;
}

interface Props {
  runs: LineRun[];
  /** Called when a clickable run (one with `targetId` set) is clicked. */
  onOpen?: (targetId: string) => void;
  /**
   * Optional additional handler for clicks that do NOT land on a clickable
   * run (e.g. caret placement in an input) — receives the raw mouse event.
   */
  onMiss?: (event: MouseEventData) => void;
}

/**
 * Renders one pre-wrapped visual line as a row of sibling `<Text>` spans,
 * some of them clickable.
 *
 * A `<Text>` nested inside another `<Text>` is not individually hit-testable
 * for mouse clicks in this Ink fork — the reconciler collapses nested `Text`
 * into a non-interactive "virtual text" node with no layout rectangle. Every
 * run must therefore be a sibling `<Text>` directly inside the row's
 * `<Box flexDirection="row">`, never nested inside another `<Text>`.
 *
 * This component does not wrap text itself — the caller is responsible for
 * splitting a paragraph into rows that each fit the terminal width before
 * handing runs to `ClickableLine`.
 */
export default function ClickableLine({ runs, onOpen, onMiss }: Props) {
  return (
    <Box flexDirection="row">
      {runs.map((run, i) => {
        const handleClick = run.targetId
          ? (event: MouseEventData) => {
              event.stopPropagation?.();
              onOpen?.(run.targetId!);
            }
          : onMiss;
        return (
          <Text
            key={i}
            color={run.color}
            backgroundColor={run.backgroundColor}
            underline={run.underline}
            dimColor={run.dimColor}
            bold={run.bold}
            onClick={handleClick}
          >
            {run.text}
          </Text>
        );
      })}
    </Box>
  );
}
