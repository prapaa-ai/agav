import type { SlashCommand, CommandResult, CommandContext } from "./types.js"
import { createHelpCommand } from "./help.js"
import { clearCommand, newCommand } from "./clear.js"
import { nameCommand } from "./name.js"
import { modelCommand } from "./model.js"
import { exitCommand } from "./exit.js"
import { historyCommand } from "./history.js"
import { exportCommand } from "./export.js"
import { watchCommand } from "./watch.js"
import { branchCommand } from "./branch.js"
import { compactCommand } from "./compact.js"
import { memoryCommand, rememberCommand, forgetCommand } from "./memory.js"
import { fastCommand, deepCommand } from "./model-routing.js"
import { undoCommand } from "./undo.js"
import { planCommand } from "./plan.js"
import { debugCommand } from "./debug.js"
import { searchCommand } from "./search-history.js"
import { effortCommand } from "./effort.js"
import { loopCommand } from "./loop.js"
import { scheduleCommand } from "./schedule.js"
import { skillsCommand } from "../skills/commands.js"
import { steerCommand } from "./steer.js"
import { changelogCommand } from "./changelog.js"
import { contextCommand } from "./context.js"

/** Store slash commands and dispatch raw user input to the matching handler. */
export class CommandRegistry {
  private commands = new Map<string, SlashCommand>()

  /** Register the built-in command set. */
  constructor() {
    const helpCommand = createHelpCommand(() => this.list())
    this.register(helpCommand)
    this.register(clearCommand)
    this.register(newCommand)
    this.register(nameCommand)
    this.register(modelCommand)
    this.register(effortCommand)
    this.register(exitCommand)
    this.register(historyCommand)
    this.register(exportCommand)
    this.register(watchCommand)
    this.register(branchCommand)
    this.register(compactCommand)
    this.register(memoryCommand)
    this.register(rememberCommand)
    this.register(forgetCommand)
    this.register(fastCommand)
    this.register(deepCommand)
    this.register(undoCommand)
    this.register(planCommand)
    this.register(debugCommand)
    this.register(searchCommand)
    this.register(loopCommand)
    this.register(scheduleCommand)
    this.register(skillsCommand)
    this.register(steerCommand)
    this.register(changelogCommand)
    this.register(contextCommand)
  }

  /** Add a command to the registry by name. */
  register(command: SlashCommand): void {
    this.commands.set(command.name, command)
  }

  /** Return all registered commands. */
  list(): SlashCommand[] {
    return Array.from(this.commands.values())
  }

  /** Check whether an input line starts with a slash command prefix. */
  isCommand(input: string): boolean {
    return input.startsWith("/")
  }

  /** Execute a slash command input and return its result, if any. */
  async execute(
    input: string,
    context: CommandContext,
  ): Promise<CommandResult | null> {
    if (!this.isCommand(input)) return null

    const parts = input.slice(1).split(/\s+/)
    const name = parts[0]!
    const args = parts.slice(1).join(" ")

    const command = this.commands.get(name)
    if (!command) {
      return {
        type: "message",
        text: `Unknown command: /${name}. Type /help for available commands.`,
      }
    }

    return command.execute(args, context)
  }
}
