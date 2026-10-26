import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import type { AgavConfig } from "../config/config.js";
import { clampPermissionMode } from "../config/org-config.js";
import type { ConversationState } from "../agent/conversation.js";
import { getSharedCoordinator } from "../background-jobs-integration.js";
import { getPlatformAdapter } from "../background-jobs/platform/index.js";
import { normalizeLaunchSpec } from "../background-jobs/launch-spec/normalize.js";
import { hashLaunchSpecForConsent } from "../background-jobs/authorization/spec-hash.js";
import { createSessionExecution } from "./runner.js";
import { failSessionWorkerBeforeAdmission, launchSessionWorker, sessionWorkerStartRequest } from "./launch.js";
import { SessionRuntimeStore } from "./store.js";

/** Values use the supervisor's private channel, never persisted launch descriptors. */
export function sessionWorkerEnvironmentNames(): string[] {
  return ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS",
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "OPENROUTER_API_KEY",
    "NVIDIA_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY", "OLLAMA_API_KEY", "OLLAMA_ENDPOINT", "OLLAMA_HOST", "OLLAMA_PORT",
    "VERTEX_AI_CREDENTIALS_PATH", "VERTEX_AI_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "AGAV_ORG_CONFIG", "ProgramData", "AGAV_NO_SANDBOX"].filter(name => process.env[name] !== undefined);
}

/** Start execution in its permanent owner before tools or model streaming begin. */
export async function startInteractiveSessionWorker(config: AgavConfig, conversation: ConversationState,
  options: { id?: string; previousGeneration?: string; permissionMode: AgavConfig["permissionMode"]; iterationsBudget: { remaining: number; total: number }; signal: AbortSignal; onCreated?: (record: import("./store.js").SessionRuntimeRecord) => void }) {
  if (config.backgroundJobsEnabled !== true) throw new Error("Detached execution requires backgroundJobsEnabled=true.");
  // This dedicated host opt-in authorizes ONLY the submitted turn's process owner, not arbitrary
  // background commands and not worker tools. General background-job enablement is not consent.
  if (config.detachedSessionsEnabled !== true) {
    throw new Error("Detached execution requires detachedSessionsEnabled=true.");
  }
  options.signal.throwIfAborted();
  const { loadConfig } = await import("../config/config.js");
  const persisted = await loadConfig();
  const credentialKey = { anthropic: "anthropicApiKey", openai: "openaiApiKey", openrouter: "openrouterApiKey",
    nvidia: "nvidiaApiKey", deepseek: "deepseekApiKey", gemini: "geminiApiKey", ollama: "ollamaApiKey",
    "vertex-ai": "vertexAICredentialsPath" }[config.provider] as keyof AgavConfig;
  if (config[credentialKey] !== persisted[credentialKey]) {
    throw new Error("Background execution cannot reload this transient credential override. Configure the credential in the environment or saved config before starting the session.");
  }
  const store = new SessionRuntimeStore();
  const record = await createSessionExecution(store, config, { conversation, ...options });
  let coordinator: Awaited<ReturnType<typeof getSharedCoordinator>>;
  let cliPath: string;
  let names: string[];
  let expectedHash: string;
  try {
    // Publish ownership before admission: a lost response must never permit a second local loop.
    options.onCreated?.(record);
    options.signal.throwIfAborted();
    cliPath = await realpath(resolve(process.argv[1] ?? "")).catch(() => resolve(process.argv[1] ?? ""));
    names = sessionWorkerEnvironmentNames();
    coordinator = await getSharedCoordinator();
    const request = sessionWorkerStartRequest(record, cliPath, names);
    const adapter = await getPlatformAdapter();
    const capabilities = await adapter.detectCapabilities();
    const expected = await normalizeLaunchSpec({ ...request, headless: false, platform: adapter.platform,
      ownershipScope: capabilities.strongestOwnershipScope, canonicalizeCwd: path => adapter.canonicalizePath(path) });
    expectedHash = hashLaunchSpecForConsent(expected);
    options.signal.throwIfAborted();
  } catch (error) {
    throw await failSessionWorkerBeforeAdmission(store, record, error);
  }
  await launchSessionWorker(record, { store, coordinator, cliPath, envNames: names, interactiveOwner: true,
    // Ask authorization records a grant only for this exact executable/argv/cwd/environment/
    // isolation/limits/generation. No reusable auto-accept or headless-action grant is installed.
    // Keep restrictive caller and org policy intact, even for launching the internal owner.
    session: { permissionMode: clampPermissionMode(config.permissionMode, config.orgPermissionFloor) === "deny-writes" ? "deny-writes" : "ask",
      headlessApprovedActions: [], signal: options.signal,
      confirmBackgroundAction: async (action, spec) => action === "start" && !options.signal.aborted &&
        hashLaunchSpecForConsent(spec) === expectedHash },
  });
  return record;
}
