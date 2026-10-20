#!/usr/bin/env python3
"""Probe: does `@` open a usable file picker in the prompt?

Covers the keystroke → Ink → frame path for file mentions, which unit tests
cannot see:

  open       a bare `@` token lists workspace files, ranked.
  complete   Tab inserts the highlighted path, leaves a trailing space, and
             closes the picker (the caret is past a space, so no token).
  esc        Esc closes the picker without clearing the line, and typing
             re-opens it — the same contract as the slash menu.
  email      `you@host` never opens the picker (a mention starts a token).
  attach     submitting `@README.md …` shows the one-line receipt, proving
             the mentioned file was read and attached to the model message.
  enter_full a FULLY typed `@README.md` submits on Enter instead of being
             "completed" — a finished path must never need a second Enter.

Run everything (what `npm run probe` does):

  python3 scripts/probe_mentions.py

Or one scenario while debugging:

  python3 scripts/probe_mentions.py attach

PROBE_ROWS / PROBE_COLS resize the fake terminal (default 32x110).
"""
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pty_probe import Checks, Session

SCENARIOS = ["open", "complete", "esc", "email", "attach", "enter_full"]

ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07")


def plain_stream(s) -> str:
    """Everything the app has painted, with terminal escapes stripped."""
    return ANSI.sub("", s.stream())


def wait_stream(s, needle, timeout=8.0) -> bool:
    """Wait for text in the paint history rather than the current screen.

    The demo agent answers within a fraction of a second and its tool output
    scrolls the user message out of the pane, so a frame assertion is racy.
    The stream still proves the row was rendered.
    """
    end = time.time() + timeout
    while time.time() < end:
        s.pump(0.3)
        if needle in plain_stream(s):
            return True
    return False

# The picker's hint row — unique to FileMenu (the slash menu says "Enter run").
PICKER_HINT = "↑↓ navigate · Tab complete · Enter insert · Esc close"


def run_scenario(name: str) -> Checks:
    checks = Checks(f"mentions/{name}")
    with Session() as s:
        if not s.await_ready():
            checks.check("TUI reaches ready state", False)
            return checks

        if name == "open":
            s.type_text("look at @packa")
            checks.check("picker opens on @", s.wait_for("package.json"))
            checks.check("picker shows its key hints", s.wait_for(PICKER_HINT))
            checks.check("typed prefix is still on the prompt line", s.wait_for("@packa"))
            checks.check("picker does not overflow the frame", not s.tripwire_fired())

        elif name == "complete":
            s.type_text("look at @packa")
            checks.check("picker opens", s.wait_for(PICKER_HINT))
            s.key(b"\t")  # Tab
            checks.check("Tab inserts the path", s.wait_for("@package.json"))
            checks.check("picker closes after insertion", s.wait_gone(PICKER_HINT))
            checks.check(
                "caret is past the inserted path (trailing space)",
                s.wait_for("@package.json "),
            )

        elif name == "esc":
            s.type_text("@src/tu")
            checks.check("picker opens", s.wait_for(PICKER_HINT))
            s.key(b"\x1b")  # Esc
            checks.check("Esc closes the picker", s.wait_gone(PICKER_HINT))
            checks.check("Esc keeps the typed line", s.wait_for("@src/tu"))
            s.type_text("i")
            checks.check("typing re-opens the picker", s.wait_for(PICKER_HINT))
            checks.check("still no layout tripwire", not s.tripwire_fired())

        elif name == "email":
            s.type_text("mail see@package.json")
            s.pump(0.8)
            checks.check("email-like token never opens the picker", PICKER_HINT not in s.text())
            checks.check("the line is untouched", s.wait_for("see@package.json"))

        elif name == "enter_full":
            s.type_text("summarise @README.md")
            checks.check("picker is open on the full path", s.wait_for(PICKER_HINT))
            s.key(b"\r", 0.8)
            checks.check(
                "Enter with a complete path submits",
                wait_stream(s, "📎 attached 1 file: README.md"),
            )

        elif name == "attach":
            s.submit("@README.md summarise this")
            checks.check("submitted line was rendered", wait_stream(s, "summarise this"))
            checks.check(
                "mention is attached and reported",
                wait_stream(s, "📎 attached 1 file: README.md"),
            )
            checks.check("layout tripwire never fired", not s.tripwire_fired())
    return checks


def main(argv: list[str]) -> int:
    wanted = argv or SCENARIOS
    unknown = [a for a in wanted if a not in SCENARIOS]
    if unknown:
        print(f"unknown scenario(s): {', '.join(unknown)} — try {', '.join(SCENARIOS)}")
        return 2

    failed = []
    for name in wanted:
        print(f"=== mentions/{name}")
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
