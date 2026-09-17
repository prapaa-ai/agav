/**
 * Cross-Platform Sandbox & Destructive Command Guardrails.
 *
 * Provides production-grade safety controls across:
 * 1. Windows CMD (del, rmdir, format, diskpart, registry wipe)
 * 2. PowerShell (Remove-Item -Recurse -Force, Clear-Content, Format-*, Set-ExecutionPolicy)
 * 3. Unix/Linux/macOS shells (rm -rf, mkfs, dd, fork bombs, device writes)
 * 4. Git operations (git reset --hard, git clean -fdx, force pushes, branch deletions)
 * 5. SQL/database operations (DROP TABLE, DROP DATABASE, TRUNCATE, unbounded mass DELETE)
 * 6. Command chaining (&&, ||, ;, |, &) and obfuscated execution (encoded PowerShell, base64 pipes)
 *
 * SAFETY ARCHITECTURE:
 * - "blocked": Critically dangerous commands that are blocked unconditionally (even in auto-accept mode).
 * - "destructive": High-impact operations requiring explicit user confirmation.
 * - "safe": Standard development, inspection, test, and build commands.
 */

export type CommandSafetyLevel = "safe" | "destructive" | "blocked";

export interface CommandAnalysisResult {
  level: CommandSafetyLevel;
  reason?: string;
  subCommands: string[];
}

interface GuardRule {
  pattern: RegExp;
  reason: string;
}

/**
 * Splits a composite shell command into individual pipeline and chained commands,
 * respecting single, double, and backtick quotes.
 */
export function splitCommandChain(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let inBacktick = false;

  const len = command.length;
  for (let i = 0; i < len; i++) {
    const ch = command[i]!;

    if (ch === '"' && !inSingleQuote && !inBacktick) {
      if (command[i - 1] !== "\\") inDoubleQuote = !inDoubleQuote;
      current += ch;
      continue;
    }
    if (ch === "'" && !inDoubleQuote && !inBacktick) {
      if (command[i - 1] !== "\\") inSingleQuote = !inSingleQuote;
      current += ch;
      continue;
    }
    if (ch === "`" && !inSingleQuote && !inDoubleQuote) {
      if (command[i - 1] !== "\\") inBacktick = !inBacktick;
      current += ch;
      continue;
    }

    if (inDoubleQuote || inSingleQuote || inBacktick) {
      current += ch;
      continue;
    }

    // Command chaining: &&
    if (ch === "&" && command[i + 1] === "&") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i++;
      continue;
    }

    // Command chaining: ||
    if (ch === "|" && command[i + 1] === "|") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i++;
      continue;
    }

    // Command chaining: ;
    if (ch === ";") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }

    // Pipeline: |
    if (ch === "|") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }

    // Windows CMD sequential / background operator: &
    // Avoid splitting file descriptor redirection: 2>&1, >&2
    if (ch === "&") {
      const prevChar = command[i - 1];
      if (prevChar === ">") {
        current += ch;
        continue;
      }
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments.length > 0 ? segments : [command.trim()];
}

/**
 * TIER 1: Catastrophic / Lethal commands that must NEVER be executed.
 * These are blocked unconditionally.
 */
export const BLOCKED_RULES: GuardRule[] = [
  // 1. Unix catastrophic root / home wipe
  {
    pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+(?:[/~]|\/\*|\.\s*$)/,
    reason: "Catastrophic filesystem wipe (rm -rf on root, home, or current directory)",
  },
  {
    pattern: /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+(?:[/~]|\/\*|\.\s*$)/,
    reason: "Catastrophic filesystem wipe (rm -fr on root, home, or current directory)",
  },

  // 2. Windows drive formatting and low-level disk management
  {
    pattern: /\bformat\s+[a-zA-Z]:/i,
    reason: "Drive formatting (format [drive]:)",
  },
  {
    pattern: /\bdiskpart\b/i,
    reason: "Low-level disk partitioning tool (diskpart)",
  },

  // 3. Windows system directory and registry root deletion
  {
    pattern: /\b(?:del|erase|rmdir|rd)\b.*?[a-zA-Z]:\\(?:Windows|System32)\b/i,
    reason: "Deletion of Windows system directory",
  },
  {
    pattern: /\breg\s+delete\s+(?:HKLM|HKEY_LOCAL_MACHINE|HKCR|HKEY_CLASSES_ROOT)\b/i,
    reason: "Deletion of critical Windows registry root",
  },

  // 4. Raw block storage writes and filesystem creation
  {
    pattern: /\bmkfs(?:\.[a-zA-Z0-9]+)?\b/,
    reason: "Filesystem formatting (mkfs)",
  },
  {
    pattern: />\s*\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|vd[a-z]|disk\d)/,
    reason: "Direct write to raw block storage device",
  },
  {
    pattern: /\bdd\s+.*of=\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|vd[a-z]|disk\d)/,
    reason: "Raw disk overwrite using dd",
  },
  {
    pattern: /\bdd\s+if=.*of=\/dev\//,
    reason: "Raw disk overwrite using dd",
  },

  // 5. Shell fork bomb
  {
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: "Shell fork bomb denial of service",
  },

  // 6. Obfuscated / Encoded execution
  {
    pattern: /(?:powershell|pwsh)(?:\.exe)?\s+.*-(?:e|enc|encodedcommand)\s+[a-zA-Z0-9+/=]{4,}/i,
    reason: "PowerShell encoded command execution",
  },
  {
    pattern: /\bbase64\b.*?(?:-d|--decode)\b.*?\|\s*(?:sh|bash|zsh)\b/,
    reason: "Base64 payload piped directly to shell interpreter",
  },
  {
    pattern: /\b(?:curl|wget)\s+.*\|\s*(?:sh|bash|zsh|powershell|pwsh|cmd)\b/i,
    reason: "Remote script piped directly into shell interpreter",
  },
  {
    pattern: /\b(?:iex|Invoke-Expression)\s*\(\s*(?:New-Object|iwr|curl|irm|Invoke-WebRequest)/i,
    reason: "PowerShell remote script download and direct invocation",
  },

  // 7. Catastrophic database destruction
  {
    pattern: /\bdropdb\b/i,
    reason: "Complete database drop (dropdb)",
  },
  {
    pattern: /\bDROP\s+DATABASE\b/i,
    reason: "SQL DROP DATABASE operation",
  },
];

/**
 * TIER 2: Destructive commands requiring user confirmation.
 * Permitted only when explicitly approved by user or specific allowlist pattern.
 */
export const DESTRUCTIVE_RULES: GuardRule[] = [
  // 1. Windows CMD destructive file operations
  {
    pattern: /\b(?:rmdir|rd)\b.*?\s+\/s(?:\s|$|\/q)/i,
    reason: "Windows recursive directory removal (rmdir /s)",
  },
  {
    pattern: /\b(?:del|erase)\b.*?\s+\/s(?:\s|$|\/q|\/f)/i,
    reason: "Windows recursive file deletion (del /s)",
  },
  {
    pattern: /\bshutdown\s+[\/-][srfa]/i,
    reason: "System shutdown/restart command",
  },

  // 2. PowerShell destructive operations
  {
    pattern: /\b(?:Remove-Item|ri)\b.*-(?:Recurse|r)\b.*-(?:Force|f)\b/i,
    reason: "PowerShell recursive force deletion (Remove-Item -Recurse -Force)",
  },
  {
    pattern: /\b(?:Remove-Item|ri)\b.*-(?:Force|f)\b.*-(?:Recurse|r)\b/i,
    reason: "PowerShell recursive force deletion (Remove-Item -Force -Recurse)",
  },
  {
    pattern: /\b(?:Remove-Item|ri)\b\s+.*?-(?:Recurse|r)\b/i,
    reason: "PowerShell recursive deletion (Remove-Item -Recurse)",
  },
  {
    pattern: /\b(?:Clear-Content|clc)\b/i,
    reason: "PowerShell file content wiping (Clear-Content)",
  },
  {
    pattern: /\b(?:Format-Volume|Clear-Disk|Initialize-Disk)\b/i,
    reason: "PowerShell disk management operation",
  },
  {
    pattern: /\bStop-Process\b.*-Force/i,
    reason: "Forced process termination",
  },
  {
    pattern: /\bSet-ExecutionPolicy\b/i,
    reason: "Modification of PowerShell execution policy",
  },
  {
    pattern: /\breg\s+delete\b/i,
    reason: "Windows registry key deletion",
  },

  // 3. Unix destructive file & process operations
  {
    pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f/,
    reason: "Recursive force removal (rm -rf)",
  },
  {
    pattern: /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/,
    reason: "Recursive force removal (rm -fr)",
  },
  {
    pattern: /\bsudo\s+rm\b/,
    reason: "Elevated file deletion (sudo rm)",
  },
  {
    pattern: /\bsudo\s+dd\b/,
    reason: "Elevated disk writing (sudo dd)",
  },
  {
    pattern: /\bchmod\s+-R\s+[0-7]*777\b/,
    reason: "Dangerous recursive open permission modification (chmod -R 777)",
  },
  {
    pattern: /\bchown\s+-R\b/,
    reason: "Recursive ownership modification (chown -R)",
  },
  {
    pattern: /\bkillall\b/,
    reason: "Mass process termination (killall)",
  },
  {
    pattern: /\bpkill\s+-9\b/,
    reason: "SIGKILL process termination (pkill -9)",
  },
  {
    pattern: /\btruncate\b.*(?:--size\s+0|-s\s*0)/,
    reason: "File truncation to zero bytes",
  },

  // 4. Git destructive rollback & overwrite operations
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    reason: "Git hard reset (uncommitted work discarded)",
  },
  {
    pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/,
    reason: "Git clean force (untracked files permanently deleted)",
  },
  {
    pattern: /\bgit\s+push\s+.*(?:--force|-f\b)/,
    reason: "Git force push (remote history overwrite)",
  },
  {
    pattern: /\bgit\s+branch\s+-[dD]\b/,
    reason: "Git branch deletion",
  },
  {
    pattern: /\bgit\s+checkout\s+--\s+\./,
    reason: "Git checkout rollback of all working directory changes",
  },
  {
    pattern: /\bgit\s+restore\s+(?:--staged\s+)?\.\s*$/,
    reason: "Git restore rollback of all working directory changes",
  },
  {
    pattern: /\bgit\s+stash\s+drop\b/,
    reason: "Git stash drop (saved stash discarded)",
  },

  // 5. SQL / Database destructive operations
  {
    pattern: /\bDROP\s+TABLE\b/i,
    reason: "SQL DROP TABLE operation",
  },
  {
    pattern: /\bDROP\s+SCHEMA\b/i,
    reason: "SQL DROP SCHEMA operation",
  },
  {
    pattern: /\bTRUNCATE\s+(?:TABLE\s+)?\w+/i,
    reason: "SQL TRUNCATE TABLE operation",
  },
  {
    pattern: /\bDELETE\s+FROM\s+\w+\s*(?:;|\s*$|\s*WHERE\s+1\s*=\s*1|\s*WHERE\s+true\b)/i,
    reason: "Unbounded SQL DELETE without restrictive WHERE clause",
  },
  {
    pattern: /\bALTER\s+TABLE\s+\w+\s+DROP\s+COLUMN\b/i,
    reason: "SQL DROP COLUMN schema alteration",
  },
];

/**
 * Checks whether a single command segment matches any blocked rules.
 */
function checkBlocked(segment: string): { blocked: boolean; reason?: string } {
  // If the segment is a pure echo/printf/write-output without redirection, it is safe text printing
  if (/^(?:echo|printf|Write-Host|Write-Output)\s+[^>|]+$/.test(segment)) {
    return { blocked: false };
  }

  for (const rule of BLOCKED_RULES) {
    if (rule.pattern.test(segment)) {
      return { blocked: true, reason: rule.reason };
    }
  }
  return { blocked: false };
}

/**
 * Checks whether a single command segment matches any destructive rules.
 */
function checkDestructive(segment: string): { destructive: boolean; reason?: string } {
  if (/^(?:echo|printf|Write-Host|Write-Output)\s+[^>|]+$/.test(segment)) {
    return { destructive: false };
  }

  for (const rule of DESTRUCTIVE_RULES) {
    if (rule.pattern.test(segment)) {
      return { destructive: true, reason: rule.reason };
    }
  }
  return { destructive: false };
}

/**
 * Analyzes a full command (including compound chains and pipelines) and categorizes
 * it as "blocked", "destructive", or "safe".
 */
export function analyzeCommandSafety(command: string): CommandAnalysisResult {
  const trimmed = command.trim();
  if (!trimmed) {
    return { level: "safe", subCommands: [] };
  }

  // 1. Check full command string first for holistic patterns (pipelines, fork bombs)
  const fullBlocked = checkBlocked(trimmed);
  if (fullBlocked.blocked) {
    return {
      level: "blocked",
      reason: fullBlocked.reason,
      subCommands: splitCommandChain(trimmed),
    };
  }

  const fullDestructive = checkDestructive(trimmed);
  if (fullDestructive.destructive) {
    return {
      level: "destructive",
      reason: fullDestructive.reason,
      subCommands: splitCommandChain(trimmed),
    };
  }

  const subCommands = splitCommandChain(trimmed);

  // 2. Check each sub-command individually for chained operators (&&, ||, ;, &)
  for (const sub of subCommands) {
    const check = checkBlocked(sub);
    if (check.blocked) {
      return {
        level: "blocked",
        reason: check.reason,
        subCommands,
      };
    }
  }

  // 3. Check each sub-command for destructive operations
  for (const sub of subCommands) {
    const check = checkDestructive(sub);
    if (check.destructive) {
      return {
        level: "destructive",
        reason: check.reason,
        subCommands,
      };
    }
  }

  // 4. Command is safe
  return {
    level: "safe",
    subCommands,
  };
}

/**
 * Backward-compatible helper: returns true if the command is either destructive or blocked.
 */
export function isDestructiveCommand(command: string): boolean {
  const analysis = analyzeCommandSafety(command);
  return analysis.level !== "safe";
}

/**
 * Helper to identify lethal / blocked commands that must never execute.
 */
export function isBlockedCommand(command: string): boolean {
  const analysis = analyzeCommandSafety(command);
  return analysis.level === "blocked";
}
