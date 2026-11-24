import React, { useEffect, useState } from "react";
import { Text, useStdin } from "../ink/index.js";
import type { MouseEventData } from "../ink/index.js";

/** Opt in once per visible screen, not once per row or for the whole chat. */
export function usePointerMotion(active = true) {
  const { setMouseMotionTracking } = useStdin();
  useEffect(() => {
    if (!active) return;
    setMouseMotionTracking(true);
    return () => setMouseMotionTracking(false);
  }, [active, setMouseMotionTracking]);
}

export function useHover(active: boolean) {
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (!active) setHovered(false);
  }, [active]);
  return {
    hovered: active && hovered,
    onMouseEnter: (event: MouseEventData) => { if (active && event.button === 3) setHovered(true); },
    onMouseLeave: () => setHovered(false),
  };
}

/** Move the shared list cursor only on unmodified, button-free motion. */
export function pointerSelect(select: () => void) {
  return (event: MouseEventData) => {
    if (event.button === 3 && !event.ctrl && !event.alt && !event.shift) select();
  };
}

/** Highlight clickable text only while the pointer is over it. */
export function HoverText({ onClick, inverse, dimColor, ...props }: Omit<React.ComponentProps<typeof Text>, "onMouseEnter" | "onMouseLeave">) {
  const { hovered, ...handlers } = useHover(Boolean(onClick));
  return <Text {...props} {...handlers} onClick={onClick}
    dimColor={dimColor && !hovered} inverse={inverse || hovered} />;
}
