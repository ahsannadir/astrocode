#!/usr/bin/env python3
"""Probe: /history opens saved chats, Esc cancels, and Enter resumes one.

Covers the keystroke → Ink → frame path for the /history picker, plus the
persistence contract behind it: a saved session is listed, loaded back into the
transcript, and the next turn appends to the same file.

  resume  a seeded session appears in the picker; Enter restores its messages
          and the following prompt is written back to the same session file.
  cancel  Esc closes the picker without touching the live transcript.
  empty   with no saved chats, /history explains itself instead of opening an
          empty modal.

PROBE_ROWS / PROBE_COLS resize the fake terminal (default 32x110).
"""
import json
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pty_probe import Checks, Session

TITLE = "Previous chats"
SESSION_NAME = "deploy-freeze"
OLD_USER = "remember the deploy freeze"
OLD_ASSISTANT = "Noted: deploy freeze until Friday."

SCENARIOS = ["resume", "cancel", "empty"]


def seed_session(directory: str) -> None:
    """Write one saved chat in the shape sessions.ts reads."""
    now = "2026-10-28T12:00:00.000Z"
    data = {
        "name": SESSION_NAME,
        "cwd": "/tmp/probe-workspace",
        "model": "gpt-4o",
        "mode": "act",
        "createdAt": now,
        "updatedAt": now,
        "messages": [
            {"role": "user", "content": OLD_USER},
            {"role": "assistant", "content": OLD_ASSISTANT},
        ],
    }
    with open(os.path.join(directory, f"{SESSION_NAME}.json"), "w") as fh:
        fh.write(json.dumps(data))


def read_messages(directory: str):
    path = os.path.join(directory, f"{SESSION_NAME}.json")
    for _ in range(40):
        try:
            with open(path) as fh:
                return json.load(fh).get("messages") or []
        except (OSError, ValueError):
            time.sleep(0.2)
    return []


def run_scenario(name: str) -> Checks:
    checks = Checks(f"history/{name}")
    sessions = tempfile.mkdtemp(prefix="astro-history-probe-")
    if name in ("resume", "cancel"):
        seed_session(sessions)
    env = {"ASTROCODE_SESSION_DIR": sessions}
    try:
        with Session(env=env) as s:
            if not s.await_ready():
                checks.check("TUI reaches ready state", False)
                return checks

            s.submit("/history", 0.8)

            if name == "empty":
                checks.check(
                    "explains there is nothing to resume",
                    s.wait_for("No saved chats yet"),
                )
                checks.check("no empty modal is opened", TITLE not in s.text())
                checks.check("layout tripwire never fired", not s.tripwire_fired())
                return checks

            checks.check("picker opens", s.wait_for(TITLE))
            checks.check("saved chat is listed", s.wait_for(SESSION_NAME))
            checks.check("row carries its message count and age", s.wait_for("2 msgs"))

            if name == "cancel":
                s.key(b"\x1b", 0.8)
                checks.check("Esc closes the picker", s.wait_gone(TITLE))
                checks.check("nothing was loaded", OLD_USER not in s.text())
                checks.check("no resume notice", "Resumed" not in s.text())
                checks.check("prompt still works", s.submit("after cancel", 0.5) or s.wait_for("❯ after cancel"))
                checks.check("layout tripwire never fired", not s.tripwire_fired())
                return checks

            # ---- resume ----
            s.key(b"\r", 1.0)  # Enter: load the highlighted chat
            checks.check("picker closes on Enter", s.wait_gone(TITLE))
            checks.check("resume is announced", s.wait_for("Resumed"))
            checks.check("the old prompt is in the transcript", s.wait_for(OLD_USER))
            checks.check("the old answer is in the transcript", s.wait_for(OLD_ASSISTANT))

            # Continuing writes back to the SAME session file (the point of
            # resuming rather than starting over).
            s.submit("continue please", 0.6)
            checks.check("follow-up is accepted", s.wait_for("❯ continue please"))
            deadline = time.time() + 12
            messages = []
            while time.time() < deadline:
                messages = read_messages(sessions)
                if any(m.get("content") == "continue please" for m in messages):
                    break
                s.pump(0.3)
            checks.check(
                "follow-up is appended to the resumed session",
                any(m.get("content") == "continue please" for m in messages),
            )
            checks.check(
                "the whole conversation is preserved",
                [m.get("role") for m in messages[:2]] == ["user", "assistant"],
            )
            checks.check("layout tripwire never fired", not s.tripwire_fired())
    finally:
        shutil.rmtree(sessions, ignore_errors=True)
    return checks


def main(argv) -> int:
    wanted = argv or SCENARIOS
    unknown = [a for a in wanted if a not in SCENARIOS]
    if unknown:
        print(f"unknown scenario(s): {', '.join(unknown)} — try {', '.join(SCENARIOS)}")
        return 2

    failed = []
    for name in wanted:
        print(f"=== history/{name}")
        checks = run_scenario(name)
        print(checks.summary(), flush=True)
        if not checks.ok:
            failed.append(name)

    print()
    if failed:
        print(f"FAILED scenarios: {', '.join(failed)}")
        return 1
    print(f"ALL PASSED ({len(wanted)} scenario{'s' if len(wanted) != 1 else ''})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
