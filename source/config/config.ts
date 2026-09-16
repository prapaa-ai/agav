import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "../utils/fs.js";
import { decrypt, encrypt } from "../utils/encrypt.js";

export type PermissionMode = "ask" | "auto-accept" | "deny-writes";
export type EffortLevel = "low" | "medium" | "high" | "max";

export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "max"];

const DEFAULT_MARKETPLACE_FALLBACK = "https://raw.githubusercontent.com/prapaa-ai/agav-marketplace/main";

/** Default marketplace URL — override via AGAV_MARKETPLACE_URL env var or agentMarketplace in config.json */
export function getDefaultMarketplaceUrl(): string {
  return process.env.AGAV_MARKETPLACE_URL || DEFAULT_MARKETPLACE_FALLBACK;
}

/** @deprecated Use getDefaultMarketplaceUrl() instead */
export const DEFAULT_MARKETPLACE_URL = DEFAULT_MARKETPLACE_FALLBACK;

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
  provider: "anthropic" | "openai" | "openrouter" | "nvidia" | "deepseek" | "ollama" | "gemini" | "vertex-ai" | "groq";
  model: string;
  anthropicApiKey?: string;
  anthropicApiKeys?: string[];
  openaiApiKey?: string;
  openaiApiKeys?: string[];
  openrouterApiKey?: string;
  openrouterApiKeys?: string[];
  nvidiaApiKey?: string;
  nvidiaApiKeys?: string[];
  deepseekApiKey?: string;
  deepseekApiKeys?: string[];
  groqApiKey?: string;
  groqApiKeys?: string[];
  openaiApi?: "chat" | "responses";
  // Override the OpenAI provider's base URL to target an OpenAI-compatible
  // endpoint (self-hosted gateway, private deployment, or any vendor that
  // speaks the OpenAI API without a dedicated provider entry).
  openaiBaseURL?: string;
  // Extra HTTP headers sent with every OpenAI-provider request. Useful for
  // OpenAI-compatible gateways that require custom auth or routing headers
  // (e.g. an "x-api-key" or a tenant selector) alongside the base URL.
  openaiHeaders?: Record<string, string>;
  geminiApiKey?: string;
  geminiApiKeys?: string[];
  vertexAICredentialsPath?: string;
  vertexAILocation?: string;
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
  agentMarketplace?: string; // URL to agent marketplace repository
  hideAbsolutePath?: boolean;
  showThinking?: boolean;
  whisperBinPath?: string;
  whisperModelPath?: string;
  whisperLanguage?: string;
}

const AGAV_DIR = join(homedir(), ".agav");
const CONFIG_PATH = join(AGAV_DIR, "config.json");

/**
 * Expand a leading `~` to the home directory. Users naturally write `~/...` for
 * a file path in config.json, but no shell is involved when we read it back, so
 * without this Node tries to open a directory literally named "~" and fails
 * with ENOENT.
 */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

const PROJECT_CONFIG_TEMPLATE = {
  provider: {
    description: "LLM provider used for new sessions.",
    enum: ["openai", "openrouter", "nvidia", "ollama", "anthropic", "gemini", "vertex-ai", "deepseek"],
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
  hideAbsolutePath: {
    description: "Whether to hide absolute paths in terminal outputs, replacing them with relative ones.",
    type: "boolean",
    eg: false,
  },
  showThinking: {
    description: "Whether to display the model's reasoning/thinking text as it streams. Toggle with Ctrl+T at runtime.",
    type: "boolean",
    eg: false,
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
  openrouterApiKey: {
    description: "OpenRouter API key. Prefer the OPENROUTER_API_KEY environment variable for secrets.",
    type: "string",
    eg: "set-via-OPENROUTER_API_KEY",
  },
  nvidiaApiKey: {
    description: "NVIDIA NIM API key. Prefer the NVIDIA_API_KEY environment variable for secrets.",
    type: "string",
    eg: "set-via-NVIDIA_API_KEY",
  },
  deepseekApiKey: {
    description: "DeepSeek API key. Prefer the DEEPSEEK_API_KEY environment variable for secrets.",
    type: "string",
    eg: "set-via-DEEPSEEK_API_KEY",
  },
  openaiBaseURL: {
    description: "Override the OpenAI base URL to target an OpenAI-compatible endpoint. Prefer the OPENAI_BASE_URL environment variable.",
    type: "string",
    eg: "https://my-gateway.example.com/v1",
  },
  openaiHeaders: {
    description: "Extra HTTP headers sent with every OpenAI-provider request. Useful for OpenAI-compatible gateways that need custom auth or routing headers.",
    type: "object",
    eg: { "x-api-key": "gateway-token", "x-tenant": "team-a" },
  },
  geminiApiKey: {
    description: "Google Gemini API key. Prefer the GEMINI_API_KEY environment variable for secrets.",
    type: "string",
    eg: "set-via-GEMINI_API_KEY",
  },
  vertexAICredentialsPath: {
    description: "Path to a Google Cloud service-account JSON file used by Vertex AI. Setting it enables the provider. Prefer the VERTEX_AI_CREDENTIALS_PATH environment variable.",
    type: "string",
    eg: "/path/to/service-account.json",
  },
  vertexAILocation: {
    description: "Vertex AI region, or \"global\" for the multi-region endpoint. Can also be set with VERTEX_AI_LOCATION.",
    type: "string",
    eg: "global",
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

let _templateChecked = false;

/** Create or enrich the project config with self-documenting configuration metadata. */
async function ensureProjectConfigTemplate(): Promise<void> {
  if (_templateChecked) return;
  const projectDir = join(process.cwd(), ".agav");
  const projectPath = join(projectDir, "config.json");
  await ensureDir(projectDir);

  try {
    const raw = await readFile(projectPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Refresh shipped metadata after upgrades while preserving user settings,
    // but avoid rewriting committed config files when nothing changed.
    if (JSON.stringify(parsed.template) === JSON.stringify(PROJECT_CONFIG_TEMPLATE)) {
      _templateChecked = true;
      return;
    }
    parsed.template = PROJECT_CONFIG_TEMPLATE;
    await writeFile(projectPath, JSON.stringify(parsed, null, 2) + "\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    await writeFile(
      projectPath,
      JSON.stringify({ template: PROJECT_CONFIG_TEMPLATE }, null, 2) + "\n",
    );
  }
  _templateChecked = true;
}

// Sensitive fields that project-level .agav/config.json must not override.
// A malicious repository could set openaiBaseURL to redirect API requests
// (including the user's bearer token) to an attacker-controlled server, or
// escalate permissionMode to auto-accept all tool calls. These fields may
// only come from the user's global config or environment variables.
//
// Note: vertexAICredentialsPath is intentionally allowed — it's a local file
// path, not a URL. The Vertex AI auth flow always validates against Google's
// fixed OAuth endpoint (oauth2.googleapis.com), so a crafted credentials file
// cannot redirect token exchange to an attacker server.
const PROJECT_CONFIG_DENY = new Set<string>([
  "openaiBaseURL",
  "openaiHeaders",
  "ollamaEndpoint",
  "ollamaHost",
  "ollamaPort",
  "ollamaApiKey",
  "anthropicApiKey",
  "anthropicApiKeys",
  "openaiApiKey",
  "openaiApiKeys",
  "openrouterApiKey",
  "openrouterApiKeys",
  "nvidiaApiKey",
  "nvidiaApiKeys",
  "deepseekApiKey",
  "deepseekApiKeys",
  "geminiApiKey",
  "geminiApiKeys",
  "permissionMode",
]);

export function resolveApiKeys(
  envBaseName: string,
  sources: {
    single?: string;
    multiple?: string[];
  }[] = [],
): string[] {
  const envKeys: string[] = [];

  // 1. Primary env var e.g. ANTHROPIC_API_KEY (supports comma-separated)
  const primaryEnv = process.env[envBaseName];
  if (primaryEnv) {
    for (const part of primaryEnv.split(",")) {
      const trimmed = part.trim();
      if (trimmed) envKeys.push(decrypt(trimmed));
    }
  }

  // Also check plural env var e.g. ANTHROPIC_API_KEYS (supports comma-separated)
  const pluralEnv = process.env[`${envBaseName}S`];
  if (pluralEnv) {
    for (const part of pluralEnv.split(",")) {
      const trimmed = part.trim();
      if (trimmed) envKeys.push(decrypt(trimmed));
    }
  }

  // 2. Numbered env vars e.g. ANTHROPIC_API_KEY_1, ANTHROPIC_API_KEY_2...
  const numberedPattern = new RegExp(`^${envBaseName}_(\\d+)$`);
  const numberedEntries: { index: number; value: string }[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    const match = key.match(numberedPattern);
    if (match) {
      numberedEntries.push({ index: parseInt(match[1], 10), value: value.trim() });
    }
  }
  numberedEntries.sort((a, b) => a.index - b.index);
  for (const entry of numberedEntries) {
    for (const part of entry.value.split(",")) {
      const trimmed = part.trim();
      if (trimmed) envKeys.push(decrypt(trimmed));
    }
  }

  // Deduplicate environment keys
  const uniqueEnvKeys: string[] = [];
  const seenEnv = new Set<string>();
  for (const k of envKeys) {
    if (k && !seenEnv.has(k)) {
      seenEnv.add(k);
      uniqueEnvKeys.push(k);
    }
  }

  // Environment keys strictly override configured project, global, and default keys
  if (uniqueEnvKeys.length > 0) {
    return uniqueEnvKeys;
  }

  // 3. If no environment keys exist, evaluate non-environment tiers in precedence order
  for (const src of sources) {
    const tierKeys: string[] = [];
    if (src.multiple && Array.isArray(src.multiple)) {
      for (const k of src.multiple) {
        if (typeof k === "string") {
          const trimmed = k.trim();
          if (trimmed) tierKeys.push(decrypt(trimmed));
        }
      }
    }
    if (src.single && typeof src.single === "string") {
      for (const part of src.single.split(",")) {
        const trimmed = part.trim();
        if (trimmed) tierKeys.push(decrypt(trimmed));
      }
    }

    const uniqueTierKeys: string[] = [];
    const seenTier = new Set<string>();
    for (const k of tierKeys) {
      if (k && !seenTier.has(k)) {
        seenTier.add(k);
        uniqueTierKeys.push(k);
      }
    }

    if (uniqueTierKeys.length > 0) {
      return uniqueTierKeys;
    }
  }

  return [];
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

  // Strip sensitive fields that could redirect credentials or escalate permissions.
  for (const key of PROJECT_CONFIG_DENY) {
    delete (projectConfig as Record<string, unknown>)[key];
  }

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

  const anthropicKeys = resolveApiKeys("ANTHROPIC_API_KEY", [
    { single: projectConfig.anthropicApiKey, multiple: projectConfig.anthropicApiKeys },
    { single: globalConfig.anthropicApiKey, multiple: globalConfig.anthropicApiKeys },
    { single: DEFAULT_CONFIG.anthropicApiKey },
  ]);
  merged.anthropicApiKeys = anthropicKeys.length > 0 ? anthropicKeys : undefined;
  merged.anthropicApiKey = anthropicKeys[0] || undefined;

  const openaiKeys = resolveApiKeys("OPENAI_API_KEY", [
    { single: projectConfig.openaiApiKey, multiple: projectConfig.openaiApiKeys },
    { single: globalConfig.openaiApiKey, multiple: globalConfig.openaiApiKeys },
    { single: DEFAULT_CONFIG.openaiApiKey },
  ]);
  merged.openaiApiKeys = openaiKeys.length > 0 ? openaiKeys : undefined;
  merged.openaiApiKey = openaiKeys[0] || undefined;

  const openrouterKeys = resolveApiKeys("OPENROUTER_API_KEY", [
    { single: projectConfig.openrouterApiKey, multiple: projectConfig.openrouterApiKeys },
    { single: globalConfig.openrouterApiKey, multiple: globalConfig.openrouterApiKeys },
    { single: DEFAULT_CONFIG.openrouterApiKey },
  ]);
  merged.openrouterApiKeys = openrouterKeys.length > 0 ? openrouterKeys : undefined;
  merged.openrouterApiKey = openrouterKeys[0] || undefined;

  const nvidiaKeys = resolveApiKeys("NVIDIA_API_KEY", [
    { single: projectConfig.nvidiaApiKey, multiple: projectConfig.nvidiaApiKeys },
    { single: globalConfig.nvidiaApiKey, multiple: globalConfig.nvidiaApiKeys },
    { single: DEFAULT_CONFIG.nvidiaApiKey },
  ]);
  merged.nvidiaApiKeys = nvidiaKeys.length > 0 ? nvidiaKeys : undefined;
  merged.nvidiaApiKey = nvidiaKeys[0] || undefined;

  const deepseekKeys = resolveApiKeys("DEEPSEEK_API_KEY", [
    { single: projectConfig.deepseekApiKey, multiple: projectConfig.deepseekApiKeys },
    { single: globalConfig.deepseekApiKey, multiple: globalConfig.deepseekApiKeys },
    { single: DEFAULT_CONFIG.deepseekApiKey },
  ]);
  merged.deepseekApiKeys = deepseekKeys.length > 0 ? deepseekKeys : undefined;
  merged.deepseekApiKey = deepseekKeys[0] || undefined;

  const geminiKeys = resolveApiKeys("GEMINI_API_KEY", [
    { single: projectConfig.geminiApiKey, multiple: projectConfig.geminiApiKeys },
    { single: globalConfig.geminiApiKey, multiple: globalConfig.geminiApiKeys },
    { single: DEFAULT_CONFIG.geminiApiKey },
  ]);
  merged.geminiApiKeys = geminiKeys.length > 0 ? geminiKeys : undefined;
  merged.geminiApiKey = geminiKeys[0] || undefined;

  const groqKeys = resolveApiKeys("GROQ_API_KEY", [
    { single: (projectConfig as any).groqApiKey, multiple: (projectConfig as any).groqApiKeys },
    { single: (globalConfig as any).groqApiKey, multiple: (globalConfig as any).groqApiKeys },
    { single: (DEFAULT_CONFIG as any).groqApiKey },
  ]);
  merged.groqApiKeys = groqKeys.length > 0 ? groqKeys : undefined;
  merged.groqApiKey = groqKeys[0] || undefined;

  // Vertex AI — the credentials path alone enables the provider; there is no
  // separate on/off flag to keep in sync with it.
  if (process.env["VERTEX_AI_CREDENTIALS_PATH"]) {
    merged.vertexAICredentialsPath = process.env["VERTEX_AI_CREDENTIALS_PATH"];
  }
  if (process.env["VERTEX_AI_LOCATION"]) {
    merged.vertexAILocation = process.env["VERTEX_AI_LOCATION"];
  }
  // Applied after the env override so a tilde resolves whichever source the
  // path came from: environment, project config, or global config.
  if (merged.vertexAICredentialsPath) {
    merged.vertexAICredentialsPath = expandHome(merged.vertexAICredentialsPath);
  }

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
    projectConfig.ollamaApiKey ??
    globalConfig.ollamaApiKey ??
    DEFAULT_CONFIG.ollamaApiKey ?? "",
  ) || undefined;

  if (merged.openaiHeaders && typeof merged.openaiHeaders === "object") {
    const decryptedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(merged.openaiHeaders)) {
      decryptedHeaders[key] = typeof value === "string" ? decrypt(value) : value;
    }
    merged.openaiHeaders = decryptedHeaders;
  }

  return merged;
}

/** Persist config to the global config file, encrypting any API keys present. */
export async function saveConfig(config: AgavConfig): Promise<void> {
  await ensureDir(AGAV_DIR);
  const {
    anthropicApiKey,
    anthropicApiKeys,
    openaiApiKey,
    openaiApiKeys,
    openrouterApiKey,
    openrouterApiKeys,
    nvidiaApiKey,
    nvidiaApiKeys,
    deepseekApiKey,
    deepseekApiKeys,
    geminiApiKey,
    geminiApiKeys,
    groqApiKey,
    groqApiKeys,
    ollamaApiKey,
    openaiHeaders,
    ...safe
  } = config;
  const out: Record<string, unknown> = { ...safe };
  if (anthropicApiKey) out.anthropicApiKey = encrypt(anthropicApiKey);
  if (anthropicApiKeys && Array.isArray(anthropicApiKeys)) {
    out.anthropicApiKeys = anthropicApiKeys.map((k) => encrypt(k));
  }
  if (openaiApiKey) out.openaiApiKey = encrypt(openaiApiKey);
  if (openaiApiKeys && Array.isArray(openaiApiKeys)) {
    out.openaiApiKeys = openaiApiKeys.map((k) => encrypt(k));
  }
  if (openrouterApiKey) out.openrouterApiKey = encrypt(openrouterApiKey);
  if (openrouterApiKeys && Array.isArray(openrouterApiKeys)) {
    out.openrouterApiKeys = openrouterApiKeys.map((k) => encrypt(k));
  }
  if (nvidiaApiKey) out.nvidiaApiKey = encrypt(nvidiaApiKey);
  if (nvidiaApiKeys && Array.isArray(nvidiaApiKeys)) {
    out.nvidiaApiKeys = nvidiaApiKeys.map((k) => encrypt(k));
  }
  if (deepseekApiKey) out.deepseekApiKey = encrypt(deepseekApiKey);
  if (deepseekApiKeys && Array.isArray(deepseekApiKeys)) {
    out.deepseekApiKeys = deepseekApiKeys.map((k) => encrypt(k));
  }
  if (geminiApiKey) out.geminiApiKey = encrypt(geminiApiKey);
  if (geminiApiKeys && Array.isArray(geminiApiKeys)) {
    out.geminiApiKeys = geminiApiKeys.map((k) => encrypt(k));
  }
  if (groqApiKey) out.groqApiKey = encrypt(groqApiKey);
  if (groqApiKeys && Array.isArray(groqApiKeys)) {
    out.groqApiKeys = groqApiKeys.map((k) => encrypt(k));
  }
  if (ollamaApiKey) out.ollamaApiKey = encrypt(ollamaApiKey);
  if (openaiHeaders && typeof openaiHeaders === "object") {
    const encryptedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(openaiHeaders)) {
      encryptedHeaders[key] = typeof value === "string" ? encrypt(value) : value;
    }
    out.openaiHeaders = encryptedHeaders;
  }
  await writeFile(CONFIG_PATH, JSON.stringify(out, null, 2) + "\n");
}

/**
 * Assigns or appends API keys to an AgavConfig for a given provider.
 */
export function assignKeysToConfig(
  config: AgavConfig,
  provider: string,
  keys: string[],
  append: boolean = false,
): void {
  const norm = provider.toLowerCase().trim();
  const cleanKeys = keys.map((k) => k.trim()).filter((k) => k.length > 0);
  if (cleanKeys.length === 0) return;

  const update = (
    currentSingle?: string,
    currentMultiple?: string[],
  ): { single: string; multiple: string[] } => {
    let finalKeys = cleanKeys;
    if (append && currentMultiple && currentMultiple.length > 0) {
      const existing = new Set(currentMultiple);
      const toAdd = cleanKeys.filter((k) => !existing.has(k));
      finalKeys = [...currentMultiple, ...toAdd];
    }
    return { single: finalKeys[0], multiple: finalKeys };
  };

  switch (norm) {
    case "nvidia": {
      const res = update(config.nvidiaApiKey, config.nvidiaApiKeys);
      config.nvidiaApiKey = res.single;
      config.nvidiaApiKeys = res.multiple;
      break;
    }
    case "gemini": {
      const res = update(config.geminiApiKey, config.geminiApiKeys);
      config.geminiApiKey = res.single;
      config.geminiApiKeys = res.multiple;
      break;
    }
    case "groq": {
      const res = update(config.groqApiKey, config.groqApiKeys);
      config.groqApiKey = res.single;
      config.groqApiKeys = res.multiple;
      break;
    }
    case "openrouter": {
      const res = update(config.openrouterApiKey, config.openrouterApiKeys);
      config.openrouterApiKey = res.single;
      config.openrouterApiKeys = res.multiple;
      break;
    }
    case "deepseek": {
      const res = update(config.deepseekApiKey, config.deepseekApiKeys);
      config.deepseekApiKey = res.single;
      config.deepseekApiKeys = res.multiple;
      break;
    }
    case "openai": {
      const res = update(config.openaiApiKey, config.openaiApiKeys);
      config.openaiApiKey = res.single;
      config.openaiApiKeys = res.multiple;
      break;
    }
    case "anthropic": {
      const res = update(config.anthropicApiKey, config.anthropicApiKeys);
      config.anthropicApiKey = res.single;
      config.anthropicApiKeys = res.multiple;
      break;
    }
  }
}

/** Return the root directory used for Agav's global state files. */
export function getAgavDir(): string {
  return AGAV_DIR;
}
