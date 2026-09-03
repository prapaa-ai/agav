export function getToolConfirmationWarning(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName !== "process") return undefined;

  const action = String(input.action ?? "").toLowerCase();
  if (action === "start") {
    return "This starts a daemon-backed background process that may keep running after Agav exits. It can write files, use network, and consume CPU, memory, and disk until it finishes or is killed.";
  }

  if (action === "kill") {
    return "This sends a signal to a background process and may stop work currently in progress.";
  }

  return undefined;
}
