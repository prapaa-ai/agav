---
title: Connect a Provider
description: Connect Agav to OpenAI, OpenRouter, NVIDIA NIM, DeepSeek, Anthropic, Gemini, Vertex AI, or Ollama
order: 3
---

# Connect a Provider

Agav needs one model provider. The easiest path is:

1. choose one provider
2. set its credential in the same terminal where you will start Agav
3. launch Agav with that provider and model
4. ask one read-only question to confirm it works

Anthropic is the default provider, with `claude-sonnet-5-5` on a fresh 0.2.9 configuration. If that provider is not configured, plain `agav` can select another configured cloud provider. Use `--provider ollama` for a local Ollama server; it is not discovered as a fallback. If you are not sure which provider to pick, use OpenAI, Anthropic, or Gemini if you already have an API key. Use OpenRouter if you want access to multiple providers behind a single key. Use NVIDIA NIM for NVIDIA-hosted models. Use DeepSeek for DeepSeek's own models. Use Ollama if you already have it installed, or [run a local model through an OpenAI-compatible server](/getting-started/local-models) with llama.cpp or LM Studio. Use Vertex AI if you already run on Google Cloud and want Gemini or Claude billed through that project.

## Fastest path

If you already have an OpenAI key, this is the quickest first run:

```bash
export OPENAI_API_KEY="your-key"
agav --provider openai --model gpt-5.4-mini --deny-writes
```

In Windows PowerShell:

```powershell
$env:OPENAI_API_KEY = 'your-key'
agav --provider openai --model gpt-5.4-mini --deny-writes
```

Use the same `$env:NAME = 'value'` pattern for other providers (`set "NAME=value"` in Command Prompt). These assignments affect the current shell and processes launched from it.

Then ask:

```text
What files are in this repository? Do not change anything.
```

## OpenAI

```bash
export OPENAI_API_KEY="your-key"
agav --provider openai --model gpt-5.4-mini
```

By default Agav uses the OpenAI Responses API. If you need the Chat Completions API instead (for example behind a proxy that only supports it), pass `--openai-api chat`:

```bash
agav --provider openai --model gpt-5.4-mini --openai-api chat
```

### Custom base URL (OpenAI-compatible endpoints)

Many services speak the OpenAI API without being OpenAI — private gateways, self-hosted deployments, LiteLLM/vLLM servers, or vendors that expose an OpenAI-compatible endpoint. Point the `openai` provider at one with `OPENAI_BASE_URL` instead of adding a dedicated provider:

```bash
export OPENAI_API_KEY="your-key"
export OPENAI_BASE_URL="https://my-gateway.example.com/v1"
agav --provider openai --model your-model
```

Or set it in `~/.agav/config.json`:

```json
{
  "provider": "openai",
  "model": "your-model",
  "openaiBaseURL": "https://my-gateway.example.com/v1"
}
```

The base URL applies only to the `openai` provider. An explicit `openaiBaseURL` takes precedence over the SDK's `OPENAI_BASE_URL` fallback. If neither is set and no managed gateway applies, requests go to OpenAI. Most OpenAI-compatible endpoints implement Chat Completions rather than the Responses API, so pair a custom base URL with `--openai-api chat` if requests fail.

For step-by-step examples with GGUF models in llama.cpp and GGUF or MLX models in LM Studio, see [Run Local Models](/getting-started/local-models).

If your gateway needs extra HTTP headers — a custom auth header, a tenant selector, or routing metadata — set `openaiHeaders` in `~/.agav/config.json`. They are sent with OpenAI-provider requests. Custom headers are not the encrypted API-key fields, so protect the user config if you put a token there:

```json
{
  "provider": "openai",
  "model": "your-model",
  "openaiBaseURL": "https://my-gateway.example.com/v1",
  "openaiHeaders": {
    "x-api-key": "gateway-token",
    "x-tenant": "team-a"
  }
}
```

## OpenRouter

[OpenRouter](https://openrouter.ai) aggregates multiple model providers behind a single API key. Set the key as an environment variable:

```bash
export OPENROUTER_API_KEY="sk-or-v1-..."
```

Start Agav with OpenRouter:

```bash
agav --provider openrouter
agav --provider openrouter --model openrouter/auto
```

The default model is `openrouter/auto`, which lets OpenRouter choose the best model for each request. You can also specify any model available on OpenRouter:

```bash
agav --provider openrouter --model anthropic/claude-sonnet-5.5
agav --provider openrouter --model openai/gpt-5.4-mini
```

Or set it in `~/.agav/config.json`:

```json
{
  "provider": "openrouter",
  "model": "openrouter/auto"
}
```

`/fast` and `/deep` switch models — see the table below for every provider's mapping.

## NVIDIA NIM

[NVIDIA NIM](https://build.nvidia.com) provides access to NVIDIA-hosted models through an OpenAI-compatible API. Set the API key:

```bash
export NVIDIA_API_KEY="nvapi-..."
```

Start Agav with NVIDIA NIM:

```bash
agav --provider nvidia
agav --provider nvidia --model nvidia/nemotron-3.5-lightning-30b-a3b
```

The default model is `nvidia/nemotron-3.5-lightning-30b-a3b`. All models use the `nvidia/` prefix:

```bash
agav --provider nvidia --model nvidia/llama-3.3-nemotron-super-49b-v1
```

Or set it in `~/.agav/config.json`:

```json
{
  "provider": "nvidia",
  "model": "nvidia/nemotron-3.5-lightning-30b-a3b"
}
```

Context window sizes are detected automatically from the NVIDIA API. The API base URL is `https://integrate.api.nvidia.com/v1`.

## DeepSeek

[DeepSeek](https://api-docs.deepseek.com) provides access to DeepSeek's own models through an OpenAI-compatible API. Set the API key:

```bash
export DEEPSEEK_API_KEY="sk-..."
```

Start Agav with DeepSeek:

```bash
agav --provider deepseek
agav --provider deepseek --model deepseek-v4-pro
```

The default model is `deepseek-v4-pro`. DeepSeek also offers `deepseek-v4-flash` for faster, lighter responses:

```bash
agav --provider deepseek --model deepseek-v4-flash
```

Or set it in `~/.agav/config.json`:

```json
{
  "provider": "deepseek",
  "model": "deepseek-v4-pro"
}
```

Context window sizes are detected automatically from the DeepSeek API. The API base URL is `https://api.deepseek.com`.

## Anthropic

```bash
export ANTHROPIC_API_KEY="your-key"
agav --provider anthropic --model claude-sonnet-5-5
```

## Google Gemini

```bash
export GEMINI_API_KEY="your-key"
agav --provider gemini --model gemini-3.5-flash-lite
```

## Vertex AI

Vertex AI authenticates with a Google Cloud service-account JSON file rather than an API key. Point Agav at the file, then select the provider:

```bash
export VERTEX_AI_CREDENTIALS_PATH=/path/to/service-account.json
agav --provider vertex-ai --model vertex/gemini-3.5-flash
```

On Windows PowerShell, use an absolute path and quote it, for example `$env:VERTEX_AI_CREDENTIALS_PATH = 'C:\Users\you\keys\service-account.json'`.

Setting the credentials path is what enables the provider; there is no separate on/off flag to keep in sync with it. Agav uses the multi-region `global` endpoint by default — set `VERTEX_AI_LOCATION` (for example `us-east5`) to pin a region instead, which some Claude partner models require.

Claude partner models are supported by the same provider and credentials, addressed with the same `vertex/` prefix. Use the model ID that Vertex AI exposes, including an `@YYYYMMDD` suffix when required by that model:

```bash
agav --provider vertex-ai --model vertex/claude-sonnet-4-5@20250929
```

Vertex AI `/deep` selects `vertex/claude-opus-5-5`, which requires `vertexAILocation` (or `VERTEX_AI_LOCATION`) to be `global`, `us`, or `eu`. With a regional location such as `us-east5`, `/deep` rejects the switch without changing your model or location. Configure a supported location explicitly, or use `/model` to choose a regional model.

The service account's `project_id`, `client_email`, `private_key`, and optional `token_uri` are read from the JSON file. Agav exchanges the signed credentials for a short-lived OAuth token and refreshes it automatically. Vertex AI's implicit Gemini caching and Claude's ephemeral prompt caching are used automatically when supported.

**Protect the key file.** The service-account JSON holds an unencrypted private key that can act as that service account against your entire Google Cloud project. Unlike the API keys Agav encrypts into `config.json`, this file is yours to secure: keep it outside the repository, `chmod 600` it (on Windows, use file properties to restrict access to your user account), and grant the service account only the `roles/aiplatform.user` role it actually needs.

## Ollama

Start Ollama and make sure at least one model is installed:

```bash
ollama list
agav --provider ollama
```

If no model is configured, Agav queries the default `http://localhost:11434` endpoint, starts with the first model returned, and names the other installed models. You can select one directly:

```bash
agav --provider ollama --model llama3.2
```

For a remote Ollama server, set `OLLAMA_ENDPOINT` and, when required, `OLLAMA_API_KEY`. Use the server root URL, not an `/api` or `/v1` path. `OLLAMA_HOST` and `OLLAMA_PORT` are alternatives when no full endpoint is configured. For hosted endpoints that require authentication for model discovery, pass `--model` explicitly: startup discovery queries `/api/tags` without an API key, even though the Ollama provider sends the key on its own requests.

Agav uses the model's reported context length up to a default cap of 32,768 tokens. Set `AGAV_OLLAMA_NUM_CTX` to change that cap; lowering it can help on memory-constrained machines.

## `/fast` and `/deep` models

Every provider has a preset for `/fast` (lightweight, quick answers) and `/deep` (most capable, complex reasoning):

| Provider | `/fast` | `/deep` |
| --- | --- | --- |
| Anthropic | `claude-haiku-5-5` | `claude-opus-5-5` |
| OpenAI | `gpt-6-luna` | `gpt-6.1-sol` |
| OpenRouter | `nvidia/nemotron-3.5-lightning:free` | `anthropic/claude-fable-5.1` |
| NVIDIA NIM | `nvidia/nemotron-3.5-bolt-e4b` | `nvidia/nemotron-3-ultra-550b-a55b` |
| DeepSeek | `deepseek-flash` | `deepseek-v4-pro` |
| Gemini | `gemini-3.8-flash` | `gemini-3.1-pro-preview` |
| Vertex AI | `vertex/gemini-3.8-flash` | `vertex/claude-opus-5-5` |
| Ollama | `gemma4:e4b` | `qwen3.8:27b` |

## Make it stick

If you do not want to pass `--provider` and `--model` every time, save defaults in your user config file:

- macOS or Linux: `~/.agav/config.json`
- Windows: `%USERPROFILE%\.agav\config.json` (`$HOME\.agav\config.json` in PowerShell)

Example:

```json
{
  "provider": "openai",
  "model": "gpt-5.4-mini"
}
```

Agav encrypts provider API-key fields with AES-256-GCM when it saves the user config. A manually entered plaintext key remains plaintext until Agav saves the file. Legacy `keychain:` references from older builds are not read; supply a fresh key through the environment or replace the reference in user config.

Two rules apply to keys stored in `config.json`:

- **Global only.** Keys must live in `~/.agav/config.json`, not a project's `./.agav/config.json`. Agav strips API keys (and endpoint overrides) from project config before using it, so a key placed in a repository is silently ignored. This protects you from a cloned repo redirecting your credentials.
- **Environment variables win.** If both the environment variable (e.g. `OPENAI_API_KEY`) and the `config.json` field are set, the environment variable is used. An empty overridden key can leave the provider unconfigured; when switching back to a saved key, remove the override rather than setting it to an empty string.

See [Provider credentials](/reference/configuration) in the configuration reference for the full field-to-variable mapping.

## Verify the connection

Start a session with tool writes restricted:

```bash
agav --provider openai --model gpt-5.4-mini --deny-writes
```

Replace the provider and model with your choice. Then ask:

```text
What files are in this repository? Do not change anything.
```

If Agav reports a missing key, confirm that the matching environment variable is set in the same terminal where you launched Agav. An explicitly selected provider will not silently use a different provider.

If the key is set but Agav still cannot connect:

- open a fresh terminal and set the variable again
- confirm the variable name matches the provider exactly
- for OpenRouter, confirm `OPENROUTER_API_KEY` is set and starts with `sk-or-v1-`
- for NVIDIA NIM, confirm `NVIDIA_API_KEY` is set and starts with `nvapi-`
- for Ollama, confirm the server is running and reachable
- for remote Ollama, confirm `OLLAMA_ENDPOINT`, or `OLLAMA_HOST` plus `OLLAMA_PORT`
- for Vertex AI, confirm `VERTEX_AI_CREDENTIALS_PATH` points at a readable service-account JSON file, and check `VERTEX_AI_LOCATION` if a Claude model requires a specific region

You can switch providers or models later with `/model`. To save defaults, see [configuration](/reference/configuration). Keep cloud API keys out of project configuration and version control.

Next: [complete your first repository task](/getting-started/quick-start).
