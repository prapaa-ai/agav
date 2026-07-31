import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "../utils/fs.js";
import { decrypt, encrypt } from "../utils/encrypt.js";

export type PermissionMode = "ask" | "auto-accept" | "deny-writes";
export type EffortLevel = "low" | "medium" | "high" | "max";

export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "max"];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && EFFORT_LEVELS.includes(value as EffortLevel);
}

import type { AgavTheme } from "./theme.js";
import type { MCPServerConfig } from "../mcp/types.js";

export interface AgavHooks {
  afterEdit?: string;
  afterShell?: string;
  preCommit?: string;
}

export interface AgavConfig {
  provider: "anthropic" | "openai" | "ollama" | "gemini";
  model: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openaiApi?: "chat" | "responses";
  geminiApiKey?: string;
  ollamaEndpoint?: string;  // e.g. "http://192.168.1.5:11434" — takes precedence over host+port
  ollamaHost?: string;
  ollamaPort?: number;
  ollamaApiKey?: string;
  systemPrompt?: string;
  effort: EffortLevel;
  maxTokens: number;
  maxIterations: number;
  errorRetries: number;
  permissionMode: PermissionMode;
  allowedTools?: string[];
  hooks?: AgavHooks;
  theme?: Partial<AgavTheme>;
  mcpServers?: Record<string, MCPServerConfig>;
}

const AGAV_DIR = join(homedir(), ".agav");
const CONFIG_PATH = join(AGAV_DIR, "config.json");

const PROJECT_CONFIG_TEMPLATE = {
  provider: {
    description: "LLM provider used for new sessions.",
    enum: ["openai", "ollama", "anthropic", "gemini"],
    type: "string",
    eg: "openai",
  },
  model: {
    description: "Model identifier sent to the selected provider.",
    type: "string",
    eg: "gpt-5.4-mini",
  },
  effort: {
    description: "Reasoning effort requested from models that support it.",
    enum: ["low", "medium", "high", "max"],
    type: "string",
    eg: "medium",
  },
  maxTokens: {
    description: "Maximum number of tokens the model may generate in one response.",
    type: "number",
    eg: 16384,
  },
  maxIterations: {
    description: "Maximum number of model and tool iterations allowed in one agent or subagent turn.",
    type: "number",
    eg: 100,
  },
  errorRetries: {
    description: "Number of retries for transient provider and network failures.",
    type: "number",
    eg: 3,
  },
  permissionMode: {
    description: "Controls whether Agav asks before tools perform sensitive actions.",
    enum: ["ask", "auto-accept", "deny-writes"],
    type: "string",
    eg: "ask",
  },
  allowedTools: {
    description: "Optional tool names or scoped tool patterns that may run without confirmation.",
    type: "array",
    eg: ["read_file", "run_command:npm run *"],
  },
  systemPrompt: {
    description: "Additional project-specific instructions included in the system prompt.",
    type: "string",
    eg: "Follow the conventions documented in this repository.",
  },
  anthropicApiKey: {
    description: "Anthropic API key. Prefer the ANTHROPIC_API_KEY environment variable for secrets.",
    type: "string",
    eg: "set-via-ANTHROPIC_API_KEY",
  },
  openaiApiKey: {
    description: "OpenAI API key. Prefer the OPENAI_API_KEY environment variable for secrets.",
    type: "string",
    eg: "set-via-OPENAI_API_KEY",
  },
  geminiApiKey: {
    description: "Google Gemini API key. Prefer the GEMINI_API_KEY environment variable for secrets.",
    type: "string",
    eg: "set-via-GEMINI_API_KEY",
  },
  ollamaEndpoint: {
    description: "Complete Ollama API base URL; overrides ollamaHost and ollamaPort.",
    type: "string",
    eg: "http://localhost:11434",
  },
  ollamaHost: {
    description: "Ollama server hostname used when ollamaEndpoint is not configured.",
    type: "string",
    eg: "localhost",
  },
  ollamaPort: {
    description: "Ollama server port used when ollamaEndpoint is not configured.",
    type: "number",
    eg: 11434,
  },
  ollamaApiKey: {
    description: "Optional bearer token for a secured or hosted Ollama endpoint.",
    type: "string",
    eg: "your-ollama-api-key",
  },
  hooks: {
    description: "Optional commands run after edits, after shell commands, or before commits.",
    type: "object",
    eg: { afterEdit: "npm run typecheck", preCommit: "npm test" },
  },
  theme: {
    description: "Optional terminal color and presentation overrides.",
    type: "object",
    eg: { userLabel: "blue", assistantLabel: "magenta", promptColor: "green" },
  },
  mcpServers: {
    description: "MCP server configurations keyed by the name shown inside Agav.",
    type: "object",
    eg: {
      everything: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      },
    },
  },
} as const;

const DEFAULT_CONFIG: AgavConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  effort: "high",
  permissionMode: "ask",
  maxTokens: 16384,
  maxIterations: 800,
  errorRetries: 5,
};

/** Merge nested config objects while letting later sources override scalar values. */
function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const val = override[key];
    if (val !== undefined && val !== null && typeof val === "object" && !Array.isArray(val)
      && typeof result[key] === "object" && result[key] !== null && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, val as Record<string, unknown>) as T[keyof T];
    } else if (val !== undefined) {
      result[key] = val as T[keyof T];
    }
  }
  return result;
}

/** Create or enrich the project config with self-documenting configuration metadata. */
async function ensureProjectConfigTemplate(): Promise<void> {
  const projectDir = join(process.cwd(), ".agav");
  const projectPath = join(projectDir, "config.json");
  await ensureDir(projectDir);

  try {
    const raw = await readFile(projectPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.template !== undefined) return;
    parsed.template = PROJECT_CONFIG_TEMPLATE;
    await writeFile(projectPath, JSON.stringify(parsed, null, 2) + "\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    await writeFile(
      projectPath,
      JSON.stringify({ template: PROJECT_CONFIG_TEMPLATE }, null, 2) + "\n",
    );
  }
}

/** Load config from global and project files, then apply environment-derived overrides. */
export async function loadConfig(): Promise<AgavConfig> {
  await ensureProjectConfigTemplate();
  let globalConfig: Partial<AgavConfig> = {};
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    globalConfig = JSON.parse(raw);
  } catch {}

  let projectConfig: Partial<AgavConfig> = {};
  try {
    const projectPath = join(process.cwd(), ".agav", "config.json");
    const raw = await readFile(projectPath, "utf-8");
    const { template: _template, ...values } = JSON.parse(raw) as Record<string, unknown>;
    projectConfig = values as Partial<AgavConfig>;
  } catch {}

  const merged = deepMerge(
    deepMerge({ ...DEFAULT_CONFIG } as unknown as Record<string, unknown>, globalConfig as unknown as Record<string, unknown>),
    projectConfig as unknown as Record<string, unknown>,
  ) as unknown as AgavConfig;

  // Ignore invalid hand-edited values instead of passing unsupported effort levels to providers.
  if (!isEffortLevel(merged.effort)) {
    merged.effort = DEFAULT_CONFIG.effort;
  }
  if (!Number.isInteger(merged.maxIterations) || merged.maxIterations < 1) {
    merged.maxIterations = DEFAULT_CONFIG.maxIterations;
  }
  if (!Number.isInteger(merged.errorRetries) || merged.errorRetries < 0) {
    merged.errorRetries = DEFAULT_CONFIG.errorRetries;
  }

  // Treat allowed tools as additive so projects can extend, not erase, a user's global allowlist.
  if (projectConfig.allowedTools) {
    merged.allowedTools = [
      ...(globalConfig.allowedTools ?? []),
      ...projectConfig.allowedTools,
    ];
  }

  merged.anthropicApiKey = decrypt(
    process.env["ANTHROPIC_API_KEY"] ??
    globalConfig.anthropicApiKey ??
    DEFAULT_CONFIG.anthropicApiKey ?? "",
  ) || undefined;
  merged.openaiApiKey = decrypt(
    process.env["OPENAI_API_KEY"] ??
    globalConfig.openaiApiKey ??
    DEFAULT_CONFIG.openaiApiKey ?? "",
  ) || undefined;
  merged.geminiApiKey = decrypt(
    process.env["GEMINI_API_KEY"] ??
    globalConfig.geminiApiKey ??
    DEFAULT_CONFIG.geminiApiKey ?? "",
  ) || undefined;

  // Ollama — env vars take precedence over config file
  if (process.env["OLLAMA_ENDPOINT"]) {
    merged.ollamaEndpoint = process.env["OLLAMA_ENDPOINT"];
  }
  if (process.env["OLLAMA_HOST"]) {
    merged.ollamaHost = process.env["OLLAMA_HOST"];
  }
  if (process.env["OLLAMA_PORT"]) {
    const p = parseInt(process.env["OLLAMA_PORT"]!, 10);
    if (!isNaN(p)) merged.ollamaPort = p;
  }
  merged.ollamaApiKey = decrypt(
    process.env["OLLAMA_API_KEY"] ??
    globalConfig.ollamaApiKey ??
    projectConfig.ollamaApiKey ??
    DEFAULT_CONFIG.ollamaApiKey ?? "",
  ) || undefined;

  return merged;
}

/** Persist config to the global config file, encrypting any API keys present. */
export async function saveConfig(config: AgavConfig): Promise<void> {
  await ensureDir(AGAV_DIR);
  const { anthropicApiKey, openaiApiKey, geminiApiKey, ollamaApiKey, ...safe } = config;
  const out: Record<string, unknown> = { ...safe };
  if (anthropicApiKey) out.anthropicApiKey = encrypt(anthropicApiKey);
  if (openaiApiKey) out.openaiApiKey = encrypt(openaiApiKey);
  if (geminiApiKey) out.geminiApiKey = encrypt(geminiApiKey);
  if (ollamaApiKey) out.ollamaApiKey = encrypt(ollamaApiKey);
  await writeFile(CONFIG_PATH, JSON.stringify(out, null, 2) + "\n");
}

/** Return the root directory used for Agav's global state files. */
export function getAgavDir(): string {
  return AGAV_DIR;
}
