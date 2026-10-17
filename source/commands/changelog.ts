import type { SlashCommand, CommandResult } from "./types.js";

export const changelogCommand: SlashCommand = {
  name: "changelog",
  description: "Show release notes for the current version",
  usage: "Usage: /changelog\n\nDisplays the release notes from the last update.\nAlso shown automatically once on the first launch after an update.",
  async execute(): Promise<CommandResult> {
    const { getChangelog } = await import("../utils/auto-update.js");
    const text = await getChangelog();
    return { type: "message", text };
  },
};
