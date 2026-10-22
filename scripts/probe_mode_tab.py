#!/usr/bin/env python3
"""Probe: does Tab switch Plan ↔ Act, and only when no menu owns the key?

Covers the keystroke → Ink → frame path for the mode shortcut, which unit
tests cannot see:

  toggle     Tab with an empty prompt flips the status bar act → plan → act.
  typed_line Tab flips the mode without touching a half-written prompt.
  slash      with the slash menu open, Tab still completes the command and
             leaves the mode alone.
  mention    with the `@` picker open, Tab still inserts the path and leaves
             the mode alone.

The completion scenarios prove the precedence rule: the menus keep Tab for
completion, and only a Tab with no menu open reaches the mode switch.

Run everything (what `npm run probe` does):

  python3 scripts/probe_mode_tab.py

Or one scenario while debugging:

  python3 scripts/probe_mode_tab.py slash

PROBE_ROWS / PROBE_COLS resize the fake terminal (default 32x110).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pty_probe import Checks, Session

SCENARIOS = ["toggle", "typed_line", "slash", "mention"]

# Status-bar labels: ◆ act and ◇ plan. Both are always rendered (the bar only
# sheds the mode *suffix* when narrow), so they are safe frame assertions.
ACT = "◆ act"
PLAN = "◇ plan"
# The completion menus' hint rows — unique to each menu.
PICKER_HINT = "↑↓ navigate · Tab complete · Enter insert · Esc close"
SLASH_HINT = "↑↓ navigate · Tab complete · Enter run · Esc close"


def run_scenario(name: str) -> Checks:
    checks = Checks(f"mode_tab/{name}")
    with Session() as s:
        if not s.await_ready():
            checks.check("TUI reaches ready state", False)
            return checks

        if name == "toggle":
            checks.check("starts in act mode", s.wait_for(ACT))
            s.key(b"\t")  # Tab
            checks.check("Tab switches to plan", s.wait_for(PLAN))
            checks.check("act is no longer shown", s.wait_gone(ACT))
            s.key(b"\t")
            checks.check("Tab switches back to act", s.wait_for(ACT))
            checks.check("plan is no longer shown", s.wait_gone(PLAN))
            checks.check("no layout tripwire", not s.tripwire_fired())

        elif name == "typed_line":
            s.type_text("draft prompt")
            s.key(b"\t")
            checks.check("Tab switches to plan", s.wait_for(PLAN))
            checks.check("the typed line is kept", s.wait_for("draft prompt"))
            checks.check("no layout tripwire", not s.tripwire_fired())

        elif name == "slash":
            s.type_text("/he")
            checks.check("slash menu opens", s.wait_for(SLASH_HINT))
            s.key(b"\t")
            checks.check("mode is untouched by completion", PLAN not in s.text() and ACT in s.text())
            s.key(b"\x1b")  # Esc closes the menu but keeps the completed line
            checks.check("menu closes", s.wait_gone(SLASH_HINT))
            checks.check("Tab completed /he into /help", s.wait_for("❯ /help"))
            checks.check("no layout tripwire", not s.tripwire_fired())

        elif name == "mention":
            s.type_text("see @packa")
            checks.check("picker opens", s.wait_for(PICKER_HINT))
            s.key(b"\t")
            checks.check("Tab inserts the path", s.wait_for("@package.json"))
            checks.check("picker closes", s.wait_gone(PICKER_HINT))
            checks.check("mode is untouched by insertion", PLAN not in s.text() and ACT in s.text())
            checks.check("no layout tripwire", not s.tripwire_fired())
    return checks


def main(argv: list[str]) -> int:
    wanted = argv or SCENARIOS
    unknown = [a for a in wanted if a not in SCENARIOS]
    if unknown:
        print(f"unknown scenario(s): {', '.join(unknown)} — try {', '.join(SCENARIOS)}")
        return 2

    failed = []
    for name in wanted:
        print(f"=== mode_tab/{name}")
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
