#!/usr/bin/env python3
"""Focused probe: snapshot the prompt line after EVERY keystroke to pin down
exactly how arrows / backspace / Esc behave, step by step."""
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
from tui_verify import Vt, COLS, ROWS  # reuse the VT emulator

pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.environ["NO_COLOR"] = "1"
    os.execvp("node", ["node", "dist/index.js", "--demo"])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
vt = Vt()
dec = codecs.getincrementaldecoder("utf-8")("replace")


def pump(wait=0.6):
    end = time.time() + wait
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if not r:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            return
        if not chunk:
            return
        vt.feed(dec.decode(chunk))
        end = time.time() + 0.15


def prompt_line():
    for l in vt.lines():
        if "❯" in l and "─" not in l and "navigate" not in l:
            return l.strip()
    return "(no prompt line)"


pump(2.5)

steps = [
    ("type h", lambda: os.write(fd, b"h")),
    ("type i", lambda: os.write(fd, b"i")),
    ("LEFT once", lambda: os.write(fd, b"\x1b[D")),
    ("LEFT once again", lambda: os.write(fd, b"\x1b[D")),
    ("DEL once", lambda: os.write(fd, b"\x7f")),
    ("RIGHT once", lambda: os.write(fd, b"\x1b[C")),
    ("type X", lambda: os.write(fd, b"X")),
    ("ESC", lambda: os.write(fd, b"\x1b")),
    ("type a", lambda: os.write(fd, b"a")),
    ("type b", lambda: os.write(fd, b"b")),
    ("coalesced DEL DEL", lambda: os.write(fd, b"\x7f\x7f")),
    ("coalesced LEFT LEFT", lambda: os.write(fd, b"\x1b[D\x1b[D")),
    ("type Z", lambda: os.write(fd, b"Z")),
]
for name, action in steps:
    action()
    pump(0.7)
    print(f"{name:22} -> {prompt_line()}")

os.kill(pid, signal.SIGKILL)
os.waitpid(pid, 0)
