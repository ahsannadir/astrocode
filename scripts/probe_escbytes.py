#!/usr/bin/env python3
"""Capture the exact raw bytes written after pressing Esc in /settings,
and independently replay them through the Vt to see if it renders the close."""
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
boot = bytearray()


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
    pump(2.5, sink=boot)
    for ch in "/settings":
        os.write(fd, ch.encode())
        time.sleep(0.03)
    pump(0.4, sink=boot)
    os.write(fd, b"\r")
    pump(1.2, sink=boot)

    raw = bytearray()
    os.write(fd, b"\x1b")
    pump(2.0, sink=raw)

    print(f"post-Esc bytes: {len(raw)}")
    open("/tmp/esc_bytes.bin", "wb").write(bytes(raw))
    txt = raw.decode("utf-8", "replace")
    print("first 600 repr:", repr(txt[:600]))

    # Replay boot+esc through a fresh Vt
    vt = Vt()
    vt.feed(dec.decode(bytes(boot)))
    vt.feed(txt)
    modal_open = "⚙ Settings" in vt.text()
    print("after replay, modal open:", modal_open)
finally:
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError):
        pass
