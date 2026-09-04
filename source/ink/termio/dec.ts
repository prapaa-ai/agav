// DEC private mode (DECSET/DECRESET) escape sequences and terminal control
// helpers used by the agav Ink fork for mouse tracking and screen management.
//
// DECSET:   \x1b[?<code>h   (set / enable)
// DECRESET: \x1b[?<code>l   (reset / disable)

/** Build a DECSET (enable) sequence for the given private mode code. */
export const decset = (code: number | string): string => `\x1b[?${code}h`;

/** Build a DECRESET (disable) sequence for the given private mode code. */
export const decreset = (code: number | string): string => `\x1b[?${code}l`;

// Mouse tracking private mode codes. Button-motion is needed for Agav's
// application-owned drag selection; any-motion is not, and needlessly floods
// stdin while the pointer moves with no button held.
const MOUSE_NORMAL = 1000; // X11 normal tracking (press/release and wheel).
const MOUSE_BUTTON_MOTION = 1002; // Button-event (drag) tracking.
const MOUSE_SGR = 1006; // SGR extended coordinate encoding.

const MOUSE_MODES = [MOUSE_NORMAL, MOUSE_BUTTON_MOTION, MOUSE_SGR];

/** Enable normal, drag, and SGR-coordinate mouse tracking. */
export const ENABLE_MOUSE_TRACKING = MOUSE_MODES.map(decset).join("");

/** Disable the same set of mouse tracking modes. */
export const DISABLE_MOUSE_TRACKING = MOUSE_MODES.map(decreset).join("");

/** Switch to the alternate screen buffer. */
export const ENTER_ALT_SCREEN = decset(1049);

/** Switch back to the main screen buffer. */
export const EXIT_ALT_SCREEN = decreset(1049);

/** Erase the whole visible screen (leaves modes and the buffer choice alone). */
export const ERASE_DISPLAY = "\x1b[2J";

/** Erase the scrollback buffer. No-op while the alternate screen is active. */
export const ERASE_SCROLLBACK = "\x1b[3J";

/** Move the cursor to row 1, column 1. */
export const CURSOR_HOME = "\x1b[H";

/** Hide the text cursor. */
export const HIDE_CURSOR = decreset(25);

/** Show the text cursor. */
export const SHOW_CURSOR = decset(25);

/** Enable bracketed paste mode (2004). */
export const ENABLE_BRACKETED_PASTE = decset(2004);

/** Disable bracketed paste mode (2004). */
export const DISABLE_BRACKETED_PASTE = decreset(2004);
