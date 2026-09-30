#!/usr/bin/env python3
"""Capture the RAW bytes Ink writes in response to Esc inside /settings."""
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

pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.environ["NO_COLOR"] = "1"
    os.execvp("node", ["node", "dist/index.js", "--demo"])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
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
        end = time.time() + 0.1


try:
    pump(2.5)

    for ch in "/settings":
        os.write(fd, ch.encode())
        time.sleep(0.03)
    pump(0.4)
    os.write(fd, b"\r")
    pump(1.2)

    # ---- the window of interest: Esc response ----
    raw = bytearray()
    os.write(fd, b"\x1b")
    pump(1.5, sink=raw)

    print(f"Esc produced {len(raw)} bytes")
    print(repr(raw.decode("utf-8", "replace"))[:2000])

    # apply those bytes to a fresh VT fed with everything so far? simpler:
    # check whether an erase-line/erase-display sequence appears at all
    txt = raw.decode("utf-8", "replace")
    has_el = "\x1b[K" in txt or "\x1b[0K" in txt or "\x1b[1K" in txt or "\x1b[2K" in txt
    has_ed = "\x1b[J" in txt or "\x1b[0J" in txt or "\x1b[1J" in txt or "\x1b[2J" in txt
    has_cu = "\x1b[" in txt
    print(f"contains EL(erases line): {has_el}, ED(erase display): {has_ed}, any CSI: {has_cu}")

    os.write(fd, b"q")
    pump(1.0)
finally:
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError):
        pass
