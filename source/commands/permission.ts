import { PERMISSION_MODES, isPermissionMode, type PermissionMode } from "../config/config.js";
import type { SlashCommand, CommandResult, CommandContext } from "./types.js";

export const MODE_HELP: Record<PermissionMode, string> = {
  "ask": "Ask before tools perform sensitive actions (default).",
  "auto-accept": "Auto-approve tool calls without asking.",
  "deny-writes": "Allow read-only tools; deny actions that modify state.",
};

/**
 * Change or show the permission mode for the current session. This is distinct
 * from the `--permission` CLI flag, which configures JSON tool permissions for
 * headless run mode; `/permission` controls the interactive session's ask /
 * auto-accept / deny-writes behavior and persists across resumes.
 */
export const permissionCommand: SlashCommand = {
  name: "permission",
  description: "Show or change the session permission mode (ask, auto-accept, deny-writes)",
  usage:
    "Usage: /permission [mode]\n\n" +
    "  /permission              Open the permission mode picker\n" +
    "  /permission ask          Ask before sensitive tool actions\n" +
    "  /permission auto-accept  Auto-approve tool calls\n" +
    "  /permission deny-writes  Allow reads, deny state-changing actions\n\n" +
    "The chosen mode persists for this session, including after resuming it. " +
    "Organization policy may enforce a stricter minimum that cannot be loosened.",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const current =
      context.getEffectivePermissionMode?.() ?? context.config?.permissionMode ?? "ask";
    let requested = args.trim().toLowerCase();

    if (!requested && context.showPermissionPicker && context.setPermissionMode && !context.isLoading) {
      context.setPickerActive(true);
      let selected: PermissionMode | undefined;
      try {
        selected = await new Promise<PermissionMode | undefined>((resolve) => context.showPermissionPicker!(resolve));
      } finally {
        context.setPickerActive(false);
      }
      if (selected === undefined) return { type: "none" };
      requested = selected;
    }

    if (!requested) {
      const lines = [
        `Current permission mode: ${current}`,
        "",
        ...PERMISSION_MODES.map(
          (mode) => `  ${mode === current ? "*" : " "} ${mode} — ${MODE_HELP[mode]}`,
        ),
        "",
        "Change with /permission <mode>.",
      ];
      return { type: "message", text: lines.join("\n") };
    }

    if (!isPermissionMode(requested)) {
      return {
        type: "message",
        text: `Invalid permission mode: ${requested}. Use ${PERMISSION_MODES.join(", ")}.`,
      };
    }

    // Changing the mode requires an interactive session: in headless mode there
    // is no live session mode to override (config.permissionMode is authoritative).
    if (!context.setPermissionMode) {
      return {
        type: "message",
        text: "Changing the permission mode is only available in an interactive session.",
      };
    }

    const applied = context.setPermissionMode(requested);
    if (applied !== requested) {
      // The org floor clamped the request to a stricter mode; report the mode
      // actually in force rather than silently pretending the request took hold.
      return {
        type: "message",
        text:
          `Requested ${requested}, but your organization's policy enforces a minimum of ${applied}. ` +
          `Permission mode is now: ${applied}.`,
      };
    }

    return { type: "message", text: `Permission mode changed to: ${applied}` };
  },
};
