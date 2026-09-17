import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export type PermissionAction = "allow" | "deny" | "ask";

export interface PermissionRule {
  pattern: string;
  action: PermissionAction;
  source: "project" | "global" | "default";
}

export interface PermissionsFile {
  version?: string;
  permissions?: Record<string, PermissionAction>;
  allow?: string[];
  deny?: string[];
  ask?: string[];
}

/**
 * Extracts the primary input argument for pattern matching based on tool type.
 */
export function getToolPrimaryInput(toolName: string, input: Record<string, unknown>): string {
  if (!input) return "";
  if (toolName === "run_command") return String(input.command ?? "");
  if (toolName === "edit_file" || toolName === "write_file" || toolName === "read_file") {
    return String(input.path ?? "").replace(/\\/g, "/");
  }
  if (toolName === "fetch_url") return String(input.url ?? "");
  return String(input.task ?? input.query ?? input.name ?? "");
}

/**
 * Converts a glob pattern into a regular expression.
 */
export function globToRegex(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, "/");
  let regexStr = "^";
  let i = 0;
  while (i < normalized.length) {
    const char = normalized[i];
    if (char === "*" && normalized[i + 1] === "*") {
      regexStr += ".*";
      i += 2;
      if (normalized[i] === "/") i++;
    } else if (char === "*") {
      regexStr += ".*";
      i++;
    } else if (char === "?") {
      regexStr += ".";
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(char)) {
      regexStr += `\\${char}`;
      i++;
    } else {
      regexStr += char;
      i++;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr, "i");
}

/**
 * Checks if a permission rule pattern matches a tool name and primary input.
 */
export function matchPermissionPattern(
  rulePattern: string,
  toolName: string,
  primaryInput: string,
): { matched: boolean; specificity: number } {
  const trimmed = rulePattern.trim();
  const colonIndex = trimmed.indexOf(":");

  let ruleTool = trimmed;
  let ruleArg = "*";

  if (colonIndex !== -1) {
    ruleTool = trimmed.slice(0, colonIndex).trim();
    ruleArg = trimmed.slice(colonIndex + 1).trim();
  }

  // Tool name matching
  if (ruleTool !== "*" && ruleTool !== toolName) {
    return { matched: false, specificity: 0 };
  }

  // Input matching
  if (ruleArg === "*" || ruleArg === "") {
    // Matches all inputs for this tool
    const specificity = ruleTool === "*" ? 1 : 10;
    return { matched: true, specificity };
  }

  const regex = globToRegex(ruleArg);
  const normalizedInput = primaryInput.replace(/\\/g, "/");
  const matched = regex.test(normalizedInput);

  // Specific rule with pattern has highest specificity
  const specificity = 20 + ruleArg.length;
  return { matched, specificity };
}

/**
 * Parses a permissions JSON file into normalized PermissionRule entries.
 */
export function parsePermissionsContent(
  content: string,
  source: "project" | "global",
): PermissionRule[] {
  const rules: PermissionRule[] = [];
  try {
    const parsed: PermissionsFile = JSON.parse(content);

    // Format 1: "permissions": { "run_command:pnpm test*": "allow" }
    if (parsed.permissions && typeof parsed.permissions === "object") {
      for (const [pattern, action] of Object.entries(parsed.permissions)) {
        if (action === "allow" || action === "deny" || action === "ask") {
          rules.push({ pattern, action, source });
        }
      }
    }

    // Format 2: "allow": ["run_command:pnpm test*"], "deny": [...], "ask": [...]
    const actions: PermissionAction[] = ["allow", "deny", "ask"];
    for (const act of actions) {
      const list = parsed[act];
      if (Array.isArray(list)) {
        for (const item of list) {
          if (typeof item === "string" && item.trim()) {
            rules.push({ pattern: item.trim(), action: act, source });
          }
        }
      }
    }
  } catch {}
  return rules;
}

/**
 * Permission policy manager loading, resolving, and persisting .agav/permissions.json.
 */
export class PermissionManager {
  private rules: PermissionRule[] = [];
  private projectPath: string;
  private globalPath: string;

  constructor(projectPath: string, globalPath: string, rules: PermissionRule[] = []) {
    this.projectPath = projectPath;
    this.globalPath = globalPath;
    this.rules = rules;
  }

  static async load(cwd: string = process.cwd()): Promise<PermissionManager> {
    const resolvedCwd = resolve(cwd);
    const projectPath = join(resolvedCwd, ".agav", "permissions.json");
    const globalPath = join(homedir(), ".agav", "permissions.json");

    const rules: PermissionRule[] = [];

    // 1. Load global rules first (lowest priority)
    if (existsSync(globalPath)) {
      try {
        const globalContent = await readFile(globalPath, "utf-8");
        rules.push(...parsePermissionsContent(globalContent, "global"));
      } catch {}
    }

    // 2. Load project rules second (overrides global rules)
    if (existsSync(projectPath)) {
      try {
        const projectContent = await readFile(projectPath, "utf-8");
        rules.push(...parsePermissionsContent(projectContent, "project"));
      } catch {}
    }

    return new PermissionManager(projectPath, globalPath, rules);
  }

  getRules(): PermissionRule[] {
    return [...this.rules];
  }

  /**
   * Evaluates permissions for a tool call.
   * Precedence:
   * 1. Any matching 'deny' rule unconditionally denies the call.
   * 2. Highest specificity matching rule determines action ('allow' or 'ask').
   * 3. Project-scoped rules override global rules of the same pattern.
   * Returns null if no rule matched (falls back to default safety logic).
   */
  evaluate(toolName: string, input: Record<string, unknown>): PermissionAction | null {
    const primaryInput = getToolPrimaryInput(toolName, input);

    const matches: Array<{ rule: PermissionRule; specificity: number }> = [];

    for (const rule of this.rules) {
      const { matched, specificity } = matchPermissionPattern(rule.pattern, toolName, primaryInput);
      if (matched) {
        // Project rules gain a priority boost over global rules
        const finalSpecificity = specificity + (rule.source === "project" ? 100 : 0);
        matches.push({ rule, specificity: finalSpecificity });
      }
    }

    if (matches.length === 0) {
      return null;
    }

    // 1. Check for ANY matching 'deny' rule (deny always takes precedence)
    const denyMatch = matches.find((m) => m.rule.action === "deny");
    if (denyMatch) {
      return "deny";
    }

    // 2. Sort by specificity descending
    matches.sort((a, b) => b.specificity - a.specificity);
    return matches[0]?.rule.action ?? null;
  }

  /**
   * Adds or updates a rule in the target scope.
   */
  async addRule(
    pattern: string,
    action: PermissionAction,
    scope: "project" | "global" = "project",
  ): Promise<void> {
    const targetPath = scope === "project" ? this.projectPath : this.globalPath;

    // Filter out existing rule for this pattern in this scope
    this.rules = this.rules.filter((r) => !(r.pattern === pattern && r.source === scope));
    this.rules.push({ pattern, action, source: scope });

    await this.persistScope(targetPath, scope);
  }

  /**
   * Removes a rule from the target scope.
   */
  async removeRule(pattern: string, scope: "project" | "global" = "project"): Promise<boolean> {
    const targetPath = scope === "project" ? this.projectPath : this.globalPath;
    const initialLen = this.rules.length;

    this.rules = this.rules.filter((r) => !(r.pattern === pattern && r.source === scope));
    const removed = this.rules.length < initialLen;

    if (removed) {
      await this.persistScope(targetPath, scope);
    }
    return removed;
  }

  /**
   * Clears all rules in the target scope.
   */
  async clearRules(scope: "project" | "global"): Promise<void> {
    const targetPath = scope === "project" ? this.projectPath : this.globalPath;
    this.rules = this.rules.filter((r) => r.source !== scope);
    await this.persistScope(targetPath, scope);
  }

  private async persistScope(filePath: string, scope: "project" | "global"): Promise<void> {
    const scopeRules = this.rules.filter((r) => r.source === scope);
    const permissionsObj: Record<string, PermissionAction> = {};

    for (const rule of scopeRules) {
      permissionsObj[rule.pattern] = rule.action;
    }

    const content: PermissionsFile = {
      version: "1.0.0",
      permissions: permissionsObj,
    };

    const dir = join(filePath, "..");
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(filePath, JSON.stringify(content, null, 2) + "\n", "utf-8");
  }
}
