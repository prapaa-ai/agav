import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "../utils/fs.js";
import { decrypt, encrypt, isEncrypted } from "../utils/encrypt.js";
import {
  isKeychainAvailable,
  isKeychainRef,
  keychainAccount,
  keychainRef,
  getSecret,
  setSecret,
  deleteSecret,
} from "../utils/keychain.js";
import { loadOrgPolicy, applyOrgConfig, applyGatewayToken } from "./org-config.js";

export type PermissionMode = "ask" | "auto-accept" | "deny-writes";
export type EffortLevel = "minimal" | "low" | "medium" | "high" | "max";

export const EFFORT_LEVELS: readonly EffortLevel[] = ["minimal", "low", "medium", "high", "max"];

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
  provider: "anthropic" | "openai" | "openrouter" | "nvidia" | "deepseek" | "ollama" | "gemini" | "vertex-ai";
  model: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openrouterApiKey?: string;
  nvidiaApiKey?: string;
  deepseekApiKey?: string;
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
  /** Customized footer layout (which segments show and their order). Reconciled
   * against the current catalog on use; see config/status-bar-layout.ts. */
  statusBar?: import("./status-bar-layout.js").StatusBarLayout;
  /** Opt-in; when unset or false, `run_background_job` and `/job` refuse to do anything. */
  backgroundJobsEnabled?: boolean;
  /** Global-only opt-in to foreground JSON workflows; also requires backgroundJobsEnabled. */
  workflowsEnabled?: boolean;
  /** Pool size for background workflow runner processes (separate from maxConcurrentJobs). Defaults to 2. */
  maxConcurrentWorkflowRuns?: number;
  /**
   * When true, `run_command` refuses to run if the effective sandbox backend
   * is "none". Defaults to false. Global-only: project config cannot set it
   * (listed in PROJECT_CONFIG_DENY) so a repository cannot disable it.
  */
 sandboxRequired?: boolean;
 /**
  * Master switch for headless background automation (`agav job tick` /
  * daemon). "paused" makes tick/daemon exit early. Defaults to "on".
  * Global-only (listed in PROJECT_CONFIG_DENY).
 */
  backgroundAutomation?: "on" | "paused";
  search?: boolean;
  /**
   * Organization policy (org tier) fields. Populated only when an admin ships an
   * org config; see config/org-config.ts. These take precedence over global,
   * project, and environment sources and the user cannot loosen them.
   */
  /** Models the org permits selecting; enforced at provider selection. */
  orgAllowedModels?: string[];
  /** Providers the org permits; enforced at provider selection. */
  orgAllowedProviders?: AgavConfig["provider"][];
  /** Control-plane address seeded by the org, used by a future `agav login`. */
  controlPlane?: string;
  /**
   * SIEM sink URL the org ships for audit events (sign-in/out). When set, the
   * CLI emits secret-free enrollment events to it best-effort; see
   * enterprise/audit.ts. Also settable via AGAV_AUDIT_SINK for local/dev use.
   */
  auditSink?: string;
  /**
   * Managed hard pins and permission floor recorded by applyOrgConfig. Unlike
   * the pinned `provider`/`model`/`permissionMode` values (which later startup
   * routing and interactive changes may overwrite), these are retained so every
   * boundary can re-enforce them. The user can never loosen them.
   */
  /** Provider the org hard-pinned; a chosen provider must equal it. */
  orgManagedProvider?: AgavConfig["provider"];
  /** Model the org hard-pinned; a chosen model must equal it. */
  orgManagedModel?: string;
  /** Loosest permission mode the org allows; the effective mode may only tighten. */
  orgPermissionFloor?: PermissionMode;
  /**
   * True when authentication to the OpenAI-compatible endpoint is provided by an
   * enrollment gateway token (injected as the Authorization header) rather than a
   * personal API key. Set by applyGatewayToken; lets credential validation and
   * provider construction treat the OpenAI key requirement as satisfied, so a
   * gateway-only enrolled developer needs no personal key.
   */
  openaiGatewayAuth?: boolean;
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

export const PROJECT_CONFIG_TEMPLATE = {
  provider: {
    description: "LLM provider used for new sessions.",
    enum: ["openai", "openrouter", "nvidia", "ollama", "anthropic", "gemini", "vertex-ai"],
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
    enum: ["minimal", "low", "medium", "high", "max"],
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
  backgroundJobsEnabled: {
    description: "Opt in to the background-jobs subsystem, enabling the run_background_job tool and /job command for launching, polling, tailing logs for, waiting on and stopping long-running commands outside the normal shell timeout and sandbox.",
    type: "boolean",
    eg: false,
  },
  workflowsEnabled: {
    description: "Opt in to foreground JSON workflows (tool, approval and job nodes). Also requires backgroundJobsEnabled. Global-only.",
    type: "boolean",
    eg: false,
  },
  maxConcurrentWorkflowRuns: {
    description: "Maximum number of background workflow runs executing at once; further runs wait as queued. Separate from the background-job pool.",
    type: "number",
    eg: 2,
  },
  sandboxRequired: {
    description: "Refuse to run shell commands when no sandbox backend is available. Only honored from the global config (~/.agav/config.json); ignored in project config.",
    type: "boolean",
    eg: false,
  },
  backgroundAutomation: {
    description: "Pause or resume headless background automation (agav job tick / daemon). Only honored from the global config (~/.agav/config.json); ignored in project config.",
    enum: ["on", "paused"],
    type: "string",
    eg: "on",
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
    description:
      "MCP server configurations keyed by the name shown inside Agav. " +
      "Add an optional `tools` array to a server to expose only those tools " +
      "(names as the server reports them, unprefixed); omit it to expose all.",
    type: "object",
    eg: {
      everything: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
        tools: ["echo", "add"],
      },
    },
  },
  search: {
    description: "Whether web search is enabled.",
    type: "boolean",
    eg: true,
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
  sandboxRequired: false,
  backgroundAutomation: "on",
  maxConcurrentWorkflowRuns: 2,
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
  "openaiApiKey",
  "openrouterApiKey",
  "nvidiaApiKey",
  "deepseekApiKey",
  "geminiApiKey",
  "permissionMode",
  // A repository must not be able to disable sandbox enforcement or
  // re-enable/pause headless automation (decisions D1, D8).
  "sandboxRequired",
  "backgroundAutomation",
  // Workflows are an opt-in automation surface; a repository must not enable them.
  "workflowsEnabled",
  // A project-supplied controlPlane would redirect `agav login` to post the
  // user's identity proof (id_token + nonce) to an attacker-controlled /session.
  // The control-plane address may come only from the --control-plane flag,
  // AGAV_CONTROL_PLANE, an admin-shipped org policy, or the built-in default.
  "controlPlane",
  // A project-supplied auditSink would redirect audit events to an
  // attacker-controlled endpoint (data exfiltration / tampering with the audit
  // trail). The sink may come only from AGAV_AUDIT_SINK or an admin-shipped org
  // policy.
  "auditSink",
  // Org-tier selection allowlists are admin-only; a project must not be able to
  // declare itself in-policy.
  "orgAllowedModels",
  "orgAllowedProviders",
  // Derived managed-constraint fields are set only by the trusted org-policy
  // overlay (applyOrgConfig). A project must not invent admin-only hard pins or a
  // permission floor, which would otherwise break ordinary startup/selection with
  // a bogus "organization requires…" error.
  "orgManagedProvider",
  "orgManagedModel",
  "orgPermissionFloor",
  // Trusted gateway-auth marker: set ONLY by applyGatewayToken from an
  // authenticated enrollment. A file-supplied value would let a repo pass
  // credential validation with no key and no enrollment, so it is stripped here
  // and also reset before the enrollment overlay runs (see loadConfig).
  "openaiGatewayAuth",
]);

/** Ignore invalid hand-edited values instead of passing unsupported effort levels to providers. */
function sanitizeConfig(merged: AgavConfig): void {
  if (!isEffortLevel(merged.effort)) {
    merged.effort = DEFAULT_CONFIG.effort;
  }
  if (!Number.isInteger(merged.maxIterations) || merged.maxIterations < 1) {
    merged.maxIterations = DEFAULT_CONFIG.maxIterations;
  }
  if (!Number.isInteger(merged.errorRetries) || merged.errorRetries < 0) {
    merged.errorRetries = DEFAULT_CONFIG.errorRetries;
  }
  if (merged.backgroundAutomation !== "on" && merged.backgroundAutomation !== "paused") {
    merged.backgroundAutomation = DEFAULT_CONFIG.backgroundAutomation;
  }
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
  if (typeof merged.sandboxRequired !== "boolean") {
    merged.sandboxRequired = DEFAULT_CONFIG.sandboxRequired;
  }
  if (!Number.isInteger(merged.maxConcurrentWorkflowRuns) || merged.maxConcurrentWorkflowRuns! < 1) {
    merged.maxConcurrentWorkflowRuns = DEFAULT_CONFIG.maxConcurrentWorkflowRuns;
  }
  if (merged.backgroundAutomation !== "on" && merged.backgroundAutomation !== "paused") {
    merged.backgroundAutomation = DEFAULT_CONFIG.backgroundAutomation;
  }
}

/**
 * Read-only global config (defaults + ~/.agav/config.json) for unattended
 * entry points. Never touches the cwd or creates files, and skips env/API-key
 * resolution.
 */
export async function loadGlobalConfig(): Promise<AgavConfig> {
  let globalConfig: Partial<AgavConfig> = {};
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    globalConfig = JSON.parse(raw);
  } catch {}
  const merged = deepMerge(
    { ...DEFAULT_CONFIG } as unknown as Record<string, unknown>,
    globalConfig as unknown as Record<string, unknown>,
  ) as unknown as AgavConfig;
  sanitizeConfig(merged);
  return merged;
}

/**
 * Decrypt a stored value to plaintext, returning undefined when it is an `enc:`
 * ciphertext that cannot be decrypted. decrypt() returns the ciphertext
 * unchanged on failure (e.g. a config restored under a different user/home, a
 * truncated value, or a different machine key); passing that raw `enc:...` blob
 * on to a provider would masquerade as an API key and fail at request time with
 * a confusing error. Treating it as "no key" surfaces the real problem (missing
 * credential) instead. A genuine plaintext value passes through untouched.
 */
function safeDecrypt(value: string): string | undefined {
  const plain = decrypt(value);
  if (isEncrypted(value) && isEncrypted(plain)) return undefined; // decryption failed
  return plain || undefined;
}

/**
 * Resolve a secret value read from a config file into its plaintext. A stored
 * value is one of:
 *   - a `keychain:` placeholder — the real secret lives in the OS credential
 *     store; look it up by account. On any store failure, return undefined so
 *     the provider reports a missing key rather than leaking the placeholder.
 *   - an `enc:` ciphertext or plaintext — safeDecrypt() handles both (file
 *     fallback), returning undefined on an undecryptable ciphertext.
 */
async function resolveStoredSecret(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  if (isKeychainRef(value)) {
    const secret = await getSecret(keychainAccount(value));
    return secret || undefined;
  }
  return safeDecrypt(value);
}

/**
 * Pick the highest-precedence API-key source and resolve it to plaintext. An
 * env var wins (and may itself be an enc: value a user exported); otherwise the
 * project file, then the global file, then the built-in default — each of which
 * may be a keychain: or enc: stored value.
 */
async function resolveApiKey(
  envValue: string | undefined,
  projectValue: string | undefined,
  globalValue: string | undefined,
  defaultValue: string | undefined,
): Promise<string | undefined> {
  if (envValue !== undefined) return safeDecrypt(envValue);
  return (await resolveStoredSecret(projectValue ?? globalValue ?? defaultValue)) || undefined;
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

  sanitizeConfig(merged);

  // Treat allowed tools as additive so projects can extend, not erase, a user's global allowlist.
  if (projectConfig.allowedTools) {
    merged.allowedTools = [
      ...(globalConfig.allowedTools ?? []),
      ...projectConfig.allowedTools,
    ];
  }

  // Resolve each API key once, preferring an env var, then the project file,
  // then the global file, then the built-in default. A stored value may be a
  // keychain: placeholder (secret lives in the OS credential store) or an enc:
  // ciphertext (file fallback); resolveStoredSecret handles both.
  merged.anthropicApiKey = await resolveApiKey(
    process.env["ANTHROPIC_API_KEY"],
    projectConfig.anthropicApiKey, globalConfig.anthropicApiKey, DEFAULT_CONFIG.anthropicApiKey,
  );
  merged.openaiApiKey = await resolveApiKey(
    process.env["OPENAI_API_KEY"],
    projectConfig.openaiApiKey, globalConfig.openaiApiKey, DEFAULT_CONFIG.openaiApiKey,
  );
  merged.openrouterApiKey = await resolveApiKey(
    process.env["OPENROUTER_API_KEY"],
    projectConfig.openrouterApiKey, globalConfig.openrouterApiKey, DEFAULT_CONFIG.openrouterApiKey,
  );
  merged.nvidiaApiKey = await resolveApiKey(
    process.env["NVIDIA_API_KEY"],
    projectConfig.nvidiaApiKey, globalConfig.nvidiaApiKey, DEFAULT_CONFIG.nvidiaApiKey,
  );
  merged.deepseekApiKey = await resolveApiKey(
    process.env["DEEPSEEK_API_KEY"],
    projectConfig.deepseekApiKey, globalConfig.deepseekApiKey, DEFAULT_CONFIG.deepseekApiKey,
  );
  merged.geminiApiKey = await resolveApiKey(
    process.env["GEMINI_API_KEY"],
    projectConfig.geminiApiKey, globalConfig.geminiApiKey, DEFAULT_CONFIG.geminiApiKey,
  );

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
  merged.ollamaApiKey = await resolveApiKey(
    process.env["OLLAMA_API_KEY"],
    projectConfig.ollamaApiKey, globalConfig.ollamaApiKey, DEFAULT_CONFIG.ollamaApiKey,
  );

  // Organization policy applies last so it overrides global, project, and env
  // sources alike. An admin's managed config is a non-overridable floor; the
  // user can tighten (e.g. a stricter permissionMode) but never loosen it.
  const org = await loadOrgPolicy();
  applyOrgConfig(merged, org.config);
  // openaiGatewayAuth is a trusted marker that must originate ONLY from an
  // authenticated enrollment. Reset any file-supplied value before the overlay so
  // neither project nor global config can forge it; applyGatewayToken re-sets it
  // when (and only when) it actually injects an enrollment token.
  merged.openaiGatewayAuth = undefined;
  // Inject the enrollment gateway token as the provider Authorization header so
  // live inference reaches the org gateway. Bound to the policy's own gateway URL
  // and an org-pinned Authorization header (which wins over the token).
  applyGatewayToken(merged, org.config, org.gatewayToken);

  return merged;
}

/** config.json account names for each API key stored in the OS credential store. */
const KEYCHAIN_ACCOUNTS = {
  anthropicApiKey: "anthropic-api-key",
  openaiApiKey: "openai-api-key",
  openrouterApiKey: "openrouter-api-key",
  nvidiaApiKey: "nvidia-api-key",
  deepseekApiKey: "deepseek-api-key",
  geminiApiKey: "gemini-api-key",
  ollamaApiKey: "ollama-api-key",
} as const;

/** Atomically write serialized config to the global config file (temp + rename, 0600). */
async function writeConfigAtomic(data: Record<string, unknown>): Promise<void> {
  await ensureDir(AGAV_DIR);
  const { randomBytes } = await import("node:crypto");
  const tmpPath = `${CONFIG_PATH}.tmp.${randomBytes(8).toString("hex")}`;
  const serialized = JSON.stringify(data, null, 2) + "\n";
  const { rename, unlink } = await import("node:fs/promises");
  try {
    await writeFile(tmpPath, serialized, { mode: 0o600, flag: "wx" });
    await rename(tmpPath, CONFIG_PATH);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/** Read the raw on-disk global config object, or {} when missing/corrupt. */
async function readStoredConfig(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Persist config to the global config file. API keys are stored in the OS
 * credential store when one is available (preferred), leaving only a
 * `keychain:` placeholder in config.json so the plaintext never touches the
 * file. When no store is available (e.g. a headless box without libsecret) we
 * fall back to the existing AES-encrypted-in-file representation.
 *
 * An absent/empty key field is NOT treated as a request to delete the stored
 * secret: a live AgavConfig can carry an undefined key purely because a
 * transient credential-store read failed during loadConfig, and deleting on
 * that would destroy a working credential. Instead the existing stored value
 * (keychain ref or enc: ciphertext) is preserved from the on-disk file. Use
 * clearStoredApiKey() for an explicit removal.
 */
export async function saveConfig(config: AgavConfig): Promise<void> {
  const { anthropicApiKey, openaiApiKey, openrouterApiKey, nvidiaApiKey, deepseekApiKey, geminiApiKey, ollamaApiKey, ...safe } = config;
  const out: Record<string, unknown> = { ...safe };

  const existing = await readStoredConfig();
  const keychain = await isKeychainAvailable();
  const keys: Array<[keyof typeof KEYCHAIN_ACCOUNTS, string | undefined]> = [
    ["anthropicApiKey", anthropicApiKey],
    ["openaiApiKey", openaiApiKey],
    ["openrouterApiKey", openrouterApiKey],
    ["nvidiaApiKey", nvidiaApiKey],
    ["deepseekApiKey", deepseekApiKey],
    ["geminiApiKey", geminiApiKey],
    ["ollamaApiKey", ollamaApiKey],
  ];

  for (const [field, value] of keys) {
    const account = KEYCHAIN_ACCOUNTS[field];
    if (!value) {
      // Absent/empty: preserve whatever is already persisted (never delete the
      // store entry here — see the docblock). If nothing was stored, leave the
      // field unset.
      const prior = existing[field];
      if (typeof prior === "string" && prior.length > 0) out[field] = prior;
      continue;
    }
    if (keychain && (await setSecret(account, value))) {
      out[field] = keychainRef(account);
    } else {
      // No store, or the store write failed: fall back to in-file encryption so
      // a save never silently loses the user's key.
      out[field] = encrypt(value);
    }
  }

  await writeConfigAtomic(out);
}

/**
 * Explicitly remove a provider API key: delete it from the OS credential store
 * (if present) and from the global config file. This is the deliberate counterpart
 * to saveConfig's non-destructive handling of absent fields.
 */
export async function clearStoredApiKey(field: keyof typeof KEYCHAIN_ACCOUNTS): Promise<void> {
  const account = KEYCHAIN_ACCOUNTS[field];
  if (await isKeychainAvailable()) {
    await deleteSecret(account);
  }
  const stored = await readStoredConfig();
  if (field in stored) {
    delete stored[field];
    await writeConfigAtomic(stored);
  }
}

/**
 * One-time, best-effort migration of existing in-file secrets into the OS
 * credential store. Run once at startup so users upgrading to the keychain-aware
 * build transition automatically on their next launch.
 *
 * It is a surgical read-rewrite of the global config.json — NOT a saveConfig():
 * saveConfig persists the live merged config, which carries env-derived keys and
 * CLI/session overrides that must never be baked into the file. Here we touch
 * only the API-key fields actually stored as `enc:` (or legacy plaintext) in the
 * file, replacing each with a `keychain:` placeholder after the secret lands in
 * the store. Every other key — and any already-migrated `keychain:` ref — is
 * written back verbatim.
 *
 * Safety properties:
 *   - No store available  → returns immediately; nothing is touched.
 *   - A per-key store write that fails leaves that key's `enc:` value in place,
 *     so a key is never lost and the user can still authenticate.
 *   - Nothing to migrate  → no write occurs (no needless config churn).
 *   - Atomic write (temp + rename, mode 0600) mirrors saveStatusBarLayout so a
 *     crash mid-write cannot truncate the config.
 *   - Never throws: a migration failure must not block startup.
 *
 * @returns the number of secrets moved into the store (0 when nothing changed).
 */
export async function migrateSecretsToKeychain(): Promise<number> {
  try {
    // Read the config FIRST and only probe the OS store if there is actually an
    // in-file secret to move. Detecting the store spawns a child process
    // (notably a cold PowerShell on Windows, ~hundreds of ms), so gating on a
    // cheap file read keeps steady-state startup — the vast majority of launches,
    // where keys are already migrated, set via env, or absent — free of any
    // subprocess. The probe (and migration) runs only on the one launch that has
    // real work to do.
    let snapshot: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
      if (typeof parsed !== "object" || parsed === null) return 0;
      snapshot = parsed as Record<string, unknown>;
    } catch {
      // Missing or corrupt config: nothing to migrate. Do not rewrite it.
      return 0;
    }

    // Decide what is migratable from the snapshot, decrypting up front so an
    // undecryptable `enc:` value (restored under a different user/home, or
    // corrupt) is skipped rather than stored verbatim as a bogus "secret".
    const pending: Array<{ field: string; account: string; plaintext: string }> = [];
    for (const [field, account] of Object.entries(KEYCHAIN_ACCOUNTS)) {
      const value = snapshot[field];
      if (typeof value !== "string" || value.length === 0) continue;
      if (isKeychainRef(value)) continue;
      const plaintext = safeDecrypt(value);
      if (!plaintext) continue; // empty or undecryptable — leave the file value as-is
      pending.push({ field, account, plaintext });
    }
    if (pending.length === 0) return 0;

    if (!(await isKeychainAvailable())) return 0;

    // Write each secret to the store first (the slow part). Only successfully
    // stored fields become placeholders.
    const placeholders = new Map<string, string>();
    for (const { field, account, plaintext } of pending) {
      if (await setSecret(account, plaintext)) {
        placeholders.set(field, keychainRef(account));
      }
      // On a failed store write, leave the existing file value untouched.
    }
    if (placeholders.size === 0) return 0;

    // Re-read the file immediately before writing and merge ONLY the migrated
    // key fields onto the fresh on-disk object. The store writes above can take
    // seconds; a concurrent writer (e.g. a session persisting statusBar) may
    // have changed unrelated keys in the meantime, and a blind rewrite of the
    // stale snapshot would clobber those edits. Merging onto the current file
    // preserves them; we only replace fields whose secret we actually moved, and
    // only when that field still holds the same pre-migration value (so we never
    // overwrite a key the user rotated during the window).
    let current: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
      current = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
    } catch {
      // The file vanished or became unreadable during migration; the secrets are
      // already safely stored. Skip the rewrite and let the next launch retry
      // (idempotent) rather than recreating a file from a stale snapshot.
      return placeholders.size;
    }

    let applied = 0;
    for (const [field, ref] of placeholders) {
      // Only replace the field if it still holds the exact value we migrated;
      // a different value means the user rotated the key concurrently, which a
      // later save/migration will handle.
      if (current[field] === snapshot[field]) {
        current[field] = ref;
        applied++;
      }
    }
    if (applied === 0) return placeholders.size;

    await ensureDir(AGAV_DIR);
    const { randomBytes } = await import("node:crypto");
    const tmpPath = `${CONFIG_PATH}.tmp.${randomBytes(8).toString("hex")}`;
    const serialized = JSON.stringify(current, null, 2) + "\n";
    const { rename, unlink } = await import("node:fs/promises");
    try {
      await writeFile(tmpPath, serialized, { mode: 0o600, flag: "wx" });
      await rename(tmpPath, CONFIG_PATH);
    } catch {
      await unlink(tmpPath).catch(() => {});
      // The secrets are already safely in the store; failing to rewrite the file
      // only means the next launch retries the migration (idempotent).
      return placeholders.size;
    }
    return applied;
  } catch {
    return 0;
  }
}

/**
 * Persist only the status bar layout to the global config file, preserving every
 * other key exactly as written on disk.
 *
 * This is deliberately a surgical read-merge-write rather than saveConfig(): the
 * live AgavConfig carries session-only overrides (CLI --model/--effort, decrypted
 * API keys, env-derived values) that must never be baked into config.json. We
 * reuse the raw stored object so already-encrypted API keys stay encrypted and
 * untouched. The write is atomic (temp file + rename) so a crash mid-write can
 * never leave a truncated, unparseable config.
 *
 * `undefined` removes the key, restoring the default footer.
 */
export async function saveStatusBarLayout(
  layout: import("./status-bar-layout.js").StatusBarLayout | undefined,
): Promise<void> {
  await ensureDir(AGAV_DIR);
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
    if (typeof stored !== "object" || stored === null) stored = {};
  } catch {
    // Missing or corrupt file: start from an empty object so we still persist
    // the layout rather than failing. A corrupt file is effectively replaced.
    stored = {};
  }
  if (layout === undefined) {
    delete stored.statusBar;
  } else {
    stored.statusBar = layout;
  }
  // Unpredictable temp name (random suffix, not the guessable pid) in the same
  // directory as the target so the final rename stays atomic on one filesystem.
  const { randomBytes } = await import("node:crypto");
  const tmpPath = `${CONFIG_PATH}.tmp.${randomBytes(8).toString("hex")}`;
  const serialized = JSON.stringify(stored, null, 2) + "\n";
  const { rename, unlink } = await import("node:fs/promises");
  // "wx" (O_CREAT | O_EXCL) refuses to open an existing path, so a pre-planted
  // symlink at tmpPath can never be followed; mode 0o600 keeps the config —
  // which may hold encrypted API keys — owner-only even before the rename.
  try {
    await writeFile(tmpPath, serialized, { mode: 0o600, flag: "wx" });
    await rename(tmpPath, CONFIG_PATH);
  } catch (err) {
    // Never leave an orphaned temp file behind on any failure.
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/** Return the root directory used for Agav's global state files. */
export function getAgavDir(): string {
  return AGAV_DIR;
}
