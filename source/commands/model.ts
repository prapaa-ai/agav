import type { SlashCommand, CommandResult, CommandContext } from "./types.js"
import type { AgavConfig } from "../config/config.js";
import { providerSetupHints } from "../config/startup.js";
import { fetchVertexAIModels } from "../providers/vertex-ai.js";

export interface FetchedModel {
  id: string;
  provider: string;
}

async function fetchAnthropicModels(apiKey: string): Promise<FetchedModel[]> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { id: string }[] };
    return (data.data ?? [])
      .map((m) => ({ id: m.id, provider: "anthropic" }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

async function fetchOpenAIModels(apiKey: string): Promise<FetchedModel[]> {
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { id: string }[] };
    return (data.data ?? [])
      .filter((m) => /^(gpt-|o[0-9]|chatgpt)/.test(m.id) && !/transcribe|tts|realtime|image|search|embed|whisper|moderation|davinci|babbage|curie|instruct|ft:|audio/.test(m.id))
      .map((m) => ({ id: m.id, provider: "openai" }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

async function fetchOpenRouterModels(apiKey: string): Promise<FetchedModel[]> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { id: string }[] };
    return (data.data ?? [])
      .map((m) => ({ id: m.id, provider: "openrouter" }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

async function fetchNvidiaModels(apiKey: string): Promise<FetchedModel[]> {
  try {
    const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { id: string }[] };
    return (data.data ?? [])
      .map((m) => ({ id: m.id, provider: "nvidia" }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

async function fetchOllamaModels(baseUrl: string): Promise<FetchedModel[]> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? [])
      .map((m) => ({ id: m.name, provider: "ollama" }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

async function fetchGeminiModels(apiKey: string): Promise<FetchedModel[]> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    return (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => ({ id: m.name.replace("models/", ""), provider: "gemini" }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

async function fetchVertexModels(
  credentialsPath: string,
  location: string | undefined,
  warnings: string[],
): Promise<FetchedModel[]> {
  try {
    return (await fetchVertexAIModels(credentialsPath, location)).map((id) => ({ id, provider: "vertex-ai" }));
  } catch (error) {
    // Unlike the API-key providers, Vertex fails for reasons the user can act
    // on — an unreadable key file, a wrong region, a project without model
    // access. Swallowing that just shows a picker with no Vertex entries, which
    // reads as "this provider has no models" rather than "it is misconfigured".
    warnings.push(`Vertex AI models unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

interface FetchAllResult {
  models: FetchedModel[];
  /** Actionable problems to append to whatever the command reports back. */
  warnings: string[];
}

/** Match a requested model against catalog identifiers, including Vertex's prefix. */
export function findMatchingModels(models: FetchedModel[], model: string): FetchedModel[] {
  return models.filter((candidate) => candidate.id === model
    || (candidate.provider === "vertex-ai" && candidate.id === `vertex/${model}`)
    // OpenRouter persists routed model names as `vendor/model`; compare the
    // bare CLI name too, so `--model model` retains every eligible provider.
    || (candidate.provider === "openrouter" && candidate.id.endsWith(`/${model}`)));
}

/** Query every configured provider at once, in the order they appear in the picker. */
export async function fetchAvailableModels(config: AgavConfig): Promise<FetchAllResult> {
  const warnings: string[] = [];
  const fetches: Promise<FetchedModel[]>[] = [];

  if (config.anthropicApiKey) fetches.push(fetchAnthropicModels(config.anthropicApiKey));
  if (config.openaiApiKey) fetches.push(fetchOpenAIModels(config.openaiApiKey));
  if (config.openrouterApiKey) fetches.push(fetchOpenRouterModels(config.openrouterApiKey));
  if (config.nvidiaApiKey) fetches.push(fetchNvidiaModels(config.nvidiaApiKey));
  if (config.geminiApiKey) fetches.push(fetchGeminiModels(config.geminiApiKey));
  if (config.vertexAICredentialsPath) {
    fetches.push(fetchVertexModels(config.vertexAICredentialsPath, config.vertexAILocation, warnings));
  }

  const ollamaBase = config.ollamaEndpoint ??
    `http://${config.ollamaHost ?? "localhost"}:${config.ollamaPort ?? 11434}`;
  fetches.push(fetchOllamaModels(ollamaBase));

  const results = await Promise.all(fetches);
  return { models: results.flat(), warnings };
}

/** Render warnings as a trailing block, or nothing at all when there are none. */
function warningSuffix(warnings: string[]): string {
  return warnings.length > 0 ? `\n\n${warnings.join("\n")}` : "";
}

/** Whether a routed model slug belongs to the provider already in use. */
function matchesProviderPrefix(model: string, provider: string): boolean {
  const prefix = model.split("/", 1)[0]?.toLowerCase();
  if (provider === "anthropic" || provider === "openai") return prefix === provider;
  if (provider === "gemini" || provider === "vertex-ai") return prefix === "google";
  return false;
}

function pickModel(
  models: FetchedModel[],
  currentModel: string,
  currentProvider: string,
  title = "Select Model",
): Promise<FetchedModel | null> {
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  let selected = Math.max(0, models.findIndex((m) => m.id === currentModel));
  let filter = "";
  const pageSize = Math.min(models.length, process.stdout.rows ? process.stdout.rows - 8 : 15);
  const totalLines = pageSize + 5;
  let rendered = false;

  function getFiltered(): FetchedModel[] {
    if (!filter) return models;
    const lower = filter.toLowerCase();
    return models.filter((m) => m.id.toLowerCase().includes(lower) || m.provider.toLowerCase().includes(lower));
  }

  function clearLine() {
    process.stdout.write(`\x1b[2K`);
  }

  function render() {
    const filtered = getFiltered();
    if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1);

    if (rendered) {
      process.stdout.write(`\x1b[${totalLines}A`);
    }
    rendered = true;

    clearLine();
    process.stdout.write(`\x1b[1;36m  ${title}\x1b[0m\x1b[2m  (${filtered.length} of ${models.length})\x1b[0m\n`);
    clearLine();
    process.stdout.write(`\x1b[2m  ↑↓ navigate · Enter select · Type to filter · Esc cancel\x1b[0m\n`);
    clearLine();
    if (filter) {
      process.stdout.write(`\x1b[33m  Filter: ${filter}\x1b[0m\n`);
    } else {
      process.stdout.write("\n");
    }

    const scrollStart = Math.max(0, Math.min(selected - Math.floor(pageSize / 2), filtered.length - pageSize));
    const scrollEnd = Math.min(scrollStart + pageSize, filtered.length);

    for (let i = scrollStart; i < scrollEnd; i++) {
      const m = filtered[i]!;
      const isSel = i === selected;
      const active = m.id === currentModel ? " ◀" : "";
      const providerTag = m.provider !== currentProvider ? ` [${m.provider}]` : "";

      clearLine();
      if (isSel) {
        process.stdout.write(`\x1b[46;30m  ❯ ${m.id}${providerTag}${active} \x1b[0m\n`);
      } else {
        process.stdout.write(`\x1b[2m    ${m.id}${providerTag}${active}\x1b[0m\n`);
      }
    }

    for (let i = scrollEnd - scrollStart; i < pageSize; i++) {
      clearLine();
      process.stdout.write("\n");
    }

    clearLine();
    if (filtered.length > pageSize) {
      process.stdout.write(`\x1b[2m  ${scrollStart + 1}-${scrollEnd} of ${filtered.length}\x1b[0m\n`);
    } else {
      process.stdout.write("\n");
    }
    clearLine();
  }

  render();

  return new Promise((resolve) => {
    function cleanup() {
      stdin.setRawMode(wasRaw ?? false);
      stdin.removeListener("data", onData);
      stdin.pause();
      if (rendered) {
        process.stdout.write(`\x1b[${totalLines}A`);
        for (let i = 0; i < totalLines; i++) {
          process.stdout.write(`\x1b[2K\n`);
        }
        process.stdout.write(`\x1b[${totalLines}A`);
      }
    }

    function onData(data: Buffer) {
      const key = data.toString();
      const filtered = getFiltered();

      if (key === "\x1b" || key === "\x03") {
        cleanup();
        resolve(null);
        return;
      }

      if (key === "\r" || key === "\n") {
        if (filtered.length > 0 && filtered[selected]) {
          cleanup();
          resolve(filtered[selected]!);
        }
        return;
      }

      if (key === "\x1b[A" || key === "k") {
        selected = Math.max(0, selected - 1);
        render();
        return;
      }

      if (key === "\x1b[B" || key === "j") {
        selected = Math.min(filtered.length - 1, selected + 1);
        render();
        return;
      }

      if (key === "\x7f" || key === "\b") {
        if (filter.length > 0) {
          filter = filter.slice(0, -1);
          selected = 0;
          render();
        }
        return;
      }

      if (key.length === 1 && key >= " " && key <= "~") {
        filter += key;
        selected = 0;
        render();
        return;
      }
    }

    stdin.on("data", onData);
  });
}

export const modelCommand: SlashCommand = {
  name: "model",
  description: "Show or change the current model",
  usage: "Usage: /model [name]\n\n  /model                Open interactive model picker\n  /model gpt-5.4-mini   Switch to a specific model\n  /model gemini-3.5-pro  Auto-switches provider if needed",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const model = args.trim();

    if (model) {
      context.showStatus(`Validating model: ${model}...`);
      const { models: allModels, warnings } = await fetchAvailableModels(context.config);
      const matches = findMatchingModels(allModels, model);
      let match: FetchedModel | undefined = matches[0];
      let selectedFromAmbiguousMatches = false;

      if (matches.length > 1) {
        context.setPickerActive(true);
        const resumeTerminal = context.suspendTerminal();
        try {
          match = await pickModel(matches, model, context.config.provider, `Select provider for ${model}`) ?? undefined;
          selectedFromAmbiguousMatches = Boolean(match);
        } finally {
          resumeTerminal();
          context.setPickerActive(false);
        }
        context.refreshDisplay();
        if (!match) return { type: "message", text: `Kept model as ${context.config.model}${warningSuffix(warnings)}` };
      }

      if (!match && allModels.length > 0) {
        const close = allModels.filter((m) => m.id.includes(model) || model.includes(m.id)).slice(0, 3);
        const hint = close.length > 0 ? `\nDid you mean: ${close.map((m) => m.id).join(", ")}?` : "";
        // The warnings matter most here: a Vertex model looks "not found" when
        // the listing that would have contained it never came back.
        return {
          type: "message",
          text: `Model '${model}' not found.${hint}\nUse /model to browse available models.${warningSuffix(warnings)}`,
        };
      }

      const selectedModel = selectedFromAmbiguousMatches ? match!.id : model;
      context.setModel(selectedModel);
      if (match && match.provider !== context.config.provider
        && (selectedFromAmbiguousMatches || !matchesProviderPrefix(selectedModel, context.config.provider))) {
        context.setProvider(match.provider as import("../config/config.js").AgavConfig["provider"]);
        return { type: "message", text: `Model changed to: ${selectedModel} (switched to ${match.provider})` };
      }
      return { type: "message", text: `Model changed to: ${selectedModel}` };
    }

    context.showStatus("Fetching available models...");

    const currentModel = context.config.model;
    const currentProvider = context.config.provider;

    const { models: allModels, warnings } = await fetchAvailableModels(context.config);

    if (allModels.length === 0) {
      return {
        type: "message",
        text: `Current: ${currentModel} (${currentProvider})\n\nNo providers reachable.\n${providerSetupHints()}${warningSuffix(warnings)}`,
      };
    }

    context.setPickerActive(true);
    // Take the terminal before pickModel() writes its first line: it draws to
    // stdout directly, and an Ink frame committed on top would erase it.
    const resumeTerminal = context.suspendTerminal();
    let picked: FetchedModel | null;
    try {
      picked = await pickModel(allModels, currentModel, currentProvider);
    } finally {
      resumeTerminal();
      context.setPickerActive(false);
    }
    context.refreshDisplay();

    if (!picked) {
      return { type: "message", text: `Kept model as ${currentModel}${warningSuffix(warnings)}` };
    }

    context.setModel(picked.id);
    if (picked.provider !== currentProvider && !matchesProviderPrefix(picked.id, currentProvider)) {
      context.setProvider(picked.provider as AgavConfig["provider"]);
      return { type: "message", text: `Model changed to: ${picked.id} (switched to ${picked.provider})${warningSuffix(warnings)}` };
    }
    return { type: "message", text: `Model changed to: ${picked.id}${warningSuffix(warnings)}` };
  },
};
