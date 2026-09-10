---
title: Connect a Provider
description: Connect Agav to OpenAI, OpenRouter, NVIDIA NIM, Anthropic, Gemini, Vertex AI, or Ollama
order: 3
---

# Connect a Provider

Agav needs one model provider. The easiest path is:

1. choose one provider
2. set its credential in the same terminal where you will start Agav
3. launch Agav with that provider and model
4. ask one read-only question to confirm it works

The default provider is **Anthropic** — if you run `agav` with no flags and no config file, it will try to use Anthropic. If you are not sure which provider to pick, use OpenAI, Anthropic, or Gemini if you already have an API key. Use OpenRouter if you want access to multiple providers behind a single key. Use NVIDIA NIM for NVIDIA-hosted models. Use DeepSeek for DeepSeek's own models. Use Ollama if you want to run locally. Use Vertex AI if you already run on Google Cloud and want Gemini or Claude billed through that project.

## Fastest path

If you already have an OpenAI key, this is the quickest first run:

```bash
export OPENAI_API_KEY="your-key"
agav --provider openai --model gpt-5.4-mini --deny-writes
```

> **Windows:** Use `set OPENAI_API_KEY=your-key` in Command Prompt or `$env:OPENAI_API_KEY="your-key"` in PowerShell. All `export` commands on this page follow the same pattern.

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

The base URL applies only to the `openai` provider. When unset, Agav uses OpenAI's default endpoint. Most OpenAI-compatible endpoints implement Chat Completions rather than the Responses API, so pair a custom base URL with `--openai-api chat` if requests fail.

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
agav --provider openrouter --model anthropic/claude-sonnet-4-20250514
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
agav --provider anthropic --model claude-sonnet-4-20250514
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

Setting the credentials path is what enables the provider; there is no separate on/off flag to keep in sync with it. Agav uses the multi-region `global` endpoint by default — set `VERTEX_AI_LOCATION` (for example `us-east5`) to pin a region instead, which some Claude partner models require.

Claude partner models are supported by the same provider and credentials, addressed with the same `vertex/` prefix. Claude models need the versioned ID that Vertex AI exposes, including its `@YYYYMMDD` suffix:

```bash
agav --provider vertex-ai --model vertex/claude-sonnet-4-5@20250929
```

The service account's `project_id`, `client_email`, `private_key`, and optional `token_uri` are read from the JSON file. Agav exchanges the signed credentials for a short-lived OAuth token and refreshes it automatically. Vertex AI's implicit Gemini caching and Claude's ephemeral prompt caching are used automatically when supported.

**Protect the key file.** The service-account JSON holds an unencrypted private key that can act as that service account against your entire Google Cloud project. Unlike the API keys Agav encrypts into `config.json`, this file is yours to secure: keep it outside the repository, `chmod 600` it (on Windows, use file properties to restrict access to your user account), and grant the service account only the `roles/aiplatform.user` role it actually needs.

## Ollama

Start Ollama and make sure at least one model is installed:

```bash
ollama list
agav --provider ollama
```

Agav lists the models available at the default `http://localhost:11434` endpoint. You can also select one directly:

```bash
agav --provider ollama --model llama3.2
```

For a remote Ollama server, set `OLLAMA_ENDPOINT` and, when required, `OLLAMA_API_KEY`. If you prefer host and port separately, Agav also supports `OLLAMA_HOST` and `OLLAMA_PORT`.

Agav sizes the context window per model. Set `AGAV_OLLAMA_NUM_CTX` to override that cap when you know your hardware can take more.

## `/fast` and `/deep` models

Every provider except Ollama has a preset for `/fast` (lightweight, quick answers) and `/deep` (most capable, complex reasoning):

| Provider | `/fast` | `/deep` |
| --- | --- | --- |
| Anthropic | `claude-haiku-4-5-20251001` | `claude-sonnet-4-20250514` |
| OpenAI | `gpt-4o-mini` | `gpt-4o` |
| OpenRouter | `~google/gemini-flash-latest` | `~anthropic/claude-sonnet-latest` |
| NVIDIA NIM | `nvidia/nemotron-3.5-lightning-30b-a3b` | `nvidia/nemotron-3.5-lightning-30b-a3b` |
| DeepSeek | `deepseek-v4-flash` | `deepseek-v4-pro` |
| Gemini | `gemini-3.5-flash-lite` | `gemini-3.5-pro` |
| Vertex AI | `vertex/gemini-3.5-flash-lite` | `vertex/gemini-3.5-pro` |

Ollama has no preset — `/fast` and `/deep` fall back to the OpenAI defaults, which won't work on a local Ollama instance. Use `/model` to switch models manually instead.

## Make it stick

If you do not want to pass `--provider` and `--model` every time, save defaults in your user config file:

- macOS or Linux: `~/.agav/config.json`
- Windows: `%USERPROFILE%\\.agav\\config.json`

Example:

```json
{
  "provider": "openai",
  "model": "gpt-5.4-mini"
}
```

Agav can also store provider API keys directly in `config.json` — they are **encrypted at rest** with AES-256-GCM, so the file never contains plaintext secrets. Even so, environment variables are the safer choice on shared machines and less likely to end up in version control.

## Verify the connection

Start a read-only session in any repository:

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
