import React from "react";
import { Box, Text, useStdin, type MouseEventData } from "../ink/index.js";
import { useHover, usePointerMotion } from "./hover-text.js";
import type { Key } from "../ink/hooks/use-input.js";

const DOUBLE_CLICK_MS = 400;

type ConfirmSurface = { revision: number };

// Keep the last activation across prompt unmounts, but never across Ink instances.
const lastActivation = new WeakMap<object, { x: number; y: number; time: number; surface: ConfirmSurface }>();

/** Identify the visible prompt, not routine repainting. */
export function useConfirmSurface(request: object, variant?: string): ConfirmSurface {
  const shown = React.useRef<{ request: object; variant?: string; surface: ConfirmSurface } | null>(null);
  if (!shown.current || shown.current.request !== request || shown.current.variant !== variant) {
    shown.current = { request, variant, surface: { revision: (shown.current?.surface.revision ?? 0) + 1 } };
  }
  return shown.current.surface;
}

/** Activate only a stationary left-button release on the same prompt. */
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
  const { internal_eventEmitter } = useStdin();
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
        event.stopPropagation?.();
        const last = lastActivation.get(internal_eventEmitter);
        // Only suppress a rapid repeat at the same terminal cell on a different prompt.
        if (last && last.surface !== surface && last.x === event.x && last.y === (event.screenY ?? event.y)
          && Date.now() - last.time < DOUBLE_CLICK_MS) return;
        pressedAt.current = { x: event.x, y: event.y, surface };
        setPressed(true);
        clearTimeout(flash.current);
        flash.current = setTimeout(() => setPressed(false), 150);
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
        if (event.button === 0 && at?.surface === surface && at.x === event.x && at.y === event.y) {
          lastActivation.set(internal_eventEmitter, { x: event.x, y: event.screenY ?? event.y, time: Date.now(), surface });
          onActivate();
        }
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
