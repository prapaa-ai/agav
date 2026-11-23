import React from "react";
import { Box, Text, type MouseEventData } from "../ink/index.js";
import { useHover, usePointerMotion } from "./hover-text.js";
import type { Key } from "../ink/hooks/use-input.js";

// A second click must not answer a new prompt that appeared under the pointer.
const CLICK_SETTLE_MS = 400;

type ConfirmSurface = { request: object; variant?: string; revision: number; shownAt: number };

/** Identify the visible prompt, not routine repainting. Stamp it before mouse reports can arrive. */
export function useConfirmSurface(request: object, variant?: string): ConfirmSurface {
  const shown = React.useRef<ConfirmSurface | null>(null);
  if (!shown.current || shown.current.request !== request || shown.current.variant !== variant) {
    shown.current = { request, variant, revision: (shown.current?.revision ?? 0) + 1, shownAt: Date.now() };
  }
  return shown.current;
}

/** Activate only a stationary left-button release on the same settled prompt. */
export default function ConfirmControl({ label, color, surface, onActivate, padded = true, bold = true, active = false, hovered, onMouseEnter, onMouseLeave, onPoint }: {
  label: string;
  color?: string;
  surface: ConfirmSurface;
  onActivate: () => void;
  padded?: boolean;
  bold?: boolean;
  active?: boolean;
  hovered?: boolean;
  onMouseEnter?: (event: MouseEventData) => void;
  onMouseLeave?: (event: MouseEventData) => void;
  onPoint?: (event: MouseEventData) => void;
}) {
  const hover = useHover(onMouseEnter === undefined && onPoint === undefined);
  const [pressed, setPressed] = React.useState(false);
  const flash = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pressedAt = React.useRef<{ x: number; y: number; surface: ConfirmSurface } | null>(null);
  React.useEffect(() => () => clearTimeout(flash.current), []);
  // Box handles drag reports; its single Text child keeps the padded label one target.
  return (
    <Box
      onMouseEnter={onMouseEnter ?? hover.onMouseEnter}
      onMouseLeave={onMouseLeave ?? hover.onMouseLeave}
      onMouseDown={(event: MouseEventData) => {
        pressedAt.current = null;
        if (event.button !== 0) return;
        if (Date.now() - surface.shownAt >= CLICK_SETTLE_MS) {
          pressedAt.current = { x: event.x, y: event.y, surface };
          setPressed(true);
          clearTimeout(flash.current);
          flash.current = setTimeout(() => setPressed(false), 150);
        }
        event.stopPropagation?.();
      }}
      onMouseMove={(event: MouseEventData) => {
        if (event.button === 3) { onPoint?.(event); return; }
        pressedAt.current = null;
        event.stopPropagation?.();
      }}
      onWheel={() => { pressedAt.current = null; }}
      onClick={(event: MouseEventData) => {
        const at = pressedAt.current;
        pressedAt.current = null;
        if (event.button === 0 && at?.surface === surface && at.x === event.x && at.y === event.y) onActivate();
        event.stopPropagation?.();
      }}
    >
      <Text bold={bold} color={color} inverse={active || pressed || (hovered ?? hover.hovered)}>{padded ? ` ${label} ` : label}</Text>
    </Box>
  );
}

/** Both workflow prompts are explicit, single-invocation decisions. */
export function WorkflowConfirmControls({ surface, approve, deny }: {
  surface: ConfirmSurface;
  approve: () => void;
  deny: () => void;
}) {
  usePointerMotion();
  return <Box flexWrap="wrap" key={surface.revision}>
    <ConfirmControl label="y: Approve" color="green" surface={surface} onActivate={approve} padded={false} />
    <Text dimColor>{" · "}</Text>
    <ConfirmControl label="n/ESC: Deny" color="red" surface={surface} onActivate={deny} padded={false} />
  </Box>;
}

export function workflowConfirmAction(char: string, key: Key, enterApproves = false): "approve" | "deny" | undefined {
  if (key.eventType === "release") return;
  const letter = char.toLowerCase();
  if (key.escape || (key.ctrl && letter === "c")) return "deny";
  if (key.ctrl || key.meta || key.super || key.hyper) return;
  if (letter === "y" || (enterApproves && key.return)) return "approve";
  if (letter === "n") return "deny";
}
