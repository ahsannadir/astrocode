#!/usr/bin/env python3
"""Probe 2: modal tour with poll-based waits (no instant assertions),
to separate app bugs from snapshot timing races."""
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


def wait_gone(needle, timeout=4.0):
    end = time.time() + timeout
    while time.time() < end:
        pump(0.3)
        if needle not in vt.text():
            return True
    return False


def cmd(s):
    """Wait for the agent to be idle (prompt enabled), then type a slash
    command and submit it like a human would (chars + Enter)."""
    wait_idle()
    for ch in s:
        os.write(fd, ch.encode())
        time.sleep(0.03)
    pump(0.4)
    os.write(fd, b"\r")
    pump(0.5)


def wait_idle(timeout=15.0):
    """Wait until the status bar shows 'ready' (agent not busy)."""
    end = time.time() + timeout
    while time.time() < end:
        pump(0.3)
        if "● ready" in vt.text():
            return True
    return False


results = []


def check(name, ok):
    results.append((name, ok))
    print(("PASS " if ok else "FAIL ") + name)


try:
    pump(2.5)

    cmd("/theme")
    check("theme modal opens", wait_for("Select a theme"))
    os.write(fd, b"\x1b[B")  # down
    pump(0.4)
    os.write(fd, b"\r")  # apply
    check("theme applies", wait_for("Theme switched to"))

    cmd("/settings")
    check("settings modal opens", wait_for("⚙ Settings"))
    os.write(fd, b"\x1b")  # Esc
    check("settings modal closes on Esc", wait_gone("⚙ Settings"))

    cmd("/login")
    check("login modal opens", wait_for("Connect a provider"))
    os.write(fd, b"\r")  # Enter on OpenAI → key stage
    check("key stage reached", wait_for("API key"))
    for ch in "sk-test-123":
        os.write(fd, ch.encode())
        time.sleep(0.03)
    pump(0.5)
    check("typing lands in key field", wait_for("sk-test-123"))
    os.write(fd, b"\x1b")  # back to providers
    pump(0.4)
    os.write(fd, b"\x1b")  # close modal
    check("login modal closes on Esc", wait_gone("Connect a provider"))

    # prompt healthy afterwards
    wait_idle()
    for ch in "final check":
        os.write(fd, ch.encode())
        time.sleep(0.03)
    pump(0.5)
    check("prompt works after tour", wait_for("❯ final check"))

    print()
    failed = [n for n, ok in results if not ok]
    print("ALL PROBE CHECKS PASSED" if not failed else f"FAILED: {failed}")
    sys.exit(1 if failed else 0)
finally:
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError):
        pass
