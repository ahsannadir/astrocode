#!/usr/bin/env python3
"""Probe: can you always get out of the /model picker?

Regression for the trapped picker — /model on a provider whose registry model
list is empty ('OpenAI Compatible') rendered a popup that swallowed every key,
Esc included, with no cancel affordance.

Scenarios:
  openai      a normal provider: the picker lists models and Esc cancels.
  compatible  the empty list: the picker explains itself and Esc still cancels.
  openrouter  a very long list on a tight screen: the picker windows to its
              row budget without pushing the frame onto Ink's direct-write
              path (a stale paint that ignores keys).

Run everything (what `npm run probe` does):

  python3 scripts/probe_models_esc.py

Or one scenario while debugging:

  python3 scripts/probe_models_esc.py compatible

PROBE_ROWS / PROBE_COLS resize the fake terminal (default 32x110).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pty_probe import Checks, Session

SCENARIOS = ["openai", "compatible", "openrouter"]
TITLE = "Select a model"

CONFIGS = {
    "openai": {"provider": "openai", "apiKey": "x", "model": "gpt-4o-mini"},
    # An 'OpenAI Compatible' endpoint: its model list is fetched live during
    # /login and never lands in the provider registry, so it is empty here.
    "compatible": {
        "provider": "openai-compatible",
        "apiKey": "x",
        "model": "local-llama",
        "baseUrl": "http://127.0.0.1:1/v1",
    },
    "openrouter": {"provider": "openrouter", "apiKey": "x", "model": "openai/gpt-4o"},
}


def run_scenario(name: str) -> Checks:
    checks = Checks(f"models/{name}")
    with Session(config=CONFIGS[name]) as s:
        s.pump(2.5)

        s.submit("/model")
        checks.check("/model picker opens", s.wait_for(TITLE))

        if name == "compatible":
            checks.check("empty list explains itself", s.wait_for("No models — reconnect with /login"))
            checks.check("cancel affordance is on screen", s.wait_for("Esc cancel"))

        s.key(b"\x1b")
        checks.check("Esc closes the picker", s.wait_gone(TITLE))
        checks.check("prompt works after cancelling", s.wait_for("❯", 3.0))

        # The picker must also stay closable once keys have been pressed —
        # selection state must never wedge the exit.
        s.submit("/model")
        checks.check("reopened", s.wait_for(TITLE))
        s.key(b"\x1b[B")  # down
        s.key(b"\x1b")  # Esc
        checks.check("Esc still closes after navigation", s.wait_gone(TITLE))

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
        print(f"=== models/{name}")
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
