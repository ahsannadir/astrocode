#!/usr/bin/env python3
"""Probe: the /login "already configured OpenAI Compatible" prompt.

Scenario 'reuse'      — a custom endpoint is saved: picking that provider shows
                        "Use existing configuration" / "Configure again", and
                        choosing the first reconnects without the wizard.
Scenario 'configure'  — the same, but choosing the second walks the wizard.
Scenario 'fresh'      — nothing saved: picking that provider goes straight to
                        the base-URL stage, with no reuse prompt.

  python3 scripts/probe_login_reuse.py reuse
  python3 scripts/probe_login_reuse.py configure
  python3 scripts/probe_login_reuse.py fresh

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

SCENARIO = sys.argv[1] if len(sys.argv) > 1 else "reuse"
PROBE_ROWS = int(os.environ.get("PROBE_ROWS", ROWS))
PROBE_COLS = int(os.environ.get("PROBE_COLS", COLS))
CUSTOM_ROW_DOWNS = 7  # 'OpenAI Compatible' is the 8th (last) provider row
BASE_URL = "http://127.0.0.1:1/v1"
MODEL = "local-llama"

results = []


def check(name, ok):
    results.append((name, ok))
    print(("PASS " if ok else "FAIL ") + name)


tmp = tempfile.mkdtemp(prefix="astrocode-probe-")
if SCENARIO != "fresh":
    with open(os.path.join(tmp, "config.json"), "w") as fh:
        fh.write(
            f'{{"provider":"openai-compatible","apiKey":"x","model":"{MODEL}",'
            f'"baseUrl":"{BASE_URL}"}}'
        )

pid, fd = pty.fork()
if pid == 0:
    os.environ.update(
        {
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
            "ASTROCODE_CONFIG_DIR": tmp,
        }
    )
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
    pump(0.3)


def key(seq):
    os.write(fd, seq)
    pump(0.25)


try:
    pump(2.5)
    print(f"=== scenario: {SCENARIO} ({PROBE_COLS}x{PROBE_ROWS})")

    type_text("/login")
    key(b"\r")
    check("provider list opens", wait_for("Connect a provider"))

    for _ in range(CUSTOM_ROW_DOWNS):
        key(b"\x1b[B")  # down, one at a time (coalesced escapes misparse)
    key(b"\r")

    if SCENARIO == "fresh":
        check("no reuse prompt when nothing is saved", wait_for("OpenAI Compatible — base URL"))
        check("reuse rows absent", "Use existing configuration" not in vt.text())
    else:
        check("reuse prompt appears", wait_for("Use existing configuration"))
        check("second option offered", wait_for("Configure again"))
        check("saved endpoint shown", wait_for(f"{BASE_URL}  ·  {MODEL}"))

        if SCENARIO == "reuse":
            # Row 0 is highlighted by default: Enter reconnects with it.
            key(b"\r")
            check("popup closes on reuse", wait_gone("Connect a provider"))
            check(
                "reconnect reported in the transcript",
                wait_for("Using your saved OpenAI Compatible configuration"),
            )
            check("wizard was skipped", "base URL" not in vt.text())
            check("prompt is usable again", wait_for("❯"))
        else:
            key(b"\x1b[B")  # down to "Configure again"
            key(b"\r")
            check("wizard reachable from the prompt", wait_for("OpenAI Compatible — base URL"))

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
