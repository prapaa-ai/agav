---
title: Run Local Models
description: Connect Agav to GGUF and MLX models served by llama.cpp or LM Studio over an OpenAI-compatible API
order: 6
---

# Run Local Models

Agav can use a local inference server that exposes an OpenAI-compatible Chat Completions API. Agav sends requests to the server; it does not load model files itself. `--provider openai` selects the API format, not the host. When the endpoint is on `127.0.0.1`, model requests go to your local server rather than OpenAI.

| What you want to run | Server | Base URL in these examples |
| --- | --- | --- |
| A GGUF model from the command line | `llama-server` from llama.cpp | `http://127.0.0.1:8080/v1` |
| A GGUF model in a desktop app | LM Studio | `http://127.0.0.1:1234/v1` |
| An MLX model on Apple Silicon | LM Studio with its MLX runtime | `http://127.0.0.1:1234/v1` |

Use [the Ollama provider](/getting-started/providers#ollama) instead if you already run Ollama. There are no separate Agav provider flags for llama.cpp, LM Studio, or MLX.

## Serve a GGUF model with llama.cpp

Install [llama.cpp](https://github.com/ggml-org/llama.cpp#getting-started) and download an instruction-tuned GGUF model that fits your machine. In one terminal, replace the model path and start [llama-server](https://github.com/ggml-org/llama.cpp/tree/master/tools/server):

```bash
llama-server -m "/path/to/model.gguf" --alias local-model --host 127.0.0.1 --port 8080
```

Leave the server running. In a second terminal, confirm that it lists `local-model`, then start Agav from your repository:

```bash
curl -fsS http://127.0.0.1:8080/v1/models

OPENAI_BASE_URL=http://127.0.0.1:8080/v1 OPENAI_API_KEY=local \
  agav --provider openai --openai-api chat --model local-model --deny-writes
```

`--alias local-model` sets the model ID used by the API. If you use a different alias or omit it, copy the `id` from the `/v1/models` response into `--model`.

## Serve a GGUF or MLX model with LM Studio

1. Install [LM Studio](https://lmstudio.ai/docs/app), download an instruction-tuned model, and load it. For MLX on an Apple Silicon Mac, choose the **MLX** version of the model, not the GGUF version. LM Studio runs the MLX runtime; the Agav settings are the same for both formats.
2. Open LM Studio's **Developer** tab and [start the local server](https://lmstudio.ai/docs/developer/core/server). Keep **Serve on Local Network** off for use on the same machine. The default port is `1234`; use the port shown in LM Studio if yours differs.
3. Copy the loaded model's API identifier from LM Studio or find its `id` in the [model list](https://lmstudio.ai/docs/developer/openai-compat/models). Replace `YOUR_MODEL_ID` with that exact identifier:

```bash
curl -fsS http://127.0.0.1:1234/v1/models

OPENAI_BASE_URL=http://127.0.0.1:1234/v1 OPENAI_API_KEY=local \
  agav --provider openai --openai-api chat --model 'YOUR_MODEL_ID' --deny-writes
```

In Windows PowerShell, set the environment variables before launching Agav. This example uses LM Studio's port; for llama.cpp, use `8080` and `local-model`:

```powershell
$env:OPENAI_BASE_URL = 'http://127.0.0.1:1234/v1'
$env:OPENAI_API_KEY = 'local'
agav --provider openai --openai-api chat --model 'YOUR_MODEL_ID' --deny-writes
```

## Authentication and saved defaults

Agav's `openai` provider requires a nonempty key. Use `local` only as a placeholder when your loopback server does not require authentication. If you enabled authentication, set `OPENAI_API_KEY` to the server's actual token and include `Authorization: Bearer <token>` on manual requests. Do not send your OpenAI cloud key to a local server. Keep an unauthenticated server bound to loopback.

To make local inference the default, merge these fields into your [user config](/reference/configuration) (`~/.agav/config.json` on macOS/Linux or `%USERPROFILE%\.agav\config.json` on Windows). The example uses llama.cpp; substitute the LM Studio URL and model ID if needed:

```json
{
  "provider": "openai",
  "model": "local-model",
  "openaiApi": "chat",
  "openaiBaseURL": "http://127.0.0.1:8080/v1"
}
```

Continue to supply `OPENAI_API_KEY` when you start Agav, or set `openaiApiKey` in your user config. Keep credentials and endpoint overrides out of the repository's `.agav/config.json`. If you also use hosted OpenAI, prefer the per-launch examples; a saved `openaiBaseURL` applies to all requests made through the `openai` provider, not just one model.

## Verify chat and tool calls

First ask Agav to respond with `ready` without using tools. Then ask it to list a few files in your repository without editing anything. Check that Agav shows an actual tool call, not merely a plausible answer. Basic chat working does not guarantee tool use: the server must return structured tool calls, and the model and its chat template must support them. See [llama.cpp function calling](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md) and [LM Studio tool use](https://lmstudio.ai/docs/developer/openai-compat/tools).

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Connection refused | Keep the inference server running, confirm the host and port, and try the `/v1/models` command from the same machine as Agav. |
| HTTP 404 or unknown model | Set the base URL to the server's `/v1` root, not `/v1/chat/completions` or LM Studio's `/api/v1`. Use `--openai-api chat` and the exact model ID returned by the server. |
| Missing OpenAI API key or HTTP 401 | Set a nonempty `OPENAI_API_KEY` in the terminal that launches Agav. If the server requires auth, use its token instead of `local`. |
| Requests reach a different server | Check your saved `openaiBaseURL` and any organization-managed gateway. An explicit base URL takes precedence over the SDK's `OPENAI_BASE_URL` fallback, and a managed gateway can pin the endpoint. |
| Chat works but tools don't | Try a model advertised for tool calling and its matching chat template. For llama.cpp, check that Jinja templates are enabled (`--jinja`) and that the template supports tools. |
| Context errors or the server runs out of memory | Check the server logs and its configured context size. Try a shorter session for context errors, or a smaller model or context size if memory is the limit. |
