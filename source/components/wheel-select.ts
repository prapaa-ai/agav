import type { WheelEventData } from "../ink/index.js";

/**
 * Builds an `onWheel` handler that steps a list selection by one item per tick.
 *
 * The overlay TUIs render inside the app's chrome, which squeezes the
 * transcript down to its minimum height while one is open. Without a handler of
 * their own the wheel bubbled all the way to the app root and scrolled those
 * few remaining rows, so pointing at a long list and scrolling looked like the
 * UI had locked up. Consuming the event here keeps the two from fighting.
 */
export function wheelSelect(
  step: (delta: -1 | 1) => void,
): (event: WheelEventData) => void {
  return (event) => {
    event.stopPropagation?.();
    step(event.direction === "up" ? -1 : 1);
  };
}

/** Clamp helper for the common `selectedIndex` case. */
export function stepIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(0, current + delta), count - 1);
}
