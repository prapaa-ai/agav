import { execFile } from "node:child_process";
import type { AgavHooks } from "../config/config.js";

export async function runHook(hook: string, vars: Record<string, string>): Promise<string | null> {
  let command = hook;
  for (const [key, value] of Object.entries(vars)) {
    command = command.replaceAll(`$${key}`, value);
  }

  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", command], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve(null);
      } else {
        resolve(stdout.trim() || null);
      }
    });
  });
}

export function getHookForTool(
  toolName: string,
  input: Record<string, unknown>,
  hooks?: AgavHooks,
): { hook: string; vars: Record<string, string> } | null {
  if (!hooks) return null;

  if ((toolName === "edit_file" || toolName === "write_file") && hooks.afterEdit) {
    return {
      hook: hooks.afterEdit,
      vars: { path: String(input.path ?? "") },
    };
  }

  if (toolName === "run_command") {
    const command = String(input.command ?? "");

    if (hooks.preCommit && command.includes("git commit")) {
      return {
        hook: hooks.preCommit,
        vars: { command },
      };
    }

    if (hooks.afterShell) {
      return {
        hook: hooks.afterShell,
        vars: { command },
      };
    }
  }

  return null;
}
