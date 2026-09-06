import { DEFAULT_KEYBINDINGS, formatKeybinding, formatUsableKeybinding, type Keybindings } from "../config/keybindings.js";
import { agavHomePath } from "./shell-hints.js";
import { detectSandboxBackend, getSandboxName } from "./sandbox.js";

const HINTS = [
  "/undo reverts the last file change",
  "/fast switches to a lightweight model",
  "/deep switches to a powerful model",
  "/branch forks a new session from the current session",
  "/export saves chat as markdown",
  "/watch auto-runs commands on file changes",
  "/compact frees up context space",
  "/remember saves notes across sessions",
  "/resume loads a previous session",
  "Tab auto-completes slash commands",
  "--auto-accept skips all confirmations",
  "--deny-writes blocks file changes",
  "--resume picks up a previous session",
  "Backspace removes pasted attachments",
  "Ctrl+V pastes an image from clipboard (Cmd+V works in some terminals)",
  "!command runs a shell command and adds output to context",
  "AGAV.md in your project adds custom instructions",
  "{agavHome}plugins loads custom tools",
  "{agavHome}config.json stores your settings",
  "Press [A]lways during confirmation to auto-accept all",
  "/model shows or changes the current model",
  "/branch lists conversation forks or creates one with a name",
  "/forget removes a saved memory",
  "Web search runs without confirmation",
  "Edit diffs show before you approve",
  "Sessions auto-save after each exchange",
  "/ps asks a side question while the agent is working",
  "/plan shows progress on the current task plan",
  "/debug shows internal state, sandbox, and diagnostics",
  "/skills lists installed skills — /skills marketplace to browse more",
  "/skills info <name> shows skill usage stats and traces",
  "/loop 5m <prompt> repeats a prompt on an interval",
  "/loop stop cancels the active loop",
  "/schedule add \"0 9 * * *\" <prompt> creates a persistent cron task",
  "/schedule list shows all scheduled tasks",
  "/effort low|medium|high|max controls reasoning depth",
  "Agav saves memories automatically when you share preferences or corrections",
  "Destructive commands (rm -rf, git push --force) are always blocked",
  "API keys are encrypted at rest in {agavHome}config.json",
  "{agavHome}skills stores installed skills — add your own SKILL.md",
  "/security-scan runs a security audit on the codebase",
  "/explain <file> explains code in plain language",
  "/diagnose helps find and fix bugs",
  "/steer <directive> nudges the agent with new context mid-session",
  "/steer list shows active steering directives",
  "/steer clear removes all steers",
  "/model opens an interactive model picker with live API fetch",
  "/git-commit generates a commit message from staged changes",
  "Ctrl+click (Cmd+click on macOS) opens a file path, URL, or attachment tile",
  "/open lists every attachment in the session and opens or previews one",
];

let lastIndex = -1;

export function getRandomHint(keybindings: Keybindings = DEFAULT_KEYBINDINGS, enhancedKeyboard = false): string {
  const dynamicHints = [
    // Terminals without an enhanced keyboard protocol cannot send Shift+Enter, so
    // hinting it there would send the user chasing a key that does nothing.
    `${formatUsableKeybinding(keybindings, "newline", enhancedKeyboard)} for multiline input`,
    `${formatKeybinding(keybindings, "historyUp")}/${formatKeybinding(keybindings, "historyDown")} to recall previous messages`,
    `${formatKeybinding(keybindings, "toggleToolDetail")} expands tool output details`,
    `${formatKeybinding(keybindings, "togglePlanDetail")} shows the full plan while it runs`,
    `${formatKeybinding(keybindings, "cancel")} cancels a streaming response`,
    `${formatKeybinding(keybindings, "toggleThinking")} toggles thinking text visibility`,
    // Seatbelt and Bubblewrap are POSIX-only, so Windows resolves to "none".
    // Stating the sandbox unconditionally would promise isolation we do not have.
    detectSandboxBackend() === "none"
      ? "No OS sandbox detected - shell commands run unsandboxed"
      : `Shell commands run inside an OS sandbox (${getSandboxName()})`,
  ];
  const hints = [
    ...HINTS.map((hint) => hint.replaceAll("{agavHome}", agavHomePath(""))),
    ...dynamicHints,
  ];
  let idx: number;
  do {
    idx = Math.floor(Math.random() * hints.length);
  } while (idx === lastIndex && hints.length > 1);
  lastIndex = idx;
  return hints[idx]!;
}
