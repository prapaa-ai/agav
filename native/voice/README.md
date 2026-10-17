# Agav native voice helper (protocol 1)

`agav-voice` embeds whisper.cpp **v1.7.6** (MIT) and miniaudio **0.11.22**
(Unlicense / MIT-0). CMake downloads versioned archives and verifies their SHA256
hashes; dependency source and build artifacts belong outside the repository.
License copies accompany the executable via `cmake --install`. There is no
FFmpeg, whisper-cli, SDL, audio server SDK, or third-party runtime installation
step for end users. The Agav application is responsible for distributing this
helper and supplying its managed local English model; this directory does not
implement that application-side installer. Runtime never downloads anything.

## Build and microphone-free verification

Requires CMake >= 3.24, a C/C++17 toolchain, and internet during the initial build.
Python 3 is optional (enables protocol integration tests). From the repo root:

```sh
work=$(mktemp -d "${TMPDIR:-/tmp}/agav-voice.XXXXXX")
cmake -S native/voice -B "$work/out" -DCMAKE_BUILD_TYPE=Release
cmake --build "$work/out" --config Release --parallel 4
ctest --test-dir "$work/out" -C Release --output-on-failure
"$work/out/agav-voice" --protocol-version  # exactly: 1
"$work/out/agav-voice" --self-test
cmake --install "$work/out" --prefix "$work/install" --config Release
```

With Visual Studio's multi-configuration generator, the executable is under
`$work/out/Release/agav-voice.exe`. Use a separate build directory for each target
architecture. No generated files should be committed. A scoped patch skips
upstream Git provenance probing for version-pinned source archives without
changing inference code.

Default build: static whisper/ggml/miniaudio, `GGML_NATIVE=OFF`, portable CPU
fallback. x64 baseline enables SSE4.2 but not AVX/AVX2/FMA/F16C; the packaging
script additionally builds a separately gated optimized sibling. OpenMP and
external BLAS remain OFF. macOS defaults to Metal with embedded shaders and
Accelerate; disable Metal with `-DAGAV_VOICE_METAL=OFF` or select CPU at runtime
with `AGAV_VOICE_BACKEND=cpu`. ARM uses the platform baseline, not host-specific
`-mcpu=native`. OS audio services and system libraries remain required, but no
separate inference runtime is installed by users.
macOS embeds `NSMicrophoneUsageDescription` in the executable's `__info_plist`;
release signing/permissions must be handled by the Agav packager.

## CLI / parent contract

```text
agav-voice --protocol-version
agav-voice --supports-avx2  # baseline CPU/OS capability probe: 0 or 1
agav-voice --self-test
agav-voice --model /local/path/ggml-base.en.bin [--device "exact microphone name"]
agav-voice --input-wav /local/path/test.wav [--model /local/path/ggml-base.en.bin]
agav-voice --model /local/path/ggml-base.en.bin --persistent [--device "exact microphone name"]
agav-voice --model /local/path/ggml-base.en.bin --input-wav /local/path/test.wav --replay
```

Probe options must be used alone. Unknown, duplicate, missing and incompatible
options fail with an error event and nonzero exit. Device selection is an exact
miniaudio capture-device name, not FFmpeg device syntax. Omit it for the OS default;
ambiguous or missing explicit names fail. `--device` and `--input-wav` cannot mix.

Normal mode loads and validates the model **before** microphone initialization.
Multilingual models are rejected via `whisper_is_multilingual`; an English `.en`
model is required. Inference always uses `language="en"`, `detect_language=false`,
`translate=false`. The managed model remains English **base.en** (including
base.en-q5_1); these enhancements do not substitute tiny or download a model.
`AGAV_VOICE_THREADS` accepts decimal integers 1–16; the default is
`max(1, min(4, hardware_concurrency))`. Invalid values fail before model loading.
`AGAV_VOICE_BACKEND=auto|cpu` defaults to auto. Auto tries compiled-in Metal,
falling back to CPU if context initialization fails. A returned GPU inference
error (not cancellation) discards the context and retries that window once with
a freshly loaded CPU context; subsequent sessions reuse CPU. This cannot recover
from a GPU driver crash or a hung synchronous library call; parent deadlines and
process termination remain necessary. CPU-only builds use CPU in either mode.

Keep stdin open during the session. Send complete newline-terminated commands:

- `stop\n`: idempotently end capture and transcribe. Before capture is ready it
  prevents microphone opening and returns an error. Stop is not cancellation.
- `cancel\n`: abort, release microphone, emit a cancellation error, exit nonzero.
- `shutdown\n`: abort and exit (also accepted in single-shot mode).
- EOF: cancellation, including if EOF follows `stop` in the same pipe write.
- SIGINT/SIGTERM (and POSIX SIGHUP): cancellation. Inference checks an abort callback.
- Unknown lines or commands over 64 bytes: protocol error and cancellation.

No detached stdin reader is left behind; it polls and joins on shutdown. Native
model load and OS device initialization are synchronous and cannot be interrupted
inside their library calls. The parent must enforce bounded startup/inference
and termination deadlines, escalating to process termination if an OS/library
call does not return. The helper independently bounds first microphone audio to
10 seconds and capture to 120 seconds.

Protocol probe remains **1**. This is an additive protocol-1 extension: parents
must accept `partial` (or ignore it if not displaying drafts). stdout is flushed
newline-delimited JSON, serialized by one mutex across capture and inference,
with exactly these event fields:

```json
{"type":"phase","phase":"preparing"}
{"type":"phase","phase":"recording"}
{"type":"level","level":0.25}
{"type":"partial","text":"English draft so far"}
{"type":"phase","phase":"transcribing"}
{"type":"transcript","text":" English text."}
{"type":"error","message":"Human-readable failure."}
```

`recording` starts only after the first audio callback. Levels are DC-corrected
RMS scaled by 4, clamped to [0,1], at most once per 100 ms. Whisper/ggml diagnostics
go to stderr, never stdout. Transcript strings preserve UTF-8 and escape JSON
controls; the parent should sanitize text for terminal display. In single-shot
mode, exit 0 means one transcript was produced; nonzero means an error. Persistent
mode uses terminal events plus ready acknowledgment for each session. Probe stdout is the single `1`
line rather than JSON. No events follow the single-shot final transcript;
persistent mode follows each session transcript/error with ready. Both draft
and final UTF-8 strings are bounded to 48,000 bytes. Cancellation suppresses
subsequent drafts; stdin cancellation and draft emission share the output lock.
Signals are checked cooperatively (a write already in progress can finish).

## Incremental transcription and boundaries

### Optional persistent sessions

With `--persistent`, startup emits `preparing`, loads one English context, then
emits `{"type":"ready","protocol":1}`. No microphone opens before `start\n`.
Keep stdin open and wait for ready before sending another start. `--persistent`
requires `--model`, allows `--device`, and cannot combine with WAV or replay.

- `start\n` while idle starts a fresh audio buffer, capture device and worker;
  model/context remain warm. Session phases/partials/final events are unchanged.
- `stop\n` is idempotent for the active session. A stop before capture readiness
  returns an error without opening the microphone.
- `cancel\n` aborts the active session and joins inference, but does not kill
  the helper. Exactly one session `error` is followed by `ready`.
- Success emits `transcript`, then `ready`; failure emits `error`, then `ready`.
  Ready is emitted only after the worker is joined and the microphone closed.
- A duplicate start or unknown active-session command cancels that session with
  a protocol error, then ready. An idle invalid command emits error then ready.
  During initial model loading an invalid command emits error without ready.
- One shared polling reader owns stdin across sessions. Commands in each read
  batch are applied atomically: `start\ncancel\n` cannot lose cancellation;
  `start\ncancel\nstart\n` rejects the duplicate rather than queuing a future
  session. There is no command queue or implicit start after cancellation.
- EOF, shutdown, signals and an over-64-byte command terminate the helper;
  active inference observes cancellation and is joined. No ready follows
  shutdown. EOF/shutdown exit 0 in persistent mode unless startup itself failed.
- The helper exits after 60 seconds waiting idle for start (also after initial
  readiness). Parents may retire their pool earlier, e.g. after 30 seconds.

Persistent exit status describes the process, not each session: use terminal
`transcript`/`error` events for session results. The existing single-shot mode
still emits no ready, and exits 0 only for a transcript. Do not pipeline starts
or infer readiness from a terminal session event alone.

Capture and inference run concurrently: the miniaudio callback appends mono
float32 16 kHz audio to a fixed 1,920,000-sample (~7.7 MB, 120-second) buffer.
It allocates nothing, takes no mutex, and publishes only completed samples using
a release count; readers acquire that count before copying/reading an immutable
prefix. Audio is never written to disk. A single background worker exclusively
uses the single whisper context; neither the callback nor the main capture loop
runs inference. The worker copies at most 5 seconds (~0.32 MB) using a reusable reserved vector per inference.

After roughly one second of new audio, the worker decodes the current growing
chunk and emits `partial` **without waiting for Enter/stop**. Inference starts are paced at least
one second apart, rather than sleeping one second after inference completes. Actual
first-draft/update latency is the audio interval **plus model/CPU-dependent
inference time**; slow CPUs coalesce updates and can accumulate a backlog. This
is periodic bounded re-decoding, not token-by-token streaming or a guaranteed
one-second response. Silence may produce no draft; a changed draft can be empty.

Every `partial.text` is the **entire cumulative draft**, not a text delta. Parents
must reconcile snapshots rather than blindly appending the entire text; preserve
user-edited words separately from the recognition comparison baseline. The current chunk's wording can change.
At a maximum of 5 seconds the chunk is committed once to a stable prefix and the next chunk
starts at the next sample. Committed chunks are never replayed; identical words
spoken in different chunks are retained. Non-overlapping chunks deliberately
avoid algorithmic overlap duplication, but a word crossing a hard boundary can
be lost, split or misrecognized, and independent Whisper predictions can still
repeat words. A 400ms quiet tail (four 100ms energy windows) allows an earlier commit after
at least one second of audio; this is conservative pause alignment, not speech
VAD. There is no fuzzy text deduplication that might remove intentional repetition. Committed wording is
not revised by later audio. Accuracy/context can be worse than a full-recording
pass; that tradeoff keeps work and memory bounded.

On stop, device teardown first releases the mic/joins its callback, then the
main thread immediately emits `transcribing`, **before** waiting for inference
(the parent's stop-ack deadline is five seconds). An already running draft may
finish around this phase transition; parents should accept partials until the
final event. The worker reconciles the current chunk with any newly captured
tail, reuses a completed unchanged decode, and processes any backlog in at most
5-second chunks. It never unnecessarily re-decodes the whole 120 seconds. Final
latency still depends on CPU/backlog; OS device teardown itself is synchronous.
On cancellation or exception the worker's destructor sets its abort flag and
joins it before the context/audio/controls are destroyed. Whisper's abort
callback observes cancellation/shutdown; worker exceptions propagate to the
main thread as protocol errors.

Empty, <100 ms, DC-only or all-new 100ms windows below 100/32768 skip inference
to reduce silence hallucinations. Appended silence retains the current decoded
draft instead of decoding it again; any new window meeting the existing low
threshold, including quiet speech, triggers decoding. Unchanged sample prefixes
are never re-decoded; the same guard rejects an entirely inaudible recording.
This is an energy guard, not speech VAD.

`--input-wav` never initializes a microphone. It locally decodes WAV using
miniaudio and accepts only PCM16 mono 16 kHz, at most 120 seconds. Without a model
it supports reproducible silence/format/bounds validation: silent input reports
`No audible speech`; audible input reports that `--model` is required. For actual
WAV inference supply a model and keep stdin open (EOF cancels as in capture mode).
WAV input is decoded in the same bounded chunks after `transcribing`, without
simulating realtime mic capture.

`--self-test` needs neither model nor microphone. Besides JSON escaping, UTF-8,
RMS/silence/short-input and sample bounds, it drives the production stream worker
with synthetic audible PCM and an injected deterministic recognizer. It asserts
background-thread inference, drafts before stop, revision replacement, chunk
commit without duplicate prefix, tail reconciliation, 120-second input with
5-second decode limits, transcript size bounds, cooperative in-flight cancel,
RAII shutdown/join and exception propagation. Its stdout intentionally includes
`recording`, four `partial` events and `transcribing`, followed by the single
`self-test passed` transcript. `test/protocol.py` validates that sequence and
reads the first draft while stdin is still open without sending stop.

`--replay` feeds a validated WAV to the same stream worker at real-time speed,
with `recording`, zero or more `partial` events, `transcribing`, then one
`transcript` or `error`. It never opens a microphone. Keep stdin open; stop and
cancel work normally. Silence or identical drafts may yield no partial event;
this does not promise a partial for every input. The original non-replay WAV
mode still performs bounded final-only inference without real-time pacing.

`AGAV_VOICE_PROFILE=1` adds newline JSON telemetry to **stderr only**, alongside
upstream diagnostics. `type=profile`, `phase=readiness|inference`, `durationMs`,
`sampleEnd` (absolute end index of the decoded prefix), `context` (persistent or
single-shot), `threads`, and `backend` (cpu or metal) describe load readiness and
each decode. `cpuMs` records accumulated process CPU time and `peakRssBytes`
records peak RSS/working set (not GPU memory). A fallback decode duration includes CPU reload/retry. Telemetry is
opt-in, is not protocol stdout, and does not imply recognition accuracy.

No real microphone is used by tests in `test/protocol.py`. Most tests are
model-free; the warm-reuse test uses `AGAV_VOICE_TEST_MODEL` or an existing local
`~/.agav/voice/ggml-base.en-q5_1.bin`, and explicitly skips if absent. It sends
start+cancel, start+stop, and duplicate-start batches without opening a mic,
asserts error/ready ordering and EOF exit, and verifies only one readiness load.
A second optional local-model test replays synthetic WAV tones and verifies
phase/final-event ordering, without asserting recognition text. These tests
validate scheduling/lifecycle, not recognition accuracy or actual device/Whisper
latency. No model is downloaded by verification.

## x64 dispatch and packaging

Native x64 builds produce a safe SSE4.2 baseline plus a separate `.avx2` sibling with AVX2/FMA/F16C. The embedder includes both inside the main Agav binary. Runtime executes only the verified baseline `--supports-avx2` probe before selecting the optimized sibling; it checks CPUID, XSAVE/OSXSAVE and XCR0 XMM/YMM state. `AGAV_VOICE_CPU_BASELINE=1` suppresses optimized selection. ARM builds have no x64 sibling. Static separate binaries avoid ggml v1.7.6's shared-library requirements for its multi-variant backend loader. Baseline remains compatible with Bun's x64 baseline, not a globally host-native compile.

The helper now exceeds 2 MB when Metal shaders are included; size must be measured per build, not assumed from the former CPU-only helper. Model weights remain external. The build-only provenance patch prevents Git probing in pinned archive trees without changing inference code.
