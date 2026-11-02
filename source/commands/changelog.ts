import type { SlashCommand, CommandResult } from "./types.js";

/**
 * Inline hint appended after changelog output pointing users at the opt-out.
 * Shared with the first-launch auto-display (app.tsx) so the wording stays
 * consistent.
 *
 * Framed in a plain box-drawing panel rather than Markdown: the release notes
 * are shown as raw text (the changelog body often contains HTML that defeats the
 * Markdown renderer), so bold/inline-code markers would leak as literal `**` and
 * backticks. A box reads clearly either way and is far more conspicuous than a
 * trailing sentence. Exported so the launch-time display reuses the exact text.
 */
export const CHANGELOG_DISABLE_HINT = [
  "┌───────────────────────────────────────────────────────────────┐",
  "│  Automatic release notes                                      │",
  "│  • /changelog off  — stop showing release notes after updates │",
  "│  • /changelog on   — resume showing them automatically        │",
  "└───────────────────────────────────────────────────────────────┘",
].join("\n");

export const changelogCommand: SlashCommand = {
  name: "changelog",
  description: "Show release notes for the current version",
  usage: "Usage: /changelog [on|off]\n\nDisplays the release notes from the last update.\nAlso shown automatically once on the first launch after an update.\n\n/changelog off  Stop showing release notes automatically after updates.\n/changelog on   Resume showing release notes automatically after updates.",
  async execute(args: string): Promise<CommandResult> {
    const sub = args.trim().toLowerCase();

    if (sub === "off" || sub === "on") {
      const { setChangelogAutoDisplay } = await import("../config/launch-state.js");
      const enabled = sub === "on";
      const ok = await setChangelogAutoDisplay(enabled);
      if (!ok) {
        return { type: "message", text: "Could not save the changelog preference. Please try again." };
      }
      return {
        type: "message",
        text: enabled
          ? "Automatic changelog display enabled. Release notes will show once after each update."
          : "Automatic changelog display disabled. Run /changelog any time to see release notes, or /changelog on to re-enable.",
      };
    }

    if (sub.length > 0) {
      return { type: "message", text: `Unknown option "${sub}". Usage: /changelog [on|off]` };
    }

    const { getChangelog } = await import("../utils/auto-update.js");
    const { isChangelogAutoDisplayEnabled } = await import("../config/launch-state.js");
    const text = await getChangelog();
    // When auto-display is still on, remind the user how to turn it off right at
    // the end of the notes (an inline hint, not a status-bar message).
    const autoEnabled = await isChangelogAutoDisplayEnabled();
    return { type: "message", text: autoEnabled ? `${text}\n\n${CHANGELOG_DISABLE_HINT}` : text };
  },
};
