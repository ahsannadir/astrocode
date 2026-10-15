#!/usr/bin/env python3
"""Probe: can you always get out of the /models picker?

Regression for the trapped picker — /models on a provider whose registry model
list is empty ('OpenAI Compatible') rendered a popup that swallowed every key,
Esc included, with no cancel affordance.

Runs the real TUI in a PTY for two scenarios and asserts, on the rendered
screen: the popup opens, Esc closes it, the prompt works afterwards, and the
layout tripwire never fired (which would mean a frozen frame, not just a
handled key).

  python3 scripts/probe_models_esc.py openai       # normal provider
  python3 scripts/probe_models_esc.py compatible   # empty model list
  python3 scripts/probe_models_esc.py openrouter   # long list, tight screen

PROBE_ROWS / PROBE_COLS resize the fake terminal (default 32x110).
"""
import codecs
import fcntl
import os
import pty
import select
import shutil
import signal
import struct
import sys
import tempfile
import termios
import time

sys.path.insert(0, os.path.dirname(__file__))
from tui_verify import Vt, COLS, ROWS

SCENARIO = sys.argv[1] if len(sys.argv) > 1 else "compatible"
TITLE = "Select a model"
PROBE_ROWS = int(os.environ.get("PROBE_ROWS", ROWS))
PROBE_COLS = int(os.environ.get("PROBE_COLS", COLS))

results = []


def check(name, ok):
    results.append((name, ok))
    print(("PASS " if ok else "FAIL ") + name)


tmp = tempfile.mkdtemp(prefix="astrocode-probe-")
env = {"ASTROCODE_CONFIG_DIR": tmp}
if SCENARIO == "openrouter":
    # A very long model list: the picker windows itself to the row budget, so
    # on a tight screen this is the case that used to put the frame on Ink's
    # direct-write path (a stale paint that ignores keys until something else
    # forces a repaint).
    with open(os.path.join(tmp, "config.json"), "w") as fh:
        fh.write('{"provider":"openrouter","apiKey":"x","model":"openai/gpt-4o"}')
elif SCENARIO == "compatible":
    # Auth pointing at the 'OpenAI Compatible' provider, whose registry model
    # list is empty — models are fetched live during /login and never stored
    # in the provider registry.
    with open(os.path.join(tmp, "config.json"), "w") as fh:
        fh.write(
            '{"provider":"openai-compatible","apiKey":"x","model":"local-llama",'
            '"baseUrl":"http://127.0.0.1:1/v1"}'
        )

pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.environ["NO_COLOR"] = "1"
    os.environ.update(env)
    os.execvp("node", ["node", "dist/index.js", "--demo"])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", PROBE_ROWS, PROBE_COLS, 0, 0))

vt = Vt()
decoder = codecs.getincrementaldecoder("utf-8")("replace")
raw = []


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
        raw.append(chunk)
        vt.feed(decoder.decode(chunk))
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


def type_text(s):
    for ch in s:
        os.write(fd, ch.encode())
        time.sleep(0.03)


try:
    pump(2.5)
    print(f"=== scenario: {SCENARIO} ({PROBE_COLS}x{PROBE_ROWS})")

    type_text("/models")
    pump(0.4)
    os.write(fd, b"\r")
    check("/models opens", wait_for(TITLE))

    if SCENARIO == "compatible":
        check(
            "empty list explains itself",
            wait_for("No models — reconnect with /login"),
        )
        check("cancel affordance is on screen", wait_for("Esc cancel"))

    os.write(fd, b"\x1b")  # Esc
    check("Esc closes the picker", wait_gone(TITLE))
    check("prompt works after cancelling", wait_for("❯", 3.0))

    # The picker must also stay closable when the list is empty and keys have
    # already been pressed (selection/arrow state must not wedge the exit).
    type_text("/models")
    pump(0.4)
    os.write(fd, b"\r")
    check("reopened", wait_for(TITLE))
    os.write(fd, b"\x1b[B")  # down
    pump(0.3)
    os.write(fd, b"\x1b")  # Esc
    check("Esc still closes after navigation", wait_gone(TITLE))

    stderr = b"".join(raw).decode("utf-8", "replace")
    check(
        "layout tripwire never fired",
        "frame height" not in stderr and "direct-write" not in stderr,
    )

    print()
    failed = [n for n, ok in results if not ok]
    print("ALL PASSED" if not failed else f"FAILED: {failed}")
    sys.exit(1 if failed else 0)
finally:
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError):
        pass
    shutil.rmtree(tmp, ignore_errors=True)
