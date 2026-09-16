import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { loadConfig, type AgavConfig } from "../config/config.js";
import { deduplicateRepeatedPhrases, normalizeTechnicalTerms } from "./lexicon.js";
import type { STTEngine, STTResult, VoiceInputOptions } from "./types.js";
import { LocalWhisperEngine } from "./whisper-local.js";

export interface WhisperSTTEngineOptions {
  fetchFn?: typeof fetch;
  loadConfigFn?: () => Promise<AgavConfig>;
  localEngine?: LocalWhisperEngine | null;
}

export class WhisperSTTEngine implements STTEngine {
  private fetchFn: typeof fetch;
  private loadConfigFn: () => Promise<AgavConfig>;
  private localEngine: LocalWhisperEngine | null;

  constructor(options: WhisperSTTEngineOptions = {}) {
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.loadConfigFn = options.loadConfigFn || loadConfig;
    this.localEngine =
      options.localEngine !== undefined
        ? options.localEngine
        : new LocalWhisperEngine({ loadConfigFn: this.loadConfigFn });
  }

  public async transcribe(wavPath: string, options?: VoiceInputOptions): Promise<STTResult> {
    let config: Partial<AgavConfig> = {};
    try {
      config = await this.loadConfigFn();
    } catch {
      // Configuration file may not exist, continue with defaults/env
    }

    const providerReq = options?.provider;
    const apiKeyReq = options?.apiKey;

    // 1. If provider is "local" or no provider / apiKey specified: check local engine first
    const checkLocalFirst = providerReq === "local" || (!providerReq && !apiKeyReq);

    if (checkLocalFirst && this.localEngine) {
      const isLocalAvailable = await this.localEngine.isAvailable();
      if (isLocalAvailable) {
        return await this.localEngine.transcribe(wavPath, options);
      }
    }

    // 2. If local is not available or cloud provider was requested, resolve cloud config
    const { provider, apiKey, endpoint, model } = this.resolveProviderConfig(options, config);

    const fileBuffer = await readFile(wavPath);
    if (!fileBuffer || fileBuffer.length === 0) {
      throw new Error(`Audio file at ${wavPath} is empty or unreadable.`);
    }

    const blob = new Blob([fileBuffer], { type: "audio/wav" });
    const formData = new FormData();
    formData.append("file", blob, basename(wavPath) || "audio.wav");
    formData.append("model", model);

    if (options?.language) {
      formData.append("language", options.language);
    }
    if (options?.prompt) {
      formData.append("prompt", options.prompt);
    }

    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const startTime = Date.now();
    let response: Response;
    try {
      response = await this.fetchFn(endpoint, {
        method: "POST",
        headers,
        body: formData,
      });
    } catch (networkError: any) {
      throw new Error(
        `Failed to connect to Whisper API (${provider} at ${endpoint}): ${networkError.message || String(networkError)}`,
      );
    }

    if (!response.ok) {
      let errorDetail = "";
      try {
        const errorJson = (await response.json()) as any;
        errorDetail = errorJson?.error?.message || JSON.stringify(errorJson);
      } catch {
        errorDetail = await response.text().catch(() => response.statusText);
      }
      throw new Error(
        `Whisper transcription failed (${provider}, HTTP ${response.status}): ${errorDetail || response.statusText}`,
      );
    }

    const data = (await response.json()) as { text?: string };
    const durationMs = Date.now() - startTime;
    const rawText = (data.text || "").trim();
    const cleanText = normalizeTechnicalTerms(deduplicateRepeatedPhrases(rawText));

    return {
      text: cleanText,
      durationMs,
      provider,
      model,
    };
  }

  private resolveProviderConfig(
    options: VoiceInputOptions | undefined,
    config: Partial<AgavConfig>,
  ): { provider: string; apiKey: string; endpoint: string; model: string } {
    let provider = options?.provider;
    let apiKey = options?.apiKey;

    const groqKey = process.env.GROQ_API_KEY || (config as Record<string, any>).groqApiKey;
    const openaiKey = process.env.OPENAI_API_KEY || config.openaiApiKey;

    if (!provider) {
      if (apiKey) {
        provider = apiKey.startsWith("gsk_") ? "groq" : "openai";
      } else if (groqKey) {
        provider = "groq";
        apiKey = groqKey;
      } else if (openaiKey) {
        provider = "openai";
        apiKey = openaiKey;
      } else {
        throw new Error(
          "No API key found for Whisper transcription. Please set GROQ_API_KEY or OPENAI_API_KEY in your environment or ~/.agav/config.json. " +
            "Alternatively, configure local Whisper (install whisper-cli and ggml-model.bin or set AGAV_WHISPER_BIN and AGAV_WHISPER_MODEL).",
        );
      }
    }

    if (provider === "groq") {
      const finalKey = apiKey || groqKey;
      if (!finalKey) {
        throw new Error(
          "No Groq API key found. Please set GROQ_API_KEY in your environment or ~/.agav/config.json.",
        );
      }
      return {
        provider: "groq",
        apiKey: finalKey,
        endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
        model: "whisper-large-v3-turbo",
      };
    }

    if (provider === "openai") {
      const finalKey = apiKey || openaiKey;
      if (!finalKey) {
        throw new Error(
          "No OpenAI API key found. Please set OPENAI_API_KEY in your environment or ~/.agav/config.json.",
        );
      }
      const baseUrl = config.openaiBaseURL
        ? config.openaiBaseURL.replace(/\/+$/, "")
        : "https://api.openai.com/v1";
      return {
        provider: "openai",
        apiKey: finalKey,
        endpoint: `${baseUrl}/audio/transcriptions`,
        model: "whisper-1",
      };
    }

    if (provider === "local") {
      // Fallback for HTTP-compatible local Whisper server if configured
      const endpoint =
        process.env.LOCAL_WHISPER_URL || "http://127.0.0.1:8000/v1/audio/transcriptions";
      return {
        provider: "local",
        apiKey: apiKey || process.env.LOCAL_WHISPER_API_KEY || "",
        endpoint,
        model: "whisper-1",
      };
    }

    throw new Error(`Unsupported voice input provider: ${provider}`);
  }
}
