#!/usr/bin/env python3
"""Manual Linux public-CLI acceptance fixture (Python stdlib, Node >=22, pnpm).

Run from any directory: python3 source/__tests__/helpers/sessions-public-detach.py
Compiles the current checkout to a temporary directory; never uses build/ or dist/.
Uses a deterministic loopback Ollama-protocol server, NOT a real model/download.
The real CLI, supervisor, worker, provider adapter, permission UI and write_file run.
Covers three task turns under one session id, fresh generations, approval-time Ctrl+K Ctrl+D
detach and exact-id CLI resume, not mid-tool/stream detach,
slash /resume discovery, other platforms or standalone packaging. No production edits.
"""
import ctypes
import fcntl
import http.server
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time


TIMEOUT = 40
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def wait_for(description, predicate, timeout=TIMEOUT):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError("Timed out: " + description)


def read_json(path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None


class Terminal:
    def __init__(self, command, cwd, env):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
        attrs = termios.tcgetattr(slave)
        attrs[0] &= ~(termios.IXON | termios.IXOFF)
        termios.tcsetattr(slave, termios.TCSANOW, attrs)
        self.output = bytearray()
        try:
            self.process = subprocess.Popen(command, cwd=cwd, env=env, stdin=slave,
                                            stdout=slave, stderr=slave, start_new_session=True)
        finally:
            os.close(slave)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        try:
            while True:
                data = os.read(self.master, 65536)
                if not data:
                    break
                self.output.extend(data)
        except OSError:
            pass  # PTY reports EIO when its last slave closes.

    def text(self):
        return ANSI.sub("", self.output.decode("utf-8", errors="replace")).replace("\r", "")

    def send(self, data):
        check(self.process.poll() is None, "CLI exited before input: " + self.text()[-4000:])
        os.write(self.master, data)

    def expect(self, text):
        wait_for("terminal contains " + repr(text), lambda: text in self.text())

    def exit_code(self):
        code = self.process.wait(timeout=TIMEOUT)
        self.reader.join(timeout=2)
        check(code == 0, f"CLI exit {code}: {self.text()[-4000:]}")

    def close(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=5)
        os.close(self.master)
        self.reader.join(timeout=2)


class Writes:
    """Count actual target close-after-write operations, not just final contents."""
    def __init__(self, directory, filename):
        self.filename = filename
        libc = ctypes.CDLL(None, use_errno=True)
        self.fd = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        if self.fd < 0:
            raise OSError(ctypes.get_errno(), "inotify_init1")
        if libc.inotify_add_watch(self.fd, os.fsencode(directory), 0x8) < 0:  # IN_CLOSE_WRITE
            os.close(self.fd)
            raise OSError(ctypes.get_errno(), "inotify_add_watch")
        self.count = 0

    def drain(self):
        while select.select([self.fd], [], [], 0)[0]:
            data = os.read(self.fd, 65536)
            offset = 0
            while offset < len(data):
                _, mask, _, length = struct.unpack_from("iIII", data, offset)
                name = data[offset + 16:offset + 16 + length].split(b"\0", 1)[0]
                if mask & 0x4000:  # IN_Q_OVERFLOW
                    raise AssertionError("inotify queue overflow: write count is uncertain")
                if mask & 0x8 and os.fsdecode(name) == self.filename:
                    self.count += 1
                offset += 16 + length
        return self.count


def stop_isolated_processes(home):
    # Supervisors deliberately outlive the PTY. Only signal processes carrying this
    # fixture's unique HOME; never guess PIDs from stale on-disk metadata.
    marker = ("HOME=" + str(home)).encode()
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for proc in Path("/proc").iterdir():
            if not proc.name.isdigit() or int(proc.name) == os.getpid():
                continue
            try:
                if marker in (proc / "environ").read_bytes().split(b"\0"):
                    os.kill(int(proc.name), sig)
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                pass
        time.sleep(0.2)


def main():
    check(sys.platform == "linux", "Linux PTY/inotify fixture only")
    repo = Path(__file__).resolve().parents[3]
    node = shutil.which("node")
    pnpm = shutil.which("pnpm")
    check(node and pnpm, "Install Node >=22 and pnpm first")
    with tempfile.TemporaryDirectory(prefix="agav-public-detach-") as temporary:
        root = Path(temporary)
        compiled, home, project = (root / name for name in ("compiled", "home", "project"))
        for path in (compiled, home / ".agav", project):
            path.mkdir(parents=True)
        print("Compiling current parent source into", compiled, flush=True)
        subprocess.run([pnpm, "exec", "tsc", "--outDir", str(compiled),
                        "--declaration", "false", "--declarationMap", "false", "--sourceMap", "false"],
                       cwd=repo, check=True, timeout=120)
        shutil.copyfile(repo / "package.json", root / "package.json")
        (compiled / "package.json").write_text('{"type":"module"}\n')
        (compiled / "node_modules").symlink_to(repo / "node_modules", target_is_directory=True)
        shutil.copyfile(repo / "source/cli.tsx", compiled / "cli.js")
        for relative in ("agents/bundled", "skills/bundled"):
            shutil.copytree(repo / "source" / relative, compiled / relative, dirs_exist_ok=True)
        shutil.copyfile(repo / "source/agents/sandbox-exec.mjs", compiled / "agents/sandbox-exec.mjs")
        requests, errors = [], []
        target = project / "hello.txt"
        prompts = [f"fixture task turn {turn}" for turn in range(1, 4)]
        verify_command = "cat hello.txt"

        class Ollama(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def respond(self, value):
                data = (json.dumps(value) + "\n").encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self.respond({"models": [{"name": "detach-fixture:latest", "model": "detach-fixture:latest"}]})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                if self.path == "/api/show":
                    self.respond({"model_info": {"fixture.context_length": 32768}, "capabilities": ["tools"]})
                    return
                if self.path != "/api/chat":
                    errors.append("Unexpected POST " + self.path)
                    self.send_error(404)
                    return
                requests.append(body)
                # History contains prior turns' tool results. Reset from the latest
                # real task prompt, not global request state or internal nudges.
                task = next(((index, prompt) for index, message in reversed(list(enumerate(body["messages"])))
                             for prompt in prompts if message["role"] == "user"
                             and message.get("content", "").startswith(prompt)), None)
                if task is None:
                    errors.append("Missing task prompt")
                    self.send_error(400)
                    return
                index, prompt = task
                tool_results = [m for m in body["messages"][index + 1:] if m["role"] == "tool"]
                if not tool_results:
                    message = {"role": "assistant", "content": "", "tool_calls": [{"function": {
                        "name": "write_file", "arguments": {"path": "hello.txt", "content": "hello\n"}}}]}
                elif len(tool_results) == 1:
                    message = {"role": "assistant", "content": "", "tool_calls": [{"function": {
                        "name": "run_command", "arguments": {"command": verify_command, "sandbox": "none"}}}]}
                else:
                    message = {"role": "assistant", "content": prompt + " finished"}
                self.respond({"model": "detach-fixture:latest", "message": message, "done": True,
                              "done_reason": "stop", "prompt_eval_count": 10, "eval_count": 5})

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Ollama)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        endpoint = f"http://127.0.0.1:{server.server_port}"
        (home / ".agav/config.json").write_text(json.dumps({
            "provider": "ollama", "model": "detach-fixture:latest", "ollamaEndpoint": endpoint,
            "backgroundJobsEnabled": True, "detachedSessionsEnabled": True, "permissionMode": "ask", "maxIterations": 6,
            "errorRetries": 0,
            "systemPrompt": "Use write_file once to write hello.txt, verify with cat hello.txt, then finish."}))
        # Do not leak the real profile, provider keys, preloads or organization settings.
        env = {"PATH": os.environ.get("PATH", ""), "HOME": str(home), "USERPROFILE": str(home),
               "AGAV_HOME": str(home / ".agav"), "TERM": "xterm-256color", "CI": "1",
               # The sole shell command reads the isolated target; /tmp is hidden by bubblewrap.
               "AGAV_NO_SANDBOX": "1", "AGAV_NO_UPDATE": "1", "OLLAMA_ENDPOINT": endpoint, "LANG": "C.UTF-8"}
        terminals = []
        writes = Writes(project, target.name)
        command = [node, str(compiled / "cli.js")]
        runtime_path = None
        try:
            first = Terminal(command, project, env)
            terminals.append(first)
            first.expect("detach-fixture")
            # Let Ink attach input handlers before delivering the first prompt.
            time.sleep(0.5)
            current = first
            runtimes = home / ".agav/session-runtimes"
            session_id, generations, identities = None, set(), []
            previous_blocks = 0

            def single_runtime():
                paths = list(runtimes.glob("*/runtime.json"))
                check(len(paths) == 1, f"Expected one resumable runtime, found {len(paths)}")
                check(session_id is None or paths[0].parent.name == session_id, "Runtime session id changed")
                return paths[0]

            for turn, prompt in enumerate(prompts, 1):
                request_start = len(requests)
                current.send(prompt.encode())
                time.sleep(0.2)
                current.send(b"\r")

                def pending_runtime():
                    paths = list(runtimes.glob("*/runtime.json"))
                    check(len(paths) <= 1, "More than one resumable runtime was created")
                    if paths:
                        record = read_json(paths[0])
                        if record and record["status"] == "needs-approval" and record["generation"] not in generations:
                            return single_runtime()
                    return None

                runtime_path = wait_for(f"turn {turn} needs approval in a fresh generation", pending_runtime)
                before = read_json(runtime_path)
                identity = {key: before[key] for key in ("id", "generation", "ownerPid", "jobId")}
                session_id = session_id or identity["id"]
                check(identity["id"] == session_id, "Continuation created a different session")
                check(identity["generation"] not in generations, "Continuation reused an execution generation")
                generations.add(identity["generation"])
                identities.append(identity)
                check(identity["ownerPid"] != current.process.pid, "UI owns execution instead of worker")
                approvals = runtime_path.parent / "approvals"
                pending = [path for path in approvals.glob("*.json") if not path.name.endswith(".decided.json")
                           and read_json(path)["generation"] == identity["generation"]]
                check(len(pending) == 1, "Expected exactly one outstanding approval for this generation")
                approval = read_json(pending[0])
                check(approval["sessionId"] == session_id, "Approval belongs to a different session")
                check(approval["toolName"] == "write_file", "Wrong pending tool")
                check(approval["input"] == {"path": "hello.txt", "content": "hello\n"}, "Wrong pending arguments")
                current.expect("Allow Write File?")
                current.expect("Ctrl+K Ctrl+D")
                check(writes.drain() == turn - 1, "Write executed before consent")
                check(turn > 1 or not target.exists(), "First write executed before consent")
                current.send(b"\x0b")
                time.sleep(0.1)
                current.send(b"\x04")  # Ctrl+K Ctrl+D must detach, not answer ToolConfirm.
                current.exit_code()
                current.expect(f"To resume: agav --resume {session_id}")
                time.sleep(0.7)
                detached = read_json(runtime_path)
                check(detached["status"] == "needs-approval", "Detach resolved or killed pending consent")
                check(all(detached[key] == value for key, value in identity.items()), "Detach changed worker identity")
                os.kill(identity["ownerPid"], 0)
                check(read_json(pending[0]) == approval, "Detach changed outstanding approval")
                check(not (approvals / (approval["approvalId"] + ".decided.json")).exists(), "Detach answered consent")
                check(writes.drain() == turn - 1 and len(requests) == request_start + 1,
                      "Detached worker replayed or executed without consent")
                check(single_runtime() == runtime_path, "Detach changed runtime discovery")

                resumed = Terminal(command + ["--resume", session_id], project, env)
                terminals.append(resumed)
                resumed.expect("Ctrl+K Ctrl+D")
                resumed.expect("Allow Write File?")
                resumed.expect("hello.txt")
                time.sleep(0.3)
                check(read_json(pending[0]) == approval and len(requests) == request_start + 1,
                      "Resume replayed pending turn")
                resumed.send(b"Y")
                resumed.expect("Allow Shell?")
                resumed.expect(verify_command)
                resumed.send(b"Y")
                completed = wait_for(f"turn {turn} same worker completes", lambda: (
                    (record := read_json(runtime_path)) and record["status"] in ("completed", "failed", "interrupted") and record))
                check(completed["status"] == "completed", f"Worker failed: {completed.get('error')}")
                check(all(completed[key] == value for key, value in identity.items()), "Resume replaced execution owner")
                resumed.expect(prompt + " finished")
                time.sleep(0.5)  # Let attachment polling release the finished turn before submitting another.
                check(target.read_text() == "hello\n", "Wrong file contents")
                check(writes.drain() == turn, "Expected exactly one physical write per generation (IN_CLOSE_WRITE)")
                decisions = [read_json(path) for path in approvals.glob("*.decided.json")
                             if read_json(path)["generation"] == identity["generation"]]
                check(len(decisions) == 2 and all(item["result"] == "yes" for item in decisions),
                      "Expected durable write and verification decisions per generation")
                decision = next(item for item in decisions if item["approvalId"] == approval["approvalId"])
                check(decision["result"] == "yes" and all(decision[key] == approval[key]
                      for key in ("approvalId", "generation", "inputHash")), "Wrong approval was consumed")
                blocks = [block for message in completed["messages"] for block in message["content"]]
                new_blocks = blocks[previous_blocks:]
                uses = [block for block in new_blocks if block["type"] == "tool_use"]
                check([block["toolName"] for block in uses] == ["write_file", "run_command"],
                      "Expected one write and one verification, without duplicate tool invocations")
                results = [block for block in new_blocks if block["type"] == "tool_result"]
                check(len(results) == 2 and all(not result.get("isError") for result in results),
                      "Missing/failed write or verification result")
                check("hello" in results[1]["toolResult"], "Verification did not read written contents")
                previous_blocks = len(blocks)
                turn_requests = requests[request_start:]
                check(len(turn_requests) == 3 and not errors,
                      f"Unexpected provider calls (replay/verification nudge): {len(turn_requests)}, {errors}")
                check(all(any(message["role"] == "tool" for message in request["messages"])
                          for request in turn_requests[1:]), "Provider restarted instead of continuing tool results")
                check(single_runtime() == runtime_path, "Completion created another resumable runtime")
                current = resumed

            current.send(b"\x03")
            current.exit_code()
            check(len(generations) == 3 and writes.drain() == 3, "Expected three generations and three physical writes")
            single_runtime()
            print("PASS: three task turns, one session id/runtime, three fresh generations; each Ctrl+K Ctrl+D exits 0 "
                  "with exact resume hint, preserves pending consent/worker, then exact-id resume + Y completes "
                  "one physical write and verification without replay or model verification nudges.")
            print(json.dumps(identities, sort_keys=True))
        except BaseException:
            for index, terminal in enumerate(terminals):
                print(f"\n--- PTY {index + 1} ---\n{terminal.text()[-8000:]}", file=sys.stderr)
            if runtime_path:
                print(runtime_path.read_text(), file=sys.stderr)
            raise
        finally:
            for terminal in terminals:
                terminal.close()
            stop_isolated_processes(home)
            os.close(writes.fd)
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
