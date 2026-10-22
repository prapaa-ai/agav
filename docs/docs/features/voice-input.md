---
title: Voice Input
description: Dictate editable English prompts with Agav-managed local transcription
order: 10
---

# Voice Input

Run `/voice` in an idle interactive Agav session to speak instead of typing. Agav's native voice helper captures microphone audio and runs English-only Whisper locally. **No FFmpeg, whisper-cli, Python, package manager, sudo, or PATH changes are required.** Browser speech APIs and cloud transcription are not used.

## Interactive setup

The native helper is **embedded inside the Agav executable**, compressed as a bundled asset. On first use Agav verifies and extracts it to a private executable cache under `~/.agav/voice/runtime/<Agav version>/<platform-architecture>/`. Cached bytes are reverified, and corrupt files are replaced from the embedded payload without network access. License files are extracted alongside it.

Only the English model needs a download. If missing, `/voice` shows **Whisper base.en Q5**, its pinned Hugging Face URL and exact size **59,721,011 bytes (59.7 MB)**. Press **Y** or click **Y download** to approve; **N**, **Esc**, or **Ctrl+C** declines. Enter alone does not consent. Progress and cancellation are supported; size/SHA-256 checks and atomic publication protect installation. Downloads have a ten-minute timeout.

The model is saved at `~/.agav/voice/ggml-base.en-q5_1.bin` and reused across sessions/versions. After setup, the current voice request continues into recording. There is no helper metadata request, helper download, or separately published helper asset.

> **Windows:** `~/.agav/` paths resolve to `%USERPROFILE%\.agav\`.

**Developer builds:** normal `pnpm dev`, tests, typecheck and `pnpm build:binary` do not compile native voice code or require CMake/C++. Use **`pnpm build:binary --voice`** or **`pnpm build:binary:voice`** to explicitly compile and embed voice. A prebuilt helper can be supplied with `AGAV_VOICE_HELPER_PATH`, but is only used with `--voice`. Release CI always builds/embeds voice and fails if it cannot do so.

`pnpm build:binary:all` means **all targets and all features**, including voice. Supply prebuilt helpers for all five native targets in `AGAV_VOICE_HELPER_DIR` (`agav-voice-darwin-arm64`, `agav-voice-darwin-x64`, `agav-voice-linux-x64`, `agav-voice-linux-arm64`, `agav-voice-win32-x64.exe`). Both Windows variants reuse the Windows x64 helper. Missing helpers fail before compilation rather than silently omitting voice. CI obtains helpers on native runners.

`pnpm build:binary --all-features` enables every optional feature for the current native target; `--voice` enables only voice. Future optional features belong in the central all-feature selection. Plain source/default builds have no embedded helper; `/voice` requires a local helper override or a voice-enabled build. Build scripts restore the source stub on exit so generated payloads are not committed.

## Advanced local overrides

| Environment variable | Purpose |
| --- | --- |
| `AGAV_VOICE_MODEL` | Existing English-only whisper.cpp GGML `.en` model, readable regular file between 1 MiB and 4 GiB. Leading `~/` is expanded. |
| `AGAV_VOICE_HELPER_BIN` | Existing protocol-1 Agav native helper executable. Windows requires a native `.exe` or `.com`, not a shell/batch wrapper. |
| `AGAV_VOICE_DEVICE` | Optional exact microphone name; omitted uses the system default on every platform, including Windows. Ambiguous/missing names produce an error. |

Invalid explicit overrides produce errors rather than silently replacing them. Unset overrides to use the embedded helper and managed model. `AGAV_VOICE_WHISPER_BIN` and `AGAV_VOICE_FFMPEG_BIN` are no longer used. Language settings are not configurable.

Example for a development checkout:

```sh
export AGAV_VOICE_HELPER_BIN=/absolute/path/to/agav-voice
export AGAV_VOICE_MODEL=/absolute/path/to/ggml-base.en-q5_1.bin
agav
```

The helper links pinned whisper.cpp and miniaudio versions. See `native/voice/README.md` for its CMake build, model-free self-test, protocol tests, licenses, and optional microphone-free WAV validation. Build tooling is for maintainers only, not end-user setup. Native build artifacts belong outside the source tree.

## Microphone and platform support

The helper supports macOS ARM64/x64, Linux ARM64/x64, and Windows x64. Windows ARM64 uses x64 Agav under emulation. The helper uses system audio backends through miniaudio: Core Audio, WASAPI, and available Linux audio services such as PulseAudio/ALSA. No audio server SDK is required by the client, but a working host audio device/service must exist.

- **macOS:** allow microphone access for your terminal/helper in Privacy & Security → Microphone. The helper embeds a microphone-purpose description.
- **Windows:** allow desktop-app microphone access in privacy settings. The default microphone requires no device configuration.
- **Linux:** ensure your audio service/device is available to the current user.
- **SSH, WSL, containers:** capture occurs on the host running Agav; laptop microphone forwarding is not provided.

## English-only recording and review

1. Remove pending attachments and run `/voice` while idle.
2. Complete setup if prompted, then wait for **Listening**. The meter reflects real audio and shows elapsed time. Partial English transcripts appear live while speaking; the current draft can revise itself as more audio arrives.
3. New speech appears directly in the visible composer. You can type, delete and move the caret while recognition continues; incoming updates preserve your edits and do not send anything automatically.
4. Press **Enter** once to send the exact displayed draft after microphone cleanup; late recognition revisions do not alter what you chose to send.
5. Alternatively, click **Stop** to finish without sending, reconcile the final recognition result, then edit and submit normally. Recording is limited to two minutes.

The helper fixes recognition to English, keeps base.en Q5 (no tiny fallback), disables language detection/translation, and rejects multilingual model files. The default download is Whisper's `.en` variant. Recognized slash commands and shell text are never executed automatically.

**Esc**, **Ctrl+C**, or clicking **Cancel** discards recording or transcription. Keyboard release/repeat events are ignored by voice controls. Scheduled work is deferred during dictation; automated `/loop` requests cannot open the microphone. Typed input remains the fallback after errors.

Live recognition uses a background worker with start-to-start one-second scheduling and bounded five-second, pause-aware audio chunks, not a new pass over the whole recording for every update. Actual update latency depends on hardware/inference time and is not a guaranteed one-second response. Words at chunk boundaries may be misrecognized; review the final draft. Live text appears directly in the prompt. The composer remains editable during capture and finalization. Enter/Escape stay owned by voice controls; typing, deletion and navigation stay owned by the editor. Accepted speech is retained when recognition backtracks or returns an empty/shorter draft; matching cumulative extensions append new trailing words without replaying user-deleted words. Related recognition corrections rebase the speech comparison without replacing your visible wording, so later words can continue arriving. Unrelated rewrites are ignored rather than destructively replacing your draft. This favors stability over automatically correcting earlier recognition errors. Escape cancels a pending Enter send; helper failures preserve the draft and never send it. The ready hint disappears as soon as you edit.

Known Whisper annotations such as `[BLANK_AUDIO]`, `[music]` and `[silence]`
may remain visible during recording. They are removed when recording ends,
when you click Stop, or when you press Enter. The sent snapshot and final
recognition are cleaned; annotation-only drafts are never sent to the LLM.
Ordinary informational bracketed/code text is not stripped indiscriminately.

## Privacy and failure handling

The helper holds audio in a fixed, bounded memory buffer. Background inference runs during capture, and the microphone is released before final reconciliation/ready acknowledgment. Normal recording does not write WAV or transcript files. No raw audio is added to history or uploaded. The consented model download is setup traffic, not remote recognition; the helper is extracted locally without a download.

**Local recognition does not make the conversation offline:** explicitly submitted transcript text uses your configured LLM provider and normal session history.

Missing developer bundles, invalid English models/devices, permissions, silence, malformed helper events, protocol mismatch and timeouts produce visible diagnostics. Silence rejection is an energy guard, not neural VAD; recognition may still mishear background noise, so review drafts.

The parent owns the helper through protocol probing, capture and inference. Cancellation first requests cooperative shutdown, then escalates termination. If termination is not acknowledged, Agav reports uncertainty instead of claiming microphone release. Prefer direct helper binaries, not wrappers spawning descendants. Unavailable model filesystems or OS initialization calls can delay native shutdown until the parent deadline.

## Performance controls

Agav retains the helper/model context for up to **30 seconds between recordings**, while the microphone is closed whenever the helper acknowledges ready. Each start gets a fresh audio buffer and transcript state. Changing model/helper/device/thread/backend settings retires the old pool. UI teardown disposes it; the native process also exits after a 60-second idle limit.

- **macOS:** Metal with embedded shaders and Accelerate are built by default. Failed GPU initialization/inference can retry CPU; driver hangs still require parent deadlines. `AGAV_VOICE_BACKEND=cpu` forces CPU; `auto` is the default.
- **Windows/Linux/macOS x64:** the embedded baseline safely probes CPUID and OS AVX state before selecting a separately embedded AVX2/FMA/F16C helper. Unsupported CPUs use the baseline, never speculative AVX2 execution. `AGAV_VOICE_CPU_BASELINE=1` forces baseline. Prebuilt build overrides include an optional `.avx2` sibling; without it they remain baseline-only.
- **Threads:** `AGAV_VOICE_THREADS=1..16` overrides the default bounded four-thread setting. More threads are not always faster; benchmark representative hardware.
- **Profiling:** `AGAV_VOICE_PROFILE=1` emits timing JSON on stderr, without changing transcript stdout events or uploading audio.

The worker reuses a reserved decode buffer, skips silence-only/unchanged work conservatively, and commits at quiet tails or the five-second limit. It does not claim true incremental encoder caching. No ONNX dependency or smaller model is introduced.

For a microphone-free cold-process real-time replay benchmark:

```sh
node scripts/benchmark-voice.mjs --helper /path/to/agav-voice --model /path/to/ggml-base.en-q5_1.bin --wav /path/to/mono16k.wav --runs 5 --threads 4 --backend cpu
```

Compare `--backend auto` on macOS. Output records first partial/final timings and native inference/sample-position telemetry. Native profiling includes accumulated CPU milliseconds and peak resident/working-set bytes (GPU memory is not included); missing resource telemetry is reported as unavailable. The replay script does not label fresh-process replay as warm-session benchmarking.

## Validation status

Automated coverage includes protocol parsing, stream/output limits, cancellation/escalation, dependency probing, download size/hash verification, atomic installation, consent, stale results, mouse/keyboard controls, and English-only model selection. Native macOS ARM64 builds pass model-free self-tests and microphone-free protocol tests; x64 cross-compilation was checked separately. Native release jobs build, test and embed the matching helper into each main Agav binary.

Real microphone permissions/device behavior on every OS, actual coding-dictation accuracy, peak inference memory and latency remain release validation requirements. No real audio/model inference was performed during the model-free tests. Helper extraction works entirely offline from a correctly bundled binary; only initial model setup needs internet.
