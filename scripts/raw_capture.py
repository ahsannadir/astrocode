#!/usr/bin/env python3
"""Capture the RAW PTY stream so we can see Ink's real escape sequences."""
import fcntl
import os
import pty
import select
import signal
import struct
import termios
import time

COLS, ROWS = 110, 32

pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.environ["NO_COLOR"] = "1"
    os.execvp("node", ["node", "dist/index.js", "--demo"])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

raw = bytearray()


def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            raw.extend(chunk)


pump(2.5)
raw.clear()  # keep only the interesting window: after boot
for ch in "hi":
    os.write(fd, ch.encode())
    time.sleep(0.08)
pump(0.8)
for ch in "\x7f":
    os.write(fd, ch.encode())
pump(0.8)

os.kill(pid, signal.SIGKILL)
os.waitpid(pid, 0)

with open("/tmp/astro_raw.bin", "wb") as f:
    f.write(raw)

text = raw.decode("utf-8", "replace")
esc = text.replace("\x1b", "<ESC>")
with open("/tmp/astro_raw.txt", "w") as f:
    f.write(esc)
print(f"captured {len(raw)} bytes; visible tail:")
print(esc[-1500:])
