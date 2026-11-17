#!/usr/bin/env python3
"""Check a built binary's paste rendering in a real PTY (requires pyte).

Run: python3 source/__tests__/helpers/paste-expansion-pty.py
Uses an isolated profile; never submits a prompt or calls a model.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time

import pyte

# Only run this checkout's build, independent of arguments or working directory.
binary = Path(__file__).resolve().parents[3] / "dist" / "agav"
with tempfile.TemporaryDirectory(prefix="agav-paste-pty-") as scratch:
    home = Path(scratch)
    config = home / ".agav"
    config.mkdir()
    (config / "config.json").write_text(json.dumps({
        "provider": "ollama", "model": "paste-fixture", "showChangelogOnLaunch": False,
    }))
    env = {"PATH": os.environ["PATH"], "HOME": str(home), "AGAV_HOME": str(config),
           "TERM": "xterm-256color", "AGAV_NO_UPDATE": "1", "LANG": "en_US.UTF-8"}
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
    process = subprocess.Popen([str(binary)], cwd=home, env=env,
                               stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    screen = pyte.Screen(120, 30)
    stream = pyte.ByteStream(screen)

    def read_for(seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                stream.feed(os.read(master, 65536))

    def visible():
        return "\n".join(screen.display)

    def send(text):
        os.write(master, text.encode())
        read_for(0.4)

    try:
        read_for(3)
        assert "Type a message" in visible(), visible()
        for ending in ["\r", "\r\n", "\n"]:
            lines = [f"row{i:02d}" for i in range(30)]
            paste = "\x1b[200~" + ending.join(lines) + "\x1b[201~"
            send(paste)
            assert "paste again to expand" in visible(), visible()
            send(paste)
            assert "❯ row00" in visible(), visible()
            assert "rows 1-8 of 30" in visible(), visible()
            row = next(i for i, line in enumerate(screen.display) if "❯ row00" in line)
            col = screen.display[row].index("❯")
            assert screen.buffer[row][col].fg == "green", screen.buffer[row][col]
            for i in range(1, 30):
                send("\x1b[B")
                assert lines[i] in visible(), visible()
                assert "❯ " in visible(), visible()
            send("\x15")  # Clear without submitting.
            print(f"PASS binary PTY: {ending!r} paste, green prefix, all 30 rows accessible")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        os.close(master)
