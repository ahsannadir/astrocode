#!/usr/bin/env python3
"""Run every TUI PTY probe as one pass/fail gate — `npm run probe`.

The probes boot the real binary (`node dist/index.js`) in a pty and assert on
the emulated screen, so they cover what unit tests cannot: the keystroke → Ink
→ frame path. This runner exists so they are actually run — a probe nobody
invokes is a probe that silently rots.

Behavior:
  * runs the assertion probes in order, streaming their output;
  * STOPS at the first failing probe (that is the regression) and exits 1;
  * every other script in this directory must be CLASSIFIED — either run, or
    listed below as a diagnostic with a reason. A new probe_*.py that nobody
    classified fails the gate instead of being quietly skipped;
  * passes PYTHONDONTWRITEBYTECODE=1 so running the gate never dirties the
    tracked __pycache__ in this directory.

Usage:
  python3 scripts/run_probes.py              # all probes (or: npm run probe)
  python3 scripts/run_probes.py --list       # what runs, what doesn't, why
  python3 scripts/run_probes.py probe_modals.py     # just one, while debugging
  python3 scripts/run_probes.py --timeout 120
"""
import argparse
import os
import selectors
import signal
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TIMEOUT = 420  # generous: each probe boots the app several times

# Probes that assert and exit non-zero on regression, in run order.
ASSERTION_PROBES = [
    "probe_modals.py",  # popup tour: /theme, /settings, /login
    "probe_models_esc.py",  # /models: always escapable, empty list included
    "probe_login_reuse.py",  # /login: reuse a saved custom endpoint
    "probe_mentions.py",  # @file picker: open, Tab, Esc, email boundary, attach
]

# Scripts that print facts for a human instead of asserting — they cannot
# fail, so they must not be counted as coverage. Each needs a reason here.
DIAGNOSTICS = {
    "probe_keys.py": "snapshots the prompt line after every keystroke (no pass/fail)",
    "probe_settings.py": "prints Esc-close facts for /settings (no pass/fail)",
    "probe_bisect.py": "prints per-modal open/close timings and Esc byte counts",
    "probe_escraw.py": "dumps the raw bytes Ink writes after Esc",
    "probe_escbytes.py": "replays captured Esc bytes through a fresh VT",
    "raw_capture.py": "writes the raw pty stream to /tmp for inspection",
}

# Shared modules, not probes.
SHARED = {"tui_verify.py", "pty_probe.py", "run_probes.py"}


def classify() -> tuple[list[str], list[str]]:
    """Return (problems, unclassified) for the scripts in this directory."""
    problems = []
    unclassified = []
    on_disk = sorted(f for f in os.listdir(HERE) if f.endswith(".py"))
    for name in on_disk:
        if name in SHARED or name in ASSERTION_PROBES or name in DIAGNOSTICS:
            continue
        unclassified.append(name)
    for name in ASSERTION_PROBES:
        if name not in on_disk:
            problems.append(f"{name} is listed as an assertion probe but is missing")
    for name in DIAGNOSTICS:
        if name not in on_disk:
            problems.append(f"{name} is listed as a diagnostic but is missing")
    return problems, unclassified


def newest_mtime(directory: str, suffix: str | None = None) -> float:
    newest = 0.0
    for dirpath, dirnames, filenames in os.walk(directory):
        dirnames[:] = [d for d in dirnames if d != "node_modules"]
        for f in filenames:
            if suffix and not f.endswith(suffix):
                continue
            newest = max(newest, os.path.getmtime(os.path.join(dirpath, f)))
    return newest


def check_build() -> str | None:
    """None when the build is usable, else a message explaining why not."""
    entry = os.path.join(ROOT, "dist", "index.js")
    if not os.path.exists(entry):
        return "dist/index.js is missing — run `npm run build` (or `npm run probe`)."
    newest_src = newest_mtime(os.path.join(ROOT, "src"))
    # Compare against the NEWEST build output, not just index.js: tsc may leave
    # an unchanged entry file older than a freshly re-emitted sibling, and a
    # false "stale" error on `npm run probe` would be worse than no check.
    newest_dist = newest_mtime(os.path.join(ROOT, "dist"), suffix=".js")
    if newest_src > newest_dist:
        return (
            "the build is older than src/ — probes would test stale code. "
            "`npm run probe` rebuilds first; do the same by hand."
        )
    return None


def run_probe(name: str, timeout: int, indent: str = "    ") -> tuple[bool, float, str]:
    """Run one probe, streaming its output. Returns (ok, seconds, note)."""
    path = os.path.join(HERE, name)
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    start = time.time()
    proc = subprocess.Popen(
        [sys.executable, path],
        cwd=ROOT,  # probes may reference dist/ relatively
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        start_new_session=True,  # own process group, so a timeout kills only us
    )

    sel = selectors.DefaultSelector()
    sel.register(proc.stdout, selectors.EVENT_READ)
    note = ""
    while True:
        for key, _ in sel.select(0.2):
            line = key.fileobj.readline()
            if line:
                sys.stdout.write(indent + line)
                sys.stdout.flush()
            else:
                sel.unregister(key.fileobj)
        if proc.poll() is not None and not sel.get_map():
            break
        if time.time() - start > timeout:
            # Interrupt rather than kill: the probe's `finally` blocks reap the
            # pty child, and a SIGKILL would leave a stray TUI running.
            note = f"timed out after {timeout}s (interrupted)"
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGINT)
                proc.wait(timeout=5)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except ProcessLookupError:
                    pass
            break

    sel.close()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
    code = proc.returncode
    seconds = time.time() - start
    if note:
        return False, seconds, note
    if code != 0:
        return False, seconds, f"exited {code}"
    return True, seconds, ""


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        prog="run_probes.py",
        description="Run every TUI PTY probe as one pass/fail gate.",
    )
    ap.add_argument("probes", nargs="*", help="only these probes (default: all)")
    ap.add_argument("--list", action="store_true", help="show what runs and what doesn't")
    ap.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="seconds per probe")
    args = ap.parse_args(argv)

    problems, unclassified = classify()
    if problems:
        for p in problems:
            print(f"error: {p}", file=sys.stderr)
        return 2
    if unclassified and not args.list:
        print("error: unclassified script(s) in scripts/:", file=sys.stderr)
        for name in unclassified:
            print(f"  {name}", file=sys.stderr)
        print(
            "Add each one to ASSERTION_PROBES (it asserts and exits non-zero) or to\n"
            "DIAGNOSTICS with a reason (it only prints facts). See scripts/run_probes.py.",
            file=sys.stderr,
        )
        return 2

    if args.list:
        print("assertion probes (the gate):")
        for name in ASSERTION_PROBES:
            print(f"  {name}")
        print("\ndiagnostics (not run — no pass/fail contract):")
        for name, reason in sorted(DIAGNOSTICS.items()):
            print(f"  {name:22} {reason}")
        if unclassified:
            print("\nUNCLASSIFIED (would fail the gate):")
            for name in unclassified:
                print(f"  {name}")
        return 0

    selected = args.probes or ASSERTION_PROBES
    unknown = [p for p in selected if p not in ASSERTION_PROBES]
    if unknown:
        print(
            f"error: not an assertion probe: {', '.join(unknown)}\n"
            f"try one of: {', '.join(ASSERTION_PROBES)}",
            file=sys.stderr,
        )
        return 2

    stale = check_build()
    if stale and not args.probes:
        print(f"error: {stale}", file=sys.stderr)
        return 2
    if stale:
        print(f"warning: {stale}", file=sys.stderr)

    print(f"running {len(selected)} TUI probe(s) — dist={os.path.relpath(os.path.join(ROOT, 'dist', 'index.js'), ROOT)}")
    results: list[tuple[str, bool, float, str]] = []
    failed_early = False
    for name in selected:
        print(f"\n=== {name}", flush=True)
        ok, seconds, note = run_probe(name, args.timeout)
        results.append((name, ok, seconds, note))
        status = "PASS" if ok else "FAIL"
        print(f"=== {name}: {status}" + (f" — {note}" if note else ""), flush=True)
        if not ok:
            failed_early = True
            break  # stop at the first regression

    print("\nprobe results")
    for name, ok, seconds, note in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name:24} {seconds:6.1f}s{('  ' + note) if note else ''}")
    if failed_early:
        remaining = [n for n in selected if n not in {r[0] for r in results}]
        if remaining:
            print(f"  SKIPPED (after the failure): {', '.join(remaining)}")
        print("\nFAILED — the regression is in the probe above.")
        return 1
    total = sum(r[2] for r in results)
    print(f"\nALL PROBES PASSED ({len(results)} probes, {total:.1f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
