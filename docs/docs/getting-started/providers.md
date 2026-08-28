---
title: Connect a Provider
description: Connect Agav to OpenAI, Anthropic, Gemini, Vertex AI, or Ollama
order: 3
---

# Connect a Provider

Agav needs one model provider. The easiest path is:

1. choose one provider
2. set its credential in the same terminal where you will start Agav
3. launch Agav with that provider and model
4. ask one read-only question to confirm it works

If you are not sure which provider to pick, use OpenAI, Anthropic, or Gemini if you already have an API key. Use Ollama if you want to run locally. Use Vertex AI if you already run on Google Cloud and want Gemini or Claude billed through that project.

## Fastest path

If you already have an OpenAI key, this is the quickest first run:

```bash
export OPENAI_API_KEY="your-key"
agav --provider openai --model gpt-5.4-mini --deny-writes
```

Then ask:

```text
What files are in this repository? Do not change anything.
```

## OpenAI

```bash
export OPENAI_API_KEY="your-key"
agav --provider openai --model gpt-5.4-mini
```

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

The service account's `project_id`, `client_email`, `private_key`, and optional `token_uri` are read from the JSON file. Agav exchanges the signed credentials for a short-lived OAuth token and refreshes it automatically.

**Protect the key file.** The service-account JSON holds an unencrypted private key that can act as that service account against your entire Google Cloud project. Unlike the API keys Agav encrypts into `config.json`, this file is yours to secure: keep it outside the repository, `chmod 600` it, and grant the service account only the `roles/aiplatform.user` role it actually needs.

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

Keep cloud API keys in environment variables when possible. Agav can also read provider keys from config, but environment variables are safer for shared machines and less likely to end up in version control.

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
- for Ollama, confirm the server is running and reachable
- for remote Ollama, confirm `OLLAMA_ENDPOINT`, or `OLLAMA_HOST` plus `OLLAMA_PORT`
- for Vertex AI, confirm `VERTEX_AI_CREDENTIALS_PATH` points at a readable service-account JSON file, and check `VERTEX_AI_LOCATION` if a Claude model requires a specific region

You can switch providers or models later with `/model`. To save defaults, see [configuration](/reference/configuration). Keep cloud API keys out of project configuration and version control.

Next: [complete your first repository task](/getting-started/quick-start).
