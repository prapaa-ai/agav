import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import type { AgavConfig } from "../config/config.js";
import type { ConversationState } from "../agent/conversation.js";
import { getSharedCoordinator } from "../background-jobs-integration.js";
import { createSessionExecution } from "./runner.js";
import { launchSessionWorker } from "./launch.js";
import { SessionRuntimeStore } from "./store.js";

/** Start execution in its permanent owner before tools or model streaming begin. */
export async function startInteractiveSessionWorker(config: AgavConfig, conversation: ConversationState,
  options: { id?: string; previousGeneration?: string; permissionMode: AgavConfig["permissionMode"]; iterationsBudget: { remaining: number; total: number }; signal: AbortSignal; onCreated?: (record: import("./store.js").SessionRuntimeRecord) => void }) {
  if (config.backgroundJobsEnabled !== true) throw new Error("Detached execution requires backgroundJobsEnabled=true.");
  options.signal.throwIfAborted();
  // A worker reloads credentials, never serialized secret-bearing config. Refuse a transient
  // CLI credential override rather than launch against another account or silently drop it.
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
  // Publish ownership before admission: a lost launch response must never permit a second local loop.
  options.onCreated?.(record);
  const cliPath = await realpath(resolve(process.argv[1] ?? "")).catch(() => resolve(process.argv[1] ?? ""));
  // Only provider/policy environment is inherited. Values travel through the supervisor's private
  // environment channel, never through persisted descriptors or command-line arguments.
  const names = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "NVIDIA_API_KEY", "DEEPSEEK_API_KEY",
    "GEMINI_API_KEY", "OLLAMA_API_KEY", "OLLAMA_ENDPOINT", "OLLAMA_HOST", "OLLAMA_PORT", "VERTEX_AI_CREDENTIALS_PATH",
    "VERTEX_AI_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS", "AGAV_ORG_CONFIG", "ProgramData", "AGAV_NO_SANDBOX"].filter(name => process.env[name] !== undefined);
  options.signal.throwIfAborted();
  await launchSessionWorker(record, { store, coordinator: await getSharedCoordinator(), cliPath, envNames: names,
    // This grant launches only the internal owner of an already submitted interactive turn.
    // The persisted session policy, not this process-lifetime grant, governs every worker tool.
    session: { permissionMode: "auto-accept", headlessApprovedActions: ["start", "headless-start"], signal: options.signal },
  });
  return record;
}
