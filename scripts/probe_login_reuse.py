#!/usr/bin/env python3
"""Probe: the /login "already configured OpenAI Compatible" prompt.

Scenarios:
  reuse      a custom endpoint is saved and picked again: the prompt offers
             "Use existing configuration" / "Configure again", and choosing the
             first reconnects without the wizard, rewriting nothing.
  configure  choosing the second walks the base-URL wizard.
  fresh      nothing saved: picking that provider goes straight to the
             base-URL stage, with no reuse prompt.

Run everything (what `npm run probe` does):

  python3 scripts/probe_login_reuse.py

Or one scenario while debugging:

  python3 scripts/probe_login_reuse.py reuse

PROBE_ROWS / PROBE_COLS resize the fake terminal (default 32x110).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pty_probe import Checks, Session

SCENARIOS = ["reuse", "configure", "fresh"]
CUSTOM_ROW_DOWNS = 7  # 'OpenAI Compatible' is the 8th (last) provider row
BASE_URL = "http://127.0.0.1:1/v1"
MODEL = "local-llama"

SAVED_CUSTOM = {
    "provider": "openai-compatible",
    "apiKey": "x",
    "model": MODEL,
    "baseUrl": BASE_URL,
}


def open_provider_row(s: Session) -> None:
    """From the open provider list, land on the 'OpenAI Compatible' row."""
    for _ in range(CUSTOM_ROW_DOWNS):
        s.key(b"\x1b[B")  # down, one keypress at a time
    s.key(b"\r")


def run_scenario(name: str) -> Checks:
    checks = Checks(f"login/{name}")
    config = None if name == "fresh" else SAVED_CUSTOM
    with Session(config=config) as s:
        s.pump(2.5)
        s.submit("/login")
        checks.check("provider list opens", s.wait_for("Connect a provider"))

        open_provider_row(s)

        if name == "fresh":
            checks.check(
                "no reuse prompt when nothing is saved",
                s.wait_for("OpenAI Compatible — base URL"),
            )
            checks.check("reuse rows absent", "Use existing configuration" not in s.text())
        else:
            checks.check("reuse prompt appears", s.wait_for("Use existing configuration"))
            checks.check("second option offered", s.wait_for("Configure again"))
            checks.check("saved endpoint shown", s.wait_for(f"{BASE_URL}  ·  {MODEL}"))

            if name == "reuse":
                # Row 0 is highlighted by default: Enter reconnects with it.
                s.key(b"\r", 1.0)
                checks.check("popup closes on reuse", s.wait_gone("Connect a provider"))
                checks.check(
                    "reconnect reported in the transcript",
                    s.wait_for("Using your saved OpenAI Compatible configuration"),
                )
                checks.check("wizard was skipped", "base URL" not in s.text())
                checks.check("prompt is usable again", s.wait_for("❯"))
            else:
                s.key(b"\x1b[B")  # down to "Configure again"
                s.key(b"\r")
                checks.check(
                    "wizard reachable from the prompt",
                    s.wait_for("OpenAI Compatible — base URL"),
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
        print(f"=== login/{name}")
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
