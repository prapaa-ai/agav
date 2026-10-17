#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#endif
#include "miniaudio.h"
#include "whisper.h"
#include "cpu-features.h"
#include "ggml.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <exception>
#include <functional>
#include <mutex>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#ifdef _WIN32
#include <windows.h>
#include <shellapi.h>
#include <conio.h>
#include <psapi.h>
#else
#include <poll.h>
#include <unistd.h>
#include <sys/resource.h>
#endif

namespace {
constexpr size_t sample_rate = 16000;
constexpr size_t max_samples = 120 * sample_rate;
volatile std::sig_atomic_t interrupted = 0;
void signal_handler(int) { interrupted = 1; }

std::string json_string(const std::string &text) {
    std::string out = "\"";
    for (unsigned char c : text) {
        if (c == '"' || c == '\\') { out += '\\'; out += static_cast<char>(c); }
        else if (c < 32) {
            const char hex[] = "0123456789abcdef";
            out += "\\u00"; out += hex[c >> 4]; out += hex[c & 15];
        } else out += static_cast<char>(c);
    }
    return out + '"';
}
std::mutex output_mutex;
void event_unlocked(const char *type, const char *field, const std::string &value) {
    std::cout << "{\"type\":" << json_string(type) << ',' << json_string(field)
              << ':' << json_string(value) << "}\n" << std::flush;
}
void event(const char *type, const char *field, const std::string &value) {
    std::lock_guard<std::mutex> lock(output_mutex);
    event_unlocked(type, field, value);
}
void phase(const char *value) { event("phase", "phase", value); }
void check(bool ok, const char *message) { if (!ok) throw std::runtime_error(message); }

// All audio allocations have a fixed upper bound; the callback never allocates.
struct Audio {
    std::vector<float> samples = std::vector<float>(max_samples);
    std::atomic<size_t> count{0};
    void append(const float *input, size_t frames) {
        const size_t offset = count.load(std::memory_order_relaxed);
        const size_t take = std::min(frames, max_samples - offset);
        for (size_t i = 0; i < take; ++i) {
            const float x = input ? input[i] : 0;
            samples[offset + i] = std::isfinite(x) ? std::clamp(x, -1.0f, 1.0f) : 0;
        }
        count.store(offset + take, std::memory_order_release);
    }
};
double energy(const float *data, size_t count) {
    if (!count) return 0;
    double sum = 0, squares = 0;
    for (size_t i = 0; i < count; ++i) { sum += data[i]; squares += double(data[i]) * data[i]; }
    return std::sqrt(std::max(0.0, squares / count - (sum / count) * (sum / count)));
}
bool audible(const Audio &audio) {
    const size_t n = audio.count.load();
    return n >= sample_rate / 10 && energy(audio.samples.data(), n) >= 100.0 / 32768;
}

struct Resources { double cpu_ms = 0; unsigned long long peak_rss = 0; };
Resources resources() {
    Resources result;
#ifdef _WIN32
    FILETIME created{}, exited{}, kernel{}, user{};
    if (GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) {
        ULARGE_INTEGER k{}, u{}; k.LowPart = kernel.dwLowDateTime; k.HighPart = kernel.dwHighDateTime;
        u.LowPart = user.dwLowDateTime; u.HighPart = user.dwHighDateTime;
        result.cpu_ms = double(k.QuadPart + u.QuadPart) / 10000.0;
    }
    PROCESS_MEMORY_COUNTERS memory{};
    if (GetProcessMemoryInfo(GetCurrentProcess(), &memory, sizeof(memory))) result.peak_rss = memory.PeakWorkingSetSize;
#else
    rusage usage{};
    if (getrusage(RUSAGE_SELF, &usage) == 0) {
        result.cpu_ms = (usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) * 1000.0 +
            (usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1000.0;
#ifdef __APPLE__
        result.peak_rss = static_cast<unsigned long long>(usage.ru_maxrss);
#else
        result.peak_rss = static_cast<unsigned long long>(usage.ru_maxrss) * 1024;
#endif
    }
#endif
    return result;
}

void ready_unlocked() { std::cout << "{\"type\":\"ready\",\"protocol\":1}\n" << std::flush; }

// One reader survives all sessions. A whole read batch is applied under the
// output/state lock: start+cancel cannot reset cancellation when the main thread wakes.
class Controls {
    bool persistent, available = false, active = false, pending = false;
    std::atomic<bool> done{false};
    std::thread reader;
    void terminate() { cancelled = true; shutdown = true; }
    void eof() { std::lock_guard<std::mutex> lock(output_mutex); terminate(); }
    void command(const std::string &line) {
        if (line == "shutdown") { terminate(); return; }
        if (line == "start" && persistent && available && !active) {
            stopped = false; cancelled = false; invalid = false;
            active = true; pending = true;
        } else if (line == "stop" && active) stopped = true;
        else if (line == "cancel" && active) cancelled = true;
        else if (active) { invalid = true; cancelled = true; }
        else {
            event_unlocked("error", "message", "No active session or helper not ready; expected start or shutdown.");
            if (available) ready_unlocked();
        }
    }
    void read_commands() {
        std::string line;
        char buffer[256];
        while (!done.load() && !shutdown.load()) {
            int n = 0;
#ifdef _WIN32
            HANDLE handle = GetStdHandle(STD_INPUT_HANDLE);
            DWORD mode = 0;
            if (GetConsoleMode(handle, &mode)) {
                while (_kbhit() && n < int(sizeof(buffer))) {
                    int c = _getch(); buffer[n++] = c == '\r' ? '\n' : static_cast<char>(c);
                }
            } else {
                DWORD available_bytes = 0, read = 0;
                if (!PeekNamedPipe(handle, nullptr, 0, nullptr, &available_bytes, nullptr)) { eof(); break; }
                if (available_bytes && !ReadFile(handle, buffer, std::min<DWORD>(available_bytes, sizeof(buffer)), &read, nullptr)) { eof(); break; }
                n = static_cast<int>(read);
            }
#else
            pollfd fd{STDIN_FILENO, POLLIN, 0};
            const int result = poll(&fd, 1, 0);
            if (result < 0 && errno != EINTR) { eof(); break; }
            if (result > 0 && (fd.revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL))) {
                n = static_cast<int>(::read(STDIN_FILENO, buffer, sizeof(buffer)));
                if (n <= 0) { eof(); break; }
            }
#endif
            {
                std::lock_guard<std::mutex> lock(output_mutex);
                for (int i = 0; i < n && !shutdown.load(); ++i) {
                    if (buffer[i] == '\n') {
                        if (!line.empty() && line.back() == '\r') line.pop_back();
                        command(line); line.clear();
                    } else if (line.size() < 64) line += buffer[i];
                    else { invalid = true; terminate(); break; }
                }
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
    }
public:
    std::atomic<bool> stopped{false}, cancelled{false}, invalid{false}, shutdown{false};
    explicit Controls(bool reuse = false) : persistent(reuse), active(!reuse) {
        reader = std::thread([this] { read_commands(); });
    }
    ~Controls() { done = true; if (reader.joinable()) reader.join(); }
    bool abort() const { return cancelled.load() || shutdown.load() || interrupted; }
    void check_cancel() const {
        if (invalid.load()) throw std::runtime_error("Unsupported or duplicate stdin command; expected start, stop, cancel or shutdown.");
        if (abort()) throw std::runtime_error("Voice input cancelled.");
    }
    void ready() {
        std::lock_guard<std::mutex> lock(output_mutex);
        active = false; pending = false; available = true;
        stopped = false; cancelled = false; invalid = false;
        if (!shutdown && !interrupted) ready_unlocked();
    }
    bool wait_start() {
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(60);
        while (!shutdown && !interrupted) {
            { std::lock_guard<std::mutex> lock(output_mutex);
              if (pending) { pending = false; return true; } }
            if (std::chrono::steady_clock::now() >= deadline) { eof(); return false; }
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        return false;
    }
};

// Capture publishes immutable completed prefixes with release/acquire. Only this
// worker copies/decodes them; the callback takes no locks and never allocates.
class Stream {
public:
    using Abort = std::function<bool()>;
    using Recognize = std::function<std::string(const std::vector<float> &, const Abort &)>;
    using Partial = std::function<void(const std::string &)>;
    static constexpr size_t window = 5 * sample_rate;
    static constexpr size_t interim_threshold = sample_rate / 2;
private:
    Audio &audio;
    Abort cancelled;
    Recognize recognize;
    Partial partial;
    std::chrono::milliseconds cadence;
    std::atomic<bool> enabled{false}, finishing{false}, shutdown{false}, failed{false};
    std::exception_ptr failure;
    std::string result;
    size_t *sample_end;
    std::thread worker;

    static std::string combine(const std::string &prefix, const std::string &draft) {
        std::string text = prefix;
        const auto start = draft.find_first_not_of(" \r\n\t");
        if (start != std::string::npos) {
            if (!text.empty()) text += ' ';
            text += draft.substr(start);
            text.resize(text.find_last_not_of(" \r\n\t") + 1);
        }
        check(text.size() <= 48000, "Transcript exceeds the 48 KB limit.");
        return text;
    }
    void run() {
        try {
            size_t begin = 0, decoded = 0;
            std::vector<float> samples;
            samples.reserve(window);
            std::string stable, draft, previous;
            auto last = std::chrono::steady_clock::now() - cadence;
            const Abort abort = [this] { return shutdown.load() || cancelled(); };
            for (;;) {
                if (abort()) return;
                if (!enabled.load()) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(10));
                    continue;
                }
                const bool final = finishing.load();
                const size_t n = audio.count.load(std::memory_order_acquire);
                size_t end = std::min(n, begin + window);
                // Commit at a 400ms quiet tail after at least a second. Inspect
                // 100ms blocks individually so DC correction cannot hide a pause.
                bool pause = end - begin >= sample_rate && end - begin >= 6400;
                for (size_t i = end - std::min(end - begin, size_t(6400)); pause && i < end; i += 1600)
                    pause = energy(audio.samples.data() + i, std::min(size_t(1600), end - i)) < 100.0 / 32768;
                const auto now = std::chrono::steady_clock::now();
                // Sample and wall clocks bound update rate; slow inference coalesces
                // updates. Start after a half-second of new audio so short
                // utterances can reach the prompt before Enter/Stop. Backlogs
                // use bounded, non-overlapping chunks, not 120s passes.
                if (end > decoded && (final ||
                    ((end - decoded >= interim_threshold || pause || end == begin + window) && now - last >= cadence))) {
                    last = now; // start-to-start cadence, not inference-end-to-start
                    // New silence cannot change a previously decoded speech draft.
                    // Use the existing conservative energy threshold, never a louder VAD.
                    bool new_speech = false;
                    for (size_t i = decoded; i < end && !new_speech; i += 1600)
                        new_speech = energy(audio.samples.data() + i, std::min(size_t(1600), end - i)) >= 100.0 / 32768;
                    if (decoded == begin || new_speech) {
                        samples.assign(audio.samples.begin() + begin, audio.samples.begin() + end);
                        draft.clear();
                        if (samples.size() >= sample_rate / 10 && new_speech)
                            { if (sample_end) *sample_end = end; draft = recognize(samples, abort); }
                    }
                    if (abort()) return;
                    decoded = end;
                    const std::string text = combine(stable, draft);
                    if (!final && text != previous) {
                        partial(text);
                        previous = text;
                    }
                }
                if (decoded > begin && (decoded == begin + window || (pause && decoded == end))) {
                    stable = combine(stable, draft);
                    begin = decoded;
                    draft.clear();
                }
                if (final && decoded == n) {
                    result = combine(stable, draft);
                    return;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            }
        } catch (...) {
            failure = std::current_exception();
            failed.store(true, std::memory_order_release);
        }
    }
public:
    Stream(Audio &a, Abort abort, Recognize decode, Partial emit,
           std::chrono::milliseconds interval = std::chrono::seconds(1), size_t *end = nullptr)
        : audio(a), cancelled(std::move(abort)), recognize(std::move(decode)),
          partial(std::move(emit)), cadence(interval), sample_end(end), worker([this] { run(); }) {}
    Stream(const Stream &) = delete;
    Stream &operator=(const Stream &) = delete;
    ~Stream() { shutdown = true; if (worker.joinable()) worker.join(); }
    void start() { enabled = true; }
    void check_failure() const {
        if (failed.load(std::memory_order_acquire)) std::rethrow_exception(failure);
    }
    std::string finish() {
        finishing = true;
        enabled = true;
        if (worker.joinable()) worker.join();
        check_failure();
        return result;
    }
};

void capture_callback(ma_device *device, void *, const void *input, ma_uint32 frames) {
    static_cast<Audio *>(device->pUserData)->append(static_cast<const float *>(input), frames);
}
struct Microphone {
    ma_context context{};
    ma_device device{};
    bool context_ready = false, device_ready = false;
    ~Microphone() {
        if (device_ready) ma_device_uninit(&device);
        if (context_ready) ma_context_uninit(&context);
    }
};
void capture(Audio &audio, Controls &controls, const std::string &name, Stream &stream) {
    controls.check_cancel();
    check(!controls.stopped, "No audio recorded: stopped before microphone capture was ready.");
    Microphone mic;
    check(ma_context_init(nullptr, 0, nullptr, &mic.context) == MA_SUCCESS, "Cannot initialize microphone audio backend.");
    mic.context_ready = true;
    ma_device_id selected{};
    auto config = ma_device_config_init(ma_device_type_capture);
    if (!name.empty()) {
        ma_device_info *devices = nullptr;
        ma_uint32 count = 0;
        check(ma_context_get_devices(&mic.context, nullptr, nullptr, &devices, &count) == MA_SUCCESS, "Cannot enumerate microphones.");
        bool found = false;
        for (ma_uint32 i = 0; i < count; ++i) {
            if (name == devices[i].name) {
                check(!found, "Microphone name is ambiguous; use the system default instead.");
                selected = devices[i].id; found = true;
            }
        }
        check(found, "Requested microphone name not found.");
        config.capture.pDeviceID = &selected;
    }
    config.capture.format = ma_format_f32;
    config.capture.channels = 1;
    config.sampleRate = sample_rate;
    config.dataCallback = capture_callback;
    config.pUserData = &audio;
    controls.check_cancel();
    check(!controls.stopped, "No audio recorded: stopped before microphone capture was ready.");
    check(ma_device_init(&mic.context, &config, &mic.device) == MA_SUCCESS, "Cannot open microphone. Check microphone permissions and device selection.");
    mic.device_ready = true;
    controls.check_cancel();
    check(ma_device_start(&mic.device) == MA_SUCCESS, "Cannot start microphone. Check microphone permissions.");
    const auto start = std::chrono::steady_clock::now();
    auto last_level = start;
    bool recording = false;
    while (!controls.abort() && !controls.stopped && audio.count.load() < max_samples) {
        stream.check_failure();
        const auto now = std::chrono::steady_clock::now();
        const size_t n = audio.count.load(std::memory_order_acquire);
        if (n && !recording) { phase("recording"); recording = true; stream.start(); }
        if (recording && now - last_level >= std::chrono::milliseconds(100)) {
            const size_t begin = n > 1600 ? n - 1600 : 0;
            const double level = std::clamp(energy(audio.samples.data() + begin, n - begin) * 4, 0.0, 1.0);
            std::lock_guard<std::mutex> lock(output_mutex);
            if (!controls.abort())
                std::cout << "{\"type\":\"level\",\"level\":" << level << "}\n" << std::flush;
            last_level = now;
        }
        check(n || now - start < std::chrono::seconds(10), "Microphone startup timed out: no audio arrived within 10 seconds.");
        if (now - start >= std::chrono::seconds(120)) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    // Destructor releases the device and joins its callback before stop acknowledgement.
}

void read_wav(const std::string &path, Audio &audio) {
    ma_decoder decoder{};
    auto config = ma_decoder_config_init(ma_format_unknown, 0, 0);
    config.encodingFormat = ma_encoding_format_wav;
    check(ma_decoder_init_file(path.c_str(), &config, &decoder) == MA_SUCCESS, "Cannot decode input WAV.");
    struct Cleanup { ma_decoder *p; ~Cleanup() { ma_decoder_uninit(p); } } cleanup{&decoder};
    ma_format format{};
    ma_uint32 channels = 0, rate = 0;
    check(ma_decoder_get_data_format(&decoder, &format, &channels, &rate, nullptr, 0) == MA_SUCCESS
          && format == ma_format_s16 && channels == 1 && rate == sample_rate,
          "Input WAV must be PCM16 mono 16000 Hz.");
    ma_uint64 length = 0;
    check(ma_decoder_get_length_in_pcm_frames(&decoder, &length) == MA_SUCCESS && length <= max_samples,
          "Input WAV exceeds the 120 second limit or has an invalid length.");
    ma_int16 data[4096];
    float converted[4096];
    for (;;) {
        ma_uint64 count = 0;
        const auto result = ma_decoder_read_pcm_frames(&decoder, data, 4096, &count);
        check(result == MA_SUCCESS || result == MA_AT_END, "Cannot read input WAV samples.");
        check(count <= max_samples - audio.count.load(), "Input WAV exceeds the 120 second limit.");
        for (size_t i = 0; i < count; ++i) converted[i] = data[i] / 32768.0f;
        audio.append(converted, static_cast<size_t>(count));
        if (!count || result == MA_AT_END) break;
    }
    check(audio.count.load() == length, "Input WAV is truncated.");
}

void self_test() {
    check(json_string(std::string("\"\\\n\r\t\0", 6)) == "\"\\\"\\\\\\u000a\\u000d\\u0009\\u0000\"", "JSON encoding self-test failed.");
    check(json_string("English / 世界") == "\"English / 世界\"", "UTF-8 self-test failed.");
    Audio audio;
    check(!audible(audio), "Empty audio self-test failed.");
    float dc[1600]; std::fill_n(dc, 1600, 0.5f); audio.append(dc, 1600);
    check(!audible(audio), "DC silence self-test failed.");
    for (size_t i = 0; i < 1600; ++i) dc[i] = i % 2 ? 0.1f : -0.1f;
    audio.count = 0; audio.append(dc, 1599);
    check(!audible(audio), "Short audio self-test failed.");
    audio.count = 0; audio.append(dc, 1600);
    check(audible(audio), "Audible audio self-test failed.");
    audio.count = max_samples - 1;
    audio.append(dc, 1600); audio.append(dc, 1600);
    check(audio.count == max_samples, "Audio bounds self-test failed.");
    // Exercise the real worker/scheduler with synthetic audible PCM, never a mic.
    const auto wait = [](const std::function<bool()> &ready) {
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(4);
        while (!ready()) {
            check(std::chrono::steady_clock::now() < deadline, "Streaming self-test timed out.");
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
    };
    audio.count = 0;
    std::vector<float> second(sample_rate);
    for (size_t i = 0; i < second.size(); ++i) second[i] = i % 2 ? 0.1f : -0.1f;
    std::atomic<int> updates{0};
    std::atomic<size_t> calls{0};
    std::mutex drafts_mutex;
    std::vector<std::string> drafts;
    const auto main_thread = std::this_thread::get_id();
    phase("recording");
    Stream streaming(audio, [] { return false; },
        [&](const std::vector<float> &pcm, const Stream::Abort &) {
            check(std::this_thread::get_id() != main_thread, "Inference ran on capture thread.");
            check(pcm.size() <= Stream::window && energy(pcm.data(), pcm.size()) > 0.09,
                  "Streaming window/published audio self-test failed.");
            ++calls;
            return std::string(" draft-") + std::to_string(pcm.size());
        }, [&](const std::string &text) {
            { std::lock_guard<std::mutex> lock(drafts_mutex); drafts.push_back(text); }
            event("partial", "text", text);
            ++updates;
        }, std::chrono::milliseconds(10));
    streaming.start();
    audio.append(second.data(), second.size());
    wait([&] { streaming.check_failure(); return updates.load() == 1; });
    audio.append(second.data(), second.size());
    wait([&] { streaming.check_failure(); return updates.load() == 2; });
    { std::lock_guard<std::mutex> lock(drafts_mutex);
      check(drafts.back() == "draft-32000", "Draft revisions were appended instead of replaced."); }
    // Commit the first chunk, then decode a new chunk without replaying committed PCM.
    std::vector<float> chunk_tail(3 * sample_rate);
    for (size_t i = 0; i < chunk_tail.size(); ++i) chunk_tail[i] = second[i % sample_rate];
    audio.append(chunk_tail.data(), chunk_tail.size());
    wait([&] { streaming.check_failure(); return updates.load() == 3; });
    audio.append(second.data(), second.size());
    wait([&] { streaming.check_failure(); return updates.load() == 4; });
    // Stop with a short tail: only this chunk is reconciled, never all 6 seconds.
    audio.append(second.data(), 1600);
    phase("transcribing");
    check(streaming.finish() == "draft-80000 draft-17600", "Final chunk reconciliation failed.");
    check(calls == 5 && updates == 4, "Final decoding/output count self-test failed.");

    // Pause commits without decoding appended silence, then retains even quiet
    // speech above the same conservative threshold. No wall-clock assertions.
    audio.count = 0;
    audio.append(second.data(), second.size());
    std::atomic<size_t> pause_calls{0};
    Stream pauses(audio, [] { return false; },
        [&](const std::vector<float> &, const Stream::Abort &) {
            ++pause_calls; return std::string("word");
        }, [](const std::string &) {}, std::chrono::milliseconds(10));
    pauses.start();
    wait([&] { pauses.check_failure(); return pause_calls.load() == 1; });
    std::vector<float> quiet(sample_rate, 0);
    audio.append(quiet.data(), quiet.size());
    // Finalization processes the pause and new quiet speech as distinct chunks.
    // A separate deterministic final-only stream covers the exact boundary.
    pauses.finish();
    check(pause_calls == 1, "Appended silence triggered redundant inference.");
    audio.count = 0;
    std::vector<float> pause_chunk(Stream::window, 0);
    std::copy(second.begin(), second.end(), pause_chunk.begin());
    audio.append(pause_chunk.data(), pause_chunk.size());
    for (size_t i = 0; i < quiet.size(); ++i) quiet[i] = i % 2 ? 0.004f : -0.004f;
    audio.append(quiet.data(), quiet.size());
    size_t quiet_calls = 0;
    Stream quiet_stream(audio, [] { return false; },
        [&](const std::vector<float> &, const Stream::Abort &) { ++quiet_calls; return std::string("word"); },
        [](const std::string &) {});
    check(quiet_stream.finish() == "word word" && quiet_calls == 2,
          "Pause boundary dropped quiet speech or replayed committed audio.");

    // A cooperative in-flight recognizer must abort and join, emitting no partial.
    audio.count = 0;
    audio.append(second.data(), second.size());
    std::atomic<bool> cancelled{false}, entered{false}, exited{false};
    const auto cancel_start = std::chrono::steady_clock::now();
    {
        Stream cancelling(audio, [&] { return cancelled.load(); },
            [&](const std::vector<float> &, const Stream::Abort &abort) {
                entered = true;
                while (!abort()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
                exited = true;
                return "must not emit";
            }, [](const std::string &) { throw std::runtime_error("Partial after cancellation."); });
        cancelling.start();
        wait([&] { return entered.load(); });
        cancelled = true;
        check(cancelling.finish().empty(), "Cancelled worker returned a transcript.");
    }
    check(exited && std::chrono::steady_clock::now() - cancel_start < std::chrono::seconds(2),
          "Cancellation did not promptly join inference.");
    // Exception unwinding also aborts/joins an active recognizer via RAII.
    entered = false; exited = false;
    {
        Stream unwinding(audio, [] { return false; },
            [&](const std::vector<float> &, const Stream::Abort &abort) {
                entered = true;
                while (!abort()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
                exited = true;
                return "must not emit";
            }, [](const std::string &) { throw std::runtime_error("Partial after shutdown."); });
        unwinding.start();
        wait([&] { return entered.load(); });
    }
    check(exited, "RAII worker join self-test failed.");
    bool propagated = false;
    try {
        Stream failing(audio, [] { return false; },
            [](const std::vector<float> &, const Stream::Abort &) -> std::string {
                throw std::runtime_error("injected recognizer failure");
            }, [](const std::string &) {});
        failing.finish();
    } catch (const std::runtime_error &error) {
        propagated = std::string(error.what()) == "injected recognizer failure";
    }
    check(propagated, "Worker exception propagation self-test failed.");
    audio.count = max_samples;
    for (size_t i = 0; i < max_samples; ++i) audio.samples[i] = second[i % sample_rate];
    size_t bounded_calls = 0;
    Stream bounded(audio, [] { return false; },
        [&](const std::vector<float> &pcm, const Stream::Abort &) {
            check(pcm.size() == Stream::window, "Long audio used an unbounded window.");
            ++bounded_calls;
            return "word";
        }, [](const std::string &) { throw std::runtime_error("Unexpected final partial."); });
    std::string expected = "word";
    for (int i = 1; i < 24; ++i) expected += " word";
    check(bounded.finish() == expected && bounded_calls == 24, "120s chunk bounds/duplication failed.");
    audio.count = sample_rate;
    bool limited = false;
    try {
        Stream oversized(audio, [] { return false; },
            [](const std::vector<float> &, const Stream::Abort &) { return std::string(48001, 'x'); },
            [](const std::string &) {});
        oversized.finish();
    } catch (const std::runtime_error &error) {
        limited = std::string(error.what()) == "Transcript exceeds the 48 KB limit.";
    }
    check(limited, "Streaming transcript limit self-test failed.");
    event("transcript", "text", "self-test passed");
}

struct Options { std::string model, device, wav; bool self = false, protocol = false, cpu_probe = false, persistent = false, replay = false; };
Options options(int argc, char **argv) {
    Options result;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--protocol-version") { check(!result.protocol, "Duplicate --protocol-version."); result.protocol = true; }
        else if (arg == "--supports-avx2") { check(!result.cpu_probe, "Duplicate --supports-avx2."); result.cpu_probe = true; }
        else if (arg == "--self-test") { check(!result.self, "Duplicate --self-test."); result.self = true; }
        else if (arg == "--persistent") { check(!result.persistent, "Duplicate --persistent."); result.persistent = true; }
        else if (arg == "--replay") { check(!result.replay, "Duplicate --replay."); result.replay = true; }
        else {
            std::string *target = nullptr;
            if (arg == "--model") target = &result.model;
            else if (arg == "--device") target = &result.device;
            else if (arg == "--input-wav") target = &result.wav;
            else throw std::runtime_error("Unsupported argument: " + arg);
            check(target->empty() && i + 1 < argc, "Missing value or duplicate argument.");
            *target = argv[++i];
            check(!target->empty() && target->rfind("--", 0) != 0, "Missing argument value.");
        }
    }
    if (result.self || result.protocol || result.cpu_probe) check(argc == 2, "Probe options must be used alone.");
    else {
        check(!result.persistent || (!result.model.empty() && result.wav.empty() && !result.replay), "--persistent requires --model and cannot use WAV/replay.");
        check(!result.replay || (!result.wav.empty() && !result.model.empty()), "--replay requires --input-wav and --model.");
        check(result.device.empty() || result.wav.empty(), "--device cannot be combined with --input-wav.");
        check(!result.model.empty() || !result.wav.empty(), "Expected --model <English .en model path>.");
    }
    return result;
}
// whisper.cpp v1.7.6 widens file paths only with MSVC, not MinGW.
whisper_context *load_model(const std::string &path, whisper_context_params params) {
#ifdef _WIN32
    const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.c_str(), -1, nullptr, 0);
    if (length <= 0) return nullptr;
    std::vector<wchar_t> wide_path(static_cast<size_t>(length));
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.c_str(), -1,
                            wide_path.data(), length) != length) return nullptr;
    std::unique_ptr<FILE, decltype(&std::fclose)> file(_wfopen(wide_path.data(), L"rb"), std::fclose);
    if (!file) return nullptr;
    whisper_model_loader loader{};
    loader.context = file.get();
    loader.read = [](void *context, void *output, size_t size) {
        return std::fread(output, 1, size, static_cast<FILE *>(context));
    };
    loader.eof = [](void *context) {
        auto *input = static_cast<FILE *>(context);
        return std::feof(input) != 0 || std::ferror(input) != 0;
    };
    // RAII owns the file, including initialization failures and exceptions.
    loader.close = [](void *) {};
    return whisper_init_with_params(&loader, params);
#else
    return whisper_init_from_file_with_params(path.c_str(), params);
#endif
}
void native_log(enum ggml_log_level, const char *text, void *) { if (text) std::fputs(text, stderr); }
} // namespace

int main(int argc, char **argv) {
    try {
#ifdef _WIN32
        int wide_argc = 0;
        LPWSTR *wide_argv = CommandLineToArgvW(GetCommandLineW(), &wide_argc);
        check(wide_argv != nullptr, "Cannot read Windows command-line arguments.");
        struct ArgumentCleanup { LPWSTR *argv; ~ArgumentCleanup() { LocalFree(argv); } } cleanup{wide_argv};
        std::vector<std::string> utf8_arguments;
        utf8_arguments.reserve(static_cast<size_t>(wide_argc));
        for (int i = 0; i < wide_argc; ++i) {
            const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide_argv[i], -1,
                                                   nullptr, 0, nullptr, nullptr);
            check(length > 0, "Cannot convert Windows command-line argument to UTF-8.");
            std::vector<char> converted(static_cast<size_t>(length));
            check(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide_argv[i], -1,
                                      converted.data(), length, nullptr, nullptr) == length,
                  "Cannot convert Windows command-line argument to UTF-8.");
            utf8_arguments.emplace_back(converted.data());
        }
        std::vector<char *> utf8_argv;
        utf8_argv.reserve(utf8_arguments.size());
        for (auto &argument : utf8_arguments) utf8_argv.push_back(argument.data());
        argc = wide_argc;
        argv = utf8_argv.data();
#endif
        const auto args = options(argc, argv);
        if (args.protocol) { std::cout << "1\n"; return 0; }
        if (args.cpu_probe) { std::cout << (agav_voice::supports_avx2() ? "1\n" : "0\n"); return 0; }
        if (args.self) { self_test(); return 0; }
        std::signal(SIGINT, signal_handler); std::signal(SIGTERM, signal_handler);
#ifndef _WIN32
        std::signal(SIGHUP, signal_handler); std::signal(SIGPIPE, SIG_IGN);
#endif
        whisper_log_set(native_log, nullptr);
        ggml_log_set(native_log, nullptr);
        phase("preparing");
        Audio audio;
        // WAV validation/silence testing never opens a mic and needs no model.
        if (!args.wav.empty()) {
            read_wav(args.wav, audio);
            check(audible(audio), "No audible speech captured (empty, too short or silent audio).");
        }
        check(!args.model.empty(), "Expected --model <English .en model path> for transcription.");
        const char *threads_env = std::getenv("AGAV_VOICE_THREADS");
        int threads = static_cast<int>(std::max(1u, std::min(4u, std::thread::hardware_concurrency())));
        if (threads_env) {
            std::string value(threads_env);
            check(!value.empty() && value.size() <= 2 &&
                  value.find_first_not_of("0123456789") == std::string::npos,
                  "AGAV_VOICE_THREADS must be an integer from 1 to 16.");
            threads = std::stoi(value);
            check(threads >= 1 && threads <= 16, "AGAV_VOICE_THREADS must be an integer from 1 to 16.");
        }
        const char *backend_env = std::getenv("AGAV_VOICE_BACKEND");
        const std::string requested_backend = backend_env ? backend_env : "auto";
        check(requested_backend == "auto" || requested_backend == "cpu", "AGAV_VOICE_BACKEND must be auto or cpu.");
        const char *profile_env = std::getenv("AGAV_VOICE_PROFILE");
        const bool profile = profile_env && std::strcmp(profile_env, "1") == 0;
        bool gpu = AGAV_VOICE_USE_METAL && requested_backend == "auto";
        Controls controls(args.persistent);
        using Context = std::unique_ptr<whisper_context, decltype(&whisper_free)>;
        Context context(nullptr, whisper_free);
        auto load = [&] {
            auto params = whisper_context_default_params();
            params.use_gpu = gpu;
            return Context(load_model(args.model, params), whisper_free);
        };
        const auto load_start = std::chrono::steady_clock::now();
        context = load();
        if (!context && gpu && !controls.abort()) { gpu = false; context = load(); }
        controls.check_cancel();
        check(bool(context), "Cannot load local whisper model. Supply a valid English .en model.");
        check(!whisper_is_multilingual(context.get()), "English-only voice input requires an .en model; multilingual models are not supported.");
        auto telemetry = [&](const char *name, std::chrono::steady_clock::time_point start, size_t count) {
            if (!profile) return;
            const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
            const auto usage = resources();
            std::fprintf(stderr, "{\"type\":\"profile\",\"phase\":\"%s\",\"durationMs\":%.3f,\"sampleEnd\":%zu,\"context\":\"%s\",\"threads\":%d,\"backend\":\"%s\",\"cpuMs\":%.3f,\"peakRssBytes\":%llu}\n",
                name, ms, count, args.persistent ? "persistent" : "single-shot", threads, gpu ? "metal" : "cpu", usage.cpu_ms, usage.peak_rss);
        };
        telemetry("readiness", load_start, 0);
        size_t sample_end = 0;
        auto recognize = [&](const std::vector<float> &samples, const Stream::Abort &abort) {
            auto params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
            params.n_threads = threads;
            params.language = "en";
            params.detect_language = false;
            params.translate = false;
            params.no_context = true;
            params.no_timestamps = true;
            params.print_realtime = false;
            params.print_progress = false;
            params.print_timestamps = false;
            params.print_special = false;
            params.abort_callback = [](void *p) { return (*static_cast<const Stream::Abort *>(p))(); };
            params.abort_callback_user_data = const_cast<Stream::Abort *>(&abort);
            params.encoder_begin_callback = [](whisper_context *, whisper_state *, void *p) {
                return !(*static_cast<const Stream::Abort *>(p))();
            };
            params.encoder_begin_callback_user_data = params.abort_callback_user_data;
            const auto start = std::chrono::steady_clock::now();
            int status = whisper_full(context.get(), params, samples.data(), static_cast<int>(samples.size()));
            if (status != 0 && gpu && !abort()) {
                // The worker is the sole context owner during inference. Discard a
                // failed GPU context before reloading and retrying once on CPU.
                context.reset(); gpu = false;
                context = load();
                check(bool(context), "Cannot reload local whisper model for CPU fallback.");
                if (!abort()) status = whisper_full(context.get(), params, samples.data(), static_cast<int>(samples.size()));
            }
            telemetry("inference", start, sample_end);
            if (abort()) return std::string();
            check(status == 0, "Local English transcription failed.");
            std::string text;
            for (int i = 0; i < whisper_full_n_segments(context.get()); ++i) {
                const char *segment = whisper_full_get_segment_text(context.get(), i);
                if (segment) text += segment;
                check(text.size() <= 48000, "Transcript exceeds the 48 KB limit.");
            }
            return text;
        };
        auto session = [&](Audio &session_audio) {
            check(bool(context), "Whisper context unavailable after backend failure; restart the helper.");
            Stream stream(session_audio, [&] { return controls.abort(); }, recognize, [&](const std::string &text) {
                std::lock_guard<std::mutex> lock(output_mutex);
                if (!controls.abort()) event_unlocked("partial", "text", text);
            }, std::chrono::seconds(1), &sample_end);
            if (args.wav.empty()) capture(session_audio, controls, args.device, stream);
            else if (args.replay) {
                Audio source;
                // Swap the preloaded WAV into immutable replay storage.
                source.samples.swap(session_audio.samples);
                const size_t total = session_audio.count.exchange(0);
                phase("recording"); stream.start();
                const auto start = std::chrono::steady_clock::now();
                size_t fed = 0;
                while (fed < total && !controls.stopped) {
                    controls.check_cancel(); stream.check_failure();
                    const auto elapsed = std::chrono::steady_clock::now() - start;
                    const size_t due = std::min(total, static_cast<size_t>(std::chrono::duration<double>(elapsed).count() * sample_rate));
                    if (due > fed) { session_audio.append(source.samples.data() + fed, due - fed); fed = due; }
                    std::this_thread::sleep_for(std::chrono::milliseconds(10));
                }
            } else phase("recording");
            controls.check_cancel();
            // Stop acknowledgement must not wait for inference (parent deadline: 5s).
            phase("transcribing");
            check(audible(session_audio), "No audible speech captured (empty, too short or silent audio).");
            const std::string text = stream.finish();
            controls.check_cancel();
            check(text.find_first_not_of(" \r\n\t") != std::string::npos, "Whisper returned no speech text.");
            std::lock_guard<std::mutex> lock(output_mutex);
            controls.check_cancel();
            event_unlocked("transcript", "text", text);
        };
        if (args.persistent) {
            controls.ready();
            while (controls.wait_start()) {
                try {
                    controls.check_cancel();
                    phase("preparing");
                    Audio fresh;
                    session(fresh);
                } catch (const std::exception &error) {
                    event("error", "message", error.what());
                }
                if (controls.shutdown || interrupted) break;
                controls.ready();
            }
        } else session(audio);
        return 0;
    } catch (const std::exception &error) {
        event("error", "message", error.what());
        return 1;
    }
}
