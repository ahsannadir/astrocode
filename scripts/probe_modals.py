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
import json
import re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pty_probe import Checks, Session

THEME_TITLE = "Select a theme"
SETTINGS_TITLE = "⚙ Settings"
LOGIN_TITLE = "Connect a provider"


def active_theme(screen: str) -> str:
    """The theme row carrying the '✓ active' marker ('' if there is none).

    The marker tracks the APPLIED palette, so its row is a text-level witness
    of which theme is live while the picker is open — readable even though the
    probe asserts on a colourless grid.
    """
    for line in screen.splitlines():
        if "✓ active" not in line:
            continue
        tokens = line.replace("║", " ").replace("❯", " ").split()
        if tokens:
            return tokens[0]
    return ""


def persisted_theme(config_dir: str):
    """The theme written to config.json, or None when nothing was saved."""
    path = os.path.join(config_dir, "config.json")
    if not os.path.exists(path):
        return None
    with open(path) as fh:
        return json.load(fh).get("theme")


# theme.ascii for the two palettes the probe walks through (astro ▸ ocean).
ASTRO_CYAN, OCEAN_BLUE = "36", "34"


def wordmark_color(stream: str) -> str:
    """SGR code of the most recent paint of the banner wordmark.

    `Banner` colours ASTROCODE with theme.ascii, and Ink writes the basic chalk
    code for a named colour, so this is a byte-level witness of which palette
    the APP is painted in — not just which row the modal highlights.
    """
    codes = re.findall(r"\x1b\[([0-9;]+)mASTROCODE", stream)
    return codes[-1] if codes else ""


def run() -> Checks:
    checks = Checks("modals")
    # Temp ASTROCODE_CONFIG_DIR: applying a theme persists, and a probe must
    # never rewrite the developer's real ~/.astrocode/config.json.
    with Session() as s:
        s.await_ready()

        # ---- /theme: ↑/↓ preview live, Esc reverts, Enter applies --------
        # The wordmark is painted with theme.ascii (astro cyan → ocean blue) and
        # Ink writes basic chalk codes for named colours, so the escape before
        # "ASTROCODE" is a byte-level witness that the WHOLE app repainted on
        # the arrow key rather than just the modal's highlight moving.
        s.submit("/theme", 0.8)
        checks.check("theme modal opens", s.wait_for(THEME_TITLE))
        checks.check("opening the picker previews nothing new", active_theme(s.text()) == "astro")

        mark = len(s.stream())
        s.key(b"\x1b[B")  # down: astro → ocean
        delta = s.stream()[mark:]
        checks.check(
            "↓ repaints the app in the highlighted palette",
            wordmark_color(delta) == OCEAN_BLUE,
        )
        checks.check("↓ moves the active marker to ocean", active_theme(s.text()) == "ocean")
        checks.check("preview is not persisted yet", persisted_theme(s.tmp) is None)

        mark = len(s.stream())
        s.key(b"\x1b", 0.6)  # Esc: keep the theme that was set before the popup
        back = s.stream()[mark:]
        checks.check("Esc repaints with the previous theme", wordmark_color(back) == ASTRO_CYAN)
        checks.check("Esc closes the theme modal", s.wait_gone(THEME_TITLE))
        checks.check("Esc persists nothing", persisted_theme(s.tmp) is None)

        # The reopen is what proves the revert stuck: the marker tracks the
        # applied palette, so a leaked preview would greet us on ocean.
        s.submit("/theme", 0.8)
        checks.check("theme modal reopens", s.wait_for(THEME_TITLE))
        checks.check("reopened picker is back on astro", active_theme(s.text()) == "astro")

        # Commit this time: the previewed palette is what gets saved.
        s.key(b"\x1b[B")  # down: astro → ocean again
        s.key(b"\r", 0.8)  # apply
        checks.check("theme applies", s.wait_for("Theme switched to"))
        checks.check("theme modal closed after applying", s.wait_gone(THEME_TITLE))
        checks.check("Enter persists the previewed theme", persisted_theme(s.tmp) == "ocean")

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
