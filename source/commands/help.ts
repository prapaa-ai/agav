import type { SlashCommand, CommandResult } from "./types.js";

const CATEGORIES: Record<string, string[]> = {
  "Chat": ["clear", "new", "model", "effort", "fast", "deep", "compact", "ps", "export"],
  "Sessions": ["resume", "search", "branch", "name"],
  "Agents": ["agents"],
  "Skills": ["skills"],
  "Workflow": ["plan", "steer", "loop", "schedule", "watch"],
  "Memory": ["memory", "remember", "forget"],
  "Safety": ["undo"],
  "Debug": ["context", "debug", "changelog", "exit", "help"],
};

const VIRTUAL_COMMANDS: Record<string, { description: string; usage: string }> = {
  ps: {
    description: "Run a side query while the agent is working",
    usage: "Usage: /ps <question>\n\n  /ps what file is the config in?\n  /ps explain this error\n\nRuns an independent query that doesn't interrupt the active agent turn.\nUseful for quick lookups while waiting for a long task to complete.",
  },
};

export function createHelpCommand(
  getCommands: () => SlashCommand[],
): SlashCommand {
  return {
    name: "help",
    description: "Show available commands",
    async execute(args: string): Promise<CommandResult> {
      const commands = getCommands();
      const commandMap = new Map(commands.map((c) => [c.name, c]));

      const query = args.trim().replace(/^\//, "");
      if (query) {
        const cmd = commandMap.get(query);
        const virtual = VIRTUAL_COMMANDS[query];
        if (!cmd && !virtual) {
          return { type: "message", text: `Unknown command: /${query}` };
        }
        if (cmd) {
          const lines = [`/${cmd.name} — ${cmd.description}`];
          if (cmd.usage) {
            lines.push("", cmd.usage);
          }
          return { type: "message", text: lines.join("\n") };
        }
        const lines = [`/${query} — ${virtual!.description}`, "", virtual!.usage];
        return { type: "message", text: lines.join("\n") };
      }

      const listed = new Set<string>();
      const sections: string[] = [];

      for (const [category, names] of Object.entries(CATEGORIES)) {
        const lines: string[] = [];
        for (const name of names) {
          const cmd = commandMap.get(name);
          const virtual = VIRTUAL_COMMANDS[name];
          if (cmd) {
            lines.push(`    /${cmd.name.padEnd(14)} ${cmd.description}`);
            listed.add(name);
          } else if (virtual) {
            lines.push(`    /${name.padEnd(14)} ${virtual.description}`);
            listed.add(name);
          }
        }
        if (lines.length > 0) {
          sections.push(`  ${category}\n${lines.join("\n")}`);
        }
      }

      const skillCmds = commands.filter((c) => !listed.has(c.name) && !Object.values(CATEGORIES).flat().includes(c.name));
      if (skillCmds.length > 0) {
        const lines = skillCmds.map((c) => `    /${c.name.padEnd(14)} ${c.description}`);
        sections.push(`  Skill commands\n${lines.join("\n")}`);
      }

      sections.push("\n  Tip: /help <command> for detailed usage");

      return {
        type: "message",
        text: sections.join("\n\n"),
      };
    },
  };
}
