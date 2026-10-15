#!/usr/bin/env python3
"""Shared PTY harness for the runnable TUI probes (scripts/probe_*.py).

Every probe boots the REAL binary (`node dist/index.js`) inside a pty, types
real keystrokes and asserts on the emulated terminal grid — the only check that
exercises the keystroke → Ink → frame path. This module holds the parts they
all need so a probe is just its assertions; `scripts/run_probes.py` runs them
as one gate (`npm run probe`).

`tui_verify.py` is the manual, exploratory driver; this is the automated one.
They share the VT emulator on purpose: assertions must be made against the same
screen a human would see.
"""
import codecs
import fcntl
import json
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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tui_verify import Vt, COLS, ROWS

# The app's own runtime tripwire: it warns on stderr when a rendered frame
# reaches the terminal height, which puts Ink on its direct-write path and
# freezes the next identical frame. A probe that sees this is looking at a
# stuck screen, not a handled key.
TRIPWIRE_MARKERS = ("frame height", "direct-write")


class Checks:
    """PASS/FAIL bookkeeping for one probe (or one scenario of it)."""

    def __init__(self, label: str):
        self.label = label
        self.failures: list[str] = []

    def check(self, name: str, ok) -> bool:
        ok = bool(ok)
        print(f"  {'PASS' if ok else 'FAIL'} {name}", flush=True)
        if not ok:
            self.failures.append(name)
        return ok

    @property
    def ok(self) -> bool:
        return not self.failures

    def summary(self) -> str:
        if self.ok:
            return f"{self.label}: all checks passed"
        return f"{self.label}: FAILED — {', '.join(self.failures)}"


class Session:
    """One booted TUI in a pty, with screen assertions.

    Use as a context manager so the child is always reaped:

        with Session(config={"provider": "openai-compatible", ...}) as s:
            s.type_text("/login"); s.key(b"\\r")
            assert s.wait_for("Connect a provider")
    """

    def __init__(self, args=("--demo",), config=None, env=None, rows=None, cols=None):
        self.rows = int(os.environ.get("PROBE_ROWS", rows or ROWS))
        self.cols = int(os.environ.get("PROBE_COLS", cols or COLS))
        self.tmp = tempfile.mkdtemp(prefix="astrocode-probe-")
        if config is not None:
            with open(os.path.join(self.tmp, "config.json"), "w") as fh:
                fh.write(json.dumps(config))
        child_env = {
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
            "ASTROCODE_CONFIG_DIR": self.tmp,
        }
        child_env.update(env or {})

        # Resolve the entrypoint BEFORE forking: a missing build must abort the
        # probe loudly instead of turning every assertion into a timeout.
        self.entry = dist_entrypoint()
        self.pid, self.fd = pty.fork()
        if self.pid == 0:  # child
            os.environ.update(child_env)
            os.execvp("node", ["node", self.entry, *args])
        fcntl.ioctl(
            self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", self.rows, self.cols, 0, 0)
        )
        self.vt = Vt()
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self._raw: list[bytes] = []

    # ---- screen -----------------------------------------------------------
    def pump(self, wait=0.5):
        """Read for `wait` seconds, extending while output keeps arriving."""
        end = time.time() + wait
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if not r:
                continue
            try:
                chunk = os.read(self.fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            self._raw.append(chunk)
            self.vt.feed(self._decoder.decode(chunk))
            end = time.time() + 0.1

    def text(self) -> str:
        return self.vt.text()

    def stream(self) -> str:
        """Everything the app wrote (stdout and stderr are the same pty)."""
        return b"".join(self._raw).decode("utf-8", "replace")

    def tripwire_fired(self) -> bool:
        blob = self.stream()
        return any(m in blob for m in TRIPWIRE_MARKERS)

    # ---- waiting ----------------------------------------------------------
    def wait_for(self, needle, timeout=4.0) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.3)
            if needle in self.text():
                return True
        return False

    def wait_gone(self, needle, timeout=4.0) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.3)
            if needle not in self.text():
                return True
        return False

    def wait_idle(self, timeout=15.0) -> bool:
        """Wait until the status bar reports the agent is ready."""
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.3)
            if "● ready" in self.text():
                return True
        return False

    def await_ready(self, timeout=20.0) -> bool:
        """Wait until the TUI is booted and accepting input.

        A fixed sleep is a gamble on unrelated startup work (git, MCP servers,
        skills); keys typed before Ink owns stdin are line-buffered by the tty
        and can arrive as one blob, or not at all. Probes start here.
        """
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.3)
            screen = self.text()
            if "● ready" in screen and "❯" in screen:
                self.pump(0.3)
                return True
        return False

    # ---- input ------------------------------------------------------------
    def type_text(self, s, delay=0.03):
        for ch in s:
            os.write(self.fd, ch.encode())
            time.sleep(delay)
        self.pump(0.3)

    def key(self, seq, wait=0.25):
        """Send a key sequence; nothing may be batched with it.

        Ink parses a whole read as one keypress, so an arrow glued to a
        following Esc (`\\x1b[B\\x1b`) is not two keystrokes — always give each
        key its own write and a pump in between.
        """
        os.write(self.fd, seq)
        self.pump(wait)

    def submit(self, text, wait=0.5):
        """Type a line and press Enter, like a human would.

        The pump (plus a beat) before the CR lets the app echo the whole line
        first: a CR that shares a read with the preceding character is not a
        keypress, it is a paste of "…e\r" — and nothing submits.
        """
        self.type_text(text)
        self.pump(0.3)
        time.sleep(0.1)
        self.key(b"\r", wait)

    # ---- lifecycle --------------------------------------------------------
    def close(self):
        try:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def project_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def dist_entrypoint() -> str:
    """The built CLI the probes must exercise."""
    entry = os.path.join(project_root(), "dist", "index.js")
    if not os.path.exists(entry):
        raise SystemExit(
            "dist/index.js is missing — run `npm run build` (or `npm run probe`) first."
        )
    return entry
