"""No microphone, model download, or third-party Python modules required."""
import json
import math
import os
import pathlib
import signal
import queue
import threading
import struct
import subprocess
import sys
import tempfile
import unittest
import wave

BINARY = sys.argv.pop(1)


def run(*args, stdin=""):
    return subprocess.run([BINARY, *args], input=stdin, text=True, encoding="utf-8",
                          capture_output=True, timeout=20)


def events(result):
    return [json.loads(line) for line in result.stdout.splitlines()]


class Protocol(unittest.TestCase):
    def test_protocol(self):
        result = run("--protocol-version")
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "1\n", ""))

    def test_baseline_cpu_capability_probe(self):
        result = run("--supports-avx2")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(result.stdout, ("0\n", "1\n"))
        self.assertEqual(result.stderr, "")

    def test_self_test(self):
        result = run("--self-test")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(result.stderr, "")
        self.assertEqual(events(result), [
            {"type": "phase", "phase": "recording"},
            {"type": "partial", "text": "draft-16000"},
            {"type": "partial", "text": "draft-32000"},
            {"type": "partial", "text": "draft-80000"},
            {"type": "partial", "text": "draft-80000 draft-16000"},
            {"type": "phase", "phase": "transcribing"},
            {"type": "transcript", "text": "self-test passed"},
        ])

    def test_streaming_partial_arrives_before_final_without_stop(self):
        # The helper's synthetic scheduler harness uses the production worker with
        # an injected deterministic recognizer. It never opens a microphone/model.
        with subprocess.Popen([BINARY, "--self-test"], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True) as process:
            try:
                first = json.loads(process.stdout.readline())
                partial = json.loads(process.stdout.readline())
                self.assertEqual(first, {"type": "phase", "phase": "recording"})
                self.assertEqual(partial, {"type": "partial", "text": "draft-16000"})
                # No stop/Enter has been sent, and stdin remains open.
                remaining, stderr = process.communicate(timeout=20)
                rest = [json.loads(line) for line in remaining.splitlines()]
                self.assertEqual(process.returncode, 0, stderr)
                self.assertEqual(stderr, "")
                self.assertEqual(rest[-1], {"type": "transcript", "text": "self-test passed"})
                self.assertEqual(sum(item["type"] == "transcript" for item in rest), 1)
                self.assertTrue(all(len(item.get("text", "")) <= 48000 for item in rest))
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate()

    def test_unsupported_args_and_combinations(self):
        for args in [(), ("--unknown",), ("--model",), ("--model", "--foo"),
                     ("--protocol-version", "--self-test"), ("--self-test", "--model", "x"),
                     ("--model", "a", "--model", "b"),
                     ("--device", "x", "--input-wav", "x"),
                     ("--persistent",), ("--model", "x", "--persistent", "--input-wav", "x"),
                     ("--replay", "--model", "x"), ("--persistent", "--persistent", "--model", "x")]:
            with self.subTest(args=args):
                result = run(*args)
                self.assertNotEqual(result.returncode, 0)
                data = events(result)
                self.assertEqual(len(data), 1)
                self.assertEqual(set(data[0]), {"type", "message"})
                self.assertEqual(data[0]["type"], "error")

    def test_environment_validation(self):
        for key, values in [("AGAV_VOICE_THREADS", ["", "0", "17", "-1", "1.5", "abc"]),
                            ("AGAV_VOICE_BACKEND", ["", "gpu", "metal"])]:
            for value in values:
                with self.subTest(key=key, value=value):
                    env = dict(os.environ, **{key: value})
                    result = subprocess.run([BINARY, "--model", "missing.bin"],
                                            input="", text=True, capture_output=True,
                                            env=env, timeout=20)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(key, events(result)[-1]["message"])

    def test_persistent_model_reuse_without_microphone(self):
        # Optional local model only: no download and no microphone. Missing-model
        # installations still run all synthetic scheduler tests.
        model = pathlib.Path(os.environ.get("AGAV_VOICE_TEST_MODEL",
                                            "~/.agav/voice/ggml-base.en-q5_1.bin")).expanduser()
        if not model.is_file():
            self.skipTest("No local English test model")
        with tempfile.TemporaryFile(mode="w+") as diagnostics:
            with subprocess.Popen([BINARY, "--model", str(model), "--persistent"],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=diagnostics, text=True,
                                  env=dict(os.environ, AGAV_VOICE_BACKEND="cpu",
                                           AGAV_VOICE_PROFILE="1")) as process:
                try:
                    # Read in a worker thread: Windows selectors cannot poll pipes.
                    lines = queue.Queue()
                    def read_output():
                        try:
                            for line in process.stdout:
                                lines.put(line)
                        finally:
                            lines.put(None)
                    reader = threading.Thread(target=read_output, daemon=True)
                    reader.start()
                    def receive():
                        try:
                            line = lines.get(timeout=30)
                        except queue.Empty:
                            self.fail("Timed out waiting for helper")
                        self.assertIsNotNone(line, "Unexpected helper EOF")
                        return json.loads(line)
                    self.assertEqual(receive(), {"type": "phase", "phase": "preparing"})
                    self.assertEqual(receive(), {"type": "ready", "protocol": 1})
                    # Each batch is consumed atomically: no capture can slip between
                    # start and its cancellation, stop or duplicate-start rejection.
                    for batch, message in [("start\ncancel\n", "cancelled"),
                                           ("start\nstop\n", "stopped before"),
                                           ("start\nstart\n", "duplicate"),
                                           ("start\ncancel\n", "cancelled")]:
                        process.stdin.write(batch)
                        process.stdin.flush()
                        received = []
                        while True:
                            item = receive()
                            received.append(item)
                            if item["type"] == "ready":
                                break
                        self.assertNotIn("recording", str(received))
                        errors = [e for e in received if e["type"] == "error"]
                        self.assertEqual(len(errors), 1)
                        self.assertIn(message, errors[0]["message"])
                    process.stdin.close()  # EOF exits cleanly from idle reuse.
                    self.assertEqual(process.wait(timeout=20), 0)
                    diagnostics.seek(0)
                    profiles = [json.loads(line) for line in diagnostics.read().splitlines()
                                if line.startswith('{"type":"profile"')]
                    self.assertEqual(len(profiles), 1, "Warm sessions reloaded the model")
                    self.assertEqual(profiles[0]["phase"], "readiness")
                    self.assertEqual(profiles[0]["backend"], "cpu")
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait()

    def test_replay_local_wav_without_microphone(self):
        model = pathlib.Path(os.environ.get("AGAV_VOICE_TEST_MODEL",
                                            "~/.agav/voice/ggml-base.en-q5_1.bin")).expanduser()
        if not model.is_file():
            self.skipTest("No local English test model")
        with tempfile.TemporaryDirectory(prefix="agav-replay-") as directory:
            wav = pathlib.Path(directory) / "synthetic.wav"
            with wave.open(str(wav), "wb") as output:
                output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                output.writeframes(b"".join(struct.pack("<h", int(5000 * math.sin(i * 2 * math.pi * 180 / 16000)))
                                          for i in range(32000)))
            with tempfile.TemporaryFile(mode="w+") as diagnostics:
                with subprocess.Popen([BINARY, "--input-wav", str(wav), "--model", str(model), "--replay"],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=diagnostics, text=True,
                                      env=dict(os.environ, AGAV_VOICE_BACKEND="cpu")) as process:
                    try:
                        # Keep stdin open: communicate() would intentionally cancel.
                        process.wait(timeout=90)
                        data = [json.loads(line) for line in process.stdout.read().splitlines()]
                        self.assertEqual(data[0], {"type": "phase", "phase": "preparing"})
                        self.assertEqual(data[1], {"type": "phase", "phase": "recording"})
                        terminal = [item for item in data if item["type"] in ("transcript", "error")]
                        self.assertEqual(len(terminal), 1)
                        self.assertEqual(data[-1], terminal[0])
                        self.assertIn({"type": "phase", "phase": "transcribing"}, data)
                        # Synthetic tones are not speech: no accuracy/text claims or
                        # requirement to hallucinate a partial in order to pass.
                        self.assertTrue(all(item["type"] in ("phase", "partial", "transcript", "error")
                                            for item in data))
                        self.assertEqual(process.returncode, 0 if terminal[0]["type"] == "transcript" else 1)
                    finally:
                        if process.poll() is None:
                            process.kill()
                            process.wait()

    def test_json_escaping(self):
        value = '"\\\n\t\x01世界'
        self.assertEqual(events(run(value))[0]["message"], "Unsupported argument: " + value)

    def test_wav_validation(self):
        with tempfile.TemporaryDirectory(prefix="agav-native-test-") as directory:
            path = pathlib.Path(directory) / "input.wav"
            for channels, width, rate, frames, expected in [
                (1, 2, 16000, 0, "No audible speech"),
                (1, 2, 16000, 3200, "No audible speech"),
                (2, 2, 16000, 3200, "PCM16 mono 16000"),
                (1, 1, 16000, 3200, "PCM16 mono 16000"),
                (1, 2, 8000, 3200, "PCM16 mono 16000"),
                (1, 2, 16000, 16000 * 120 + 1, "120 second limit"),
            ]:
                with self.subTest(channels=channels, width=width, rate=rate, frames=frames):
                    with wave.open(str(path), "wb") as output:
                        output.setparams((channels, width, rate, 0, "NONE", "not compressed"))
                        output.writeframes(bytes(frames * channels * width))
                    result = run("--input-wav", str(path))
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(events(result)[0], {"type": "phase", "phase": "preparing"})
                    self.assertIn(expected, events(result)[-1]["message"])
                    self.assertEqual(len(events(result)), 2)
            # DC-offset, short, and barely audible signals must not infer.
            for pcm in [struct.pack("<h", 15000) * 3200,
                        struct.pack("<hh", 5000, -5000) * 799,
                        struct.pack("<hh", 50, -50) * 1600]:
                with wave.open(str(path), "wb") as output:
                    output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                    output.writeframes(pcm)
                self.assertIn("No audible speech", events(run("--input-wav", str(path)))[-1]["message"])
            # Audible WAV needs a model but still never opens a microphone.
            with wave.open(str(path), "wb") as output:
                output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                output.writeframes(struct.pack("<hh", 5000, -5000) * 1600)
            self.assertIn("Expected --model", events(run("--input-wav", str(path)))[-1]["message"])
            path.write_bytes(b"invalid WAV")
            self.assertIn("Cannot decode", events(run("--input-wav", str(path)))[-1]["message"])

    def test_model_loader_opens_unicode_paths_without_microphone(self):
        # Invalid magic proves the file was opened/read, not merely that a
        # generic load error was returned. Include non-BMP UTF-16 surrogate pairs
        # and exercise both ASCII and Unicode filenames below a Unicode directory.
        with tempfile.TemporaryDirectory(prefix="agav-model-世界-\U0001f399-") as directory:
            for name in ("model.bin", "模型-\U0001f399.bin"):
                with self.subTest(name=name):
                    path = pathlib.Path(directory) / name
                    path.write_bytes(b"BAD!")
                    with subprocess.Popen([BINARY, "--model", str(path)],
                                          stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                          stderr=subprocess.PIPE, text=True, encoding="utf-8",
                                          env=dict(os.environ, AGAV_VOICE_BACKEND="cpu")) as process:
                        try:
                            # Keep stdin open so EOF cannot mask the load error.
                            process.wait(timeout=20)
                            stdout, stderr = process.communicate(timeout=5)
                            self.assertEqual(process.returncode, 1, stderr)
                            self.assertEqual([json.loads(line) for line in stdout.splitlines()], [
                                {"type": "phase", "phase": "preparing"},
                                {"type": "error", "message": "Cannot load local whisper model. Supply a valid English .en model."},
                            ])
                            self.assertIn("invalid model data (bad magic)", stderr)
                        finally:
                            if process.poll() is None:
                                process.kill()
                                process.communicate()
                    path.unlink()

    def test_eof_cancels_without_model_or_microphone(self):
        result = run("--model", os.path.join(tempfile.gettempdir(), "agav-nonexistent-model.bin"))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events(result)[0], {"type": "phase", "phase": "preparing"})
        self.assertEqual(events(result)[-1]["type"], "error")
        self.assertNotIn("recording", result.stdout)


if __name__ == "__main__":
    unittest.main()
