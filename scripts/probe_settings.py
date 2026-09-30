#!/usr/bin/env python3
"""Isolation probe: does Esc close a freshly-opened /settings modal?"""
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
vt = Vt()
dec = codecs.getincrementaldecoder("utf-8")("replace")


def pump(wait=0.5):
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
        vt.feed(dec.decode(chunk))
        end = time.time() + 0.1


def wait_for(needle, timeout=4.0):
    end = time.time() + timeout
    while time.time() < end:
        pump(0.3)
        if needle in vt.text():
            return True
    return False


try:
    pump(2.5)

    # open /settings on a fresh session
    for ch in "/settings":
        os.write(fd, ch.encode())
        time.sleep(0.03)
    pump(0.4)
    os.write(fd, b"\r")
    print("settings opened:", wait_for("⚙ Settings"))

    # press Esc once
    os.write(fd, b"\x1b")
    pump(1.0)
    closed_once = "⚙ Settings" not in vt.text()
    print("closed after 1st Esc:", closed_once)

    if not closed_once:
        # press Esc again + probe other keys
        os.write(fd, b"\x1b")
        pump(1.0)
        print("closed after 2nd Esc:", "⚙ Settings" not in vt.text())
        os.write(fd, b"q")  # random key — does ANY key close it?
        pump(1.0)
        print("closed after 'q':", "⚙ Settings" not in vt.text())
        # try arrow + return cycling to prove the menu is live
        os.write(fd, b"\x1b[B")
        pump(0.4)
        os.write(fd, b"\r")
        pump(0.8)
        print("menu live (Enter toggles something):", "verify" in vt.text().lower() or "on" in vt.text())
finally:
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError):
        pass
