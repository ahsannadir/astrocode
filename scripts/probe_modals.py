#!/usr/bin/env python3
"""Probe: the popup tour — every modal opens, and Esc closes it.

Walks /theme (open, apply), /settings (open, Esc), /login (open, reach the key
stage, type, Esc back, Esc out) and finishes by checking the prompt still works.
This is the broad counterpart to the focused /models and /login probes: it is
where a change to the shared popup plumbing shows up first.

  python3 scripts/probe_modals.py

PROBE_ROWS / PROBE_COLS resize the fake terminal (default 32x110).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pty_probe import Checks, Session

THEME_TITLE = "Select a theme"
SETTINGS_TITLE = "⚙ Settings"
LOGIN_TITLE = "Connect a provider"


def run() -> Checks:
    checks = Checks("modals")
    # Temp ASTROCODE_CONFIG_DIR: applying a theme persists, and a probe must
    # never rewrite the developer's real ~/.astrocode/config.json.
    with Session() as s:
        s.await_ready()

        # ---- /theme: opens, ↑/↓ live, Enter applies ----------------------
        s.submit("/theme", 0.8)
        checks.check("theme modal opens", s.wait_for(THEME_TITLE))
        s.key(b"\x1b[B")  # down
        s.key(b"\r", 0.8)  # apply
        checks.check("theme applies", s.wait_for("Theme switched to"))
        checks.check("theme modal closed after applying", s.wait_gone(THEME_TITLE))

        # ---- /settings: opens, Esc closes --------------------------------
        s.submit("/settings", 0.8)
        checks.check("settings modal opens", s.wait_for(SETTINGS_TITLE))
        s.key(b"\x1b", 0.8)
        checks.check("settings modal closes on Esc", s.wait_gone(SETTINGS_TITLE))

        # ---- /login: staged flow, Esc backs out one stage at a time ------
        s.submit("/login", 0.8)
        checks.check("login modal opens", s.wait_for(LOGIN_TITLE))
        s.key(b"\r", 0.8)  # Enter on the first provider → key stage
        checks.check("key stage reached", s.wait_for("API key"))
        s.type_text("sk-test-123")
        checks.check("typing lands in the key field", s.wait_for("sk-test-123"))
        s.key(b"\x1b")  # back to the provider list
        checks.check("login Esc backs out one stage", s.wait_for(LOGIN_TITLE))
        s.key(b"\x1b", 0.8)  # close the popup
        checks.check("login modal closes on Esc", s.wait_gone(LOGIN_TITLE))

        # ---- the prompt still works after the tour -----------------------
        s.submit("final check", 0.8)
        checks.check("prompt works after the tour", s.wait_for("❯ final check"))

        checks.check("layout tripwire never fired", not s.tripwire_fired())
    return checks


def main() -> int:
    checks = run()
    print(checks.summary())
    return 0 if checks.ok else 1


if __name__ == "__main__":
    sys.exit(main())
