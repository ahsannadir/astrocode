#!/usr/bin/env python3
"""Bisect: Esc-close behavior of /settings vs /theme on fresh sessions.
Polls up to 5s after Esc and counts the bytes Ink wrote."""
import codecs
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

sys.path.insert(0, os.path.dirname(__file__))
from tui_verify import Vt, COLS, ROWS


def run_case(cmdstr, marker):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["NO_COLOR"] = "1"
        os.execvp("node", ["node", "dist/index.js", "--demo"])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    vt = Vt()
    dec = codecs.getincrementaldecoder("utf-8")("replace")

    def pump(wait=0.5, sink=None):
        end = time.time() + wait
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if not r:
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            if sink is not None:
                sink.extend(chunk)
            vt.feed(dec.decode(chunk))
            end = time.time() + 0.1

    try:
        pump(2.5)
        for ch in cmdstr:
            os.write(fd, ch.encode())
            time.sleep(0.03)
        pump(0.4)
        os.write(fd, b"\r")
        pump(1.2)
        opened = marker in vt.text()

        raw = bytearray()
        os.write(fd, b"\x1b")
        # poll up to 5s, recording when the modal disappears
        closed_at = None
        end = time.time() + 5.0
        while time.time() < end:
            pump(0.25, sink=raw)
            if marker not in vt.text():
                closed_at = 5.0 - (end - time.time())
                break
        return {
            "opened": opened,
            "closed": closed_at is not None,
            "closed_after_s": closed_at,
            "esc_bytes": len(raw),
        }
    finally:
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass


for name, cmdstr, marker in [
    ("settings", "/settings", "⚙ Settings"),
    ("theme", "/theme", "Select a theme"),
    ("login", "/login", "Connect a provider"),
    ("models", "/models", "Select a model"),
]:
    r = run_case(cmdstr, marker)
    print(
        f"{name:9} opened={r['opened']} closed={r['closed']} "
        f"after={r['closed_after_s'] and round(r['closed_after_s'], 2)}s esc_bytes={r['esc_bytes']}"
    )
