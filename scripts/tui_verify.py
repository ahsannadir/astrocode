#!/usr/bin/env python3
"""
Interactive TUI verification driver for AstroCode.

Spawns `node dist/index.js --demo` inside a PTY and emulates a small VT
(grids + absolute cursor positioning, CSI H/J/K/G/A-D, OSC skip, alt-screen
clear) so snapshots show exactly what a human sees. Replays realistic
keystrokes: typing, DEL backspace, mid-line edits, a bracketed paste burst,
slash-menu navigation, and the theme/settings/login modals.
"""
import codecs
import fcntl
import os
import pty
import re
import select
import signal
import struct
import termios
import time

COLS, ROWS = 110, 32
OUT = "/tmp/astro_tui"
os.makedirs(OUT, exist_ok=True)


class Vt:
    """A minimal VT100: enough for Ink's diff renderer on the alt screen."""

    PARTIAL_RE = re.compile(r"\x1b(\[[0-9;?]*|\][^\x07]*)$")

    def __init__(self, rows=ROWS, cols=COLS):
        self.rows, self.cols = rows, cols
        self.grid = [[" "] * cols for _ in range(rows)]
        self.r = 0
        self.c = 0
        # Escape sequences (and OSC payloads) can split across PTY reads;
        # hold a trailing partial sequence until its rest arrives.
        self.pending = ""

    def clear(self):
        self.grid = [[" "] * self.cols for _ in range(self.rows)]
        self.r = self.c = 0

    def put(self, ch):
        if self.c >= self.cols:
            self.c = 0
            self.r = min(self.r + 1, self.rows - 1)
        if 0 <= self.r < self.rows:
            self.grid[self.r][self.c] = ch
        self.c += 1

    def feed(self, text: str):
        text = self.pending + text
        self.pending = ""
        if text.endswith("\x1b"):
            self.pending = "\x1b"
            text = text[:-1]
        else:
            m = self.PARTIAL_RE.search(text)
            if m:
                self.pending = m.group(0)
                text = text[: m.start()]
        i, n = 0, len(text)
        while i < n:
            ch = text[i]
            if ch == "\x1b":
                if i + 1 >= n:
                    break
                nxt = text[i + 1]
                if nxt == "[":  # CSI
                    # Final byte: 0x40–0x7E. ('A' snuck into an earlier
                    # charclass here and made cursor-up eat lines.)
                    j = i + 2
                    while j < n and not (0x40 <= ord(text[j]) <= 0x7E):
                        j += 1
                    if j >= n:
                        break
                    params = text[i + 2 : j]
                    final = text[j]
                    self.csi(params, final)
                    i = j + 1
                    continue
                if nxt == "]":  # OSC — skip to BEL or ST
                    j = i + 2
                    while j < n and text[j] != "\x07" and not text.startswith("\x1b\\", j):
                        j += 1
                    i = j + (2 if j < n and text.startswith("\x1b\\", j) else 1)
                    continue
                # two-byte escapes like \x1b= \x1b> \x1bM — skip
                i += 2
                continue
            if ch == "\r":
                self.c = 0
            elif ch == "\n":
                self.r = min(self.r + 1, self.rows - 1)
            elif ch == "\b":
                self.c = max(0, self.c - 1)
            elif ch == "\t":
                self.c = min(self.cols - 1, (self.c // 8 + 1) * 8)
            elif ch >= " ":
                self.put(ch)
            i += 1

    def csi(self, params: str, final: str):
        if params.startswith("?"):
            if params in ("?1049h", "?47h"):
                self.clear()  # entering alt screen starts fresh
            return  # private modes (?25l/h cursor hide etc.) — no-op
        nums = [int(x) if x.isdigit() else 0 for x in params.split(";")] if params else [0]
        a = nums[0] if len(nums) > 0 else 0
        b = nums[1] if len(nums) > 1 else 0
        if final == "H" or final == "f":  # cursor position (1-based)
            self.r = max(0, (a or 1) - 1)
            self.c = max(0, (b or 1) - 1)
        elif final == "J":
            if a == 2 or a == 0:
                self.clear() if a == 2 else self._clear_below()
            elif a == 1:
                self._clear_above()
        elif final == "K":
            for x in range(self.c, self.cols):
                if 0 <= self.r < self.rows:
                    self.grid[self.r][x] = " "
        elif final == "G":
            self.c = max(0, (a or 1) - 1)
        elif final == "A":
            self.r = max(0, self.r - max(1, a))
        elif final == "B":
            self.r = min(self.rows - 1, self.r + max(1, a))
        elif final == "C":
            self.c = min(self.cols - 1, self.c + max(1, a))
        elif final == "D":
            self.c = max(0, self.c - max(1, a))

    def _clear_below(self):
        for x in range(self.c, self.cols):
            self.grid[self.r][x] = " "
        for y in range(self.r + 1, self.rows):
            self.grid[y] = [" "] * self.cols

    def _clear_above(self):
        for y in range(0, self.r):
            self.grid[y] = [" "] * self.cols
        for x in range(0, min(self.c + 1, self.cols)):
            self.grid[self.r][x] = " "

    def lines(self):
        return ["".join(row).rstrip() for row in self.grid]

    def text(self):
        return "\n".join(self.lines())


class Tui:
    def __init__(self):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:  # child
            os.environ["TERM"] = "xterm-256color"
            os.environ["NO_COLOR"] = "1"
            # Isolate state: the /theme and /settings steps below persist to
            # config.json, which must never touch the developer's real
            # ~/.astrocode/config.json.
            os.environ["ASTROCODE_CONFIG_DIR"] = "/tmp/astro_cfg_verify"
            os.environ["ASTROCODE_SESSION_DIR"] = "/tmp/astro_sessions_verify"
            os.execvp("node", ["node", "dist/index.js", "--demo"])
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        self.vt = Vt()
        # Stateful UTF-8 decoder: multibyte chars (❯, ▰, box borders…) can be
        # split across PTY reads; a naive per-chunk decode corrupts the grid.
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.drain(3.0)

    def drain(self, wait=0.6):
        end = time.time() + wait
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.1)
            if not r:
                continue
            try:
                chunk = os.read(self.fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            self.vt.feed(self.decoder.decode(chunk))
            end = time.time() + 0.15

    def send(self, data: str, per_char_delay=0.04):
        for ch in data:
            os.write(self.fd, ch.encode("utf-8"))
            time.sleep(per_char_delay)
        self.drain(0.5)

    def key(self, seq: str, wait=0.5):
        os.write(self.fd, seq.encode("utf-8"))
        time.sleep(0.08)
        self.drain(wait)

    def shot(self, name: str):
        with open(f"{OUT}/{name}.txt", "w") as f:
            f.write(self.vt.text())
        print(f"saved {OUT}/{name}.txt")

    def screen(self) -> str:
        return self.vt.text()

    def quit(self):
        try:
            self.key("\x03", wait=0.3)
            os.kill(self.pid, signal.SIGKILL)
        except (ProcessLookupError, OSError):
            pass
        try:
            os.waitpid(self.pid, 0)
        except ChildProcessError:
            pass


def main():
    t = Tui()
    failures = []
    try:
        # ---- 1. boot state ----
        t.shot("01_boot")
        assert "ASTROCODE" in t.screen(), "banner missing"

        # ---- 2. typing ----
        t.send("hello astro")
        t.shot("02_typed")
        if "❯ hello astro" not in t.screen():
            failures.append(f"typed text missing; screen tail:\n{t.screen()}")

        # ---- 3. backspace: DEL (0x7f) x3 → 'hello ' ----
        t.key("\x7f\x7f\x7f")
        t.shot("03_backspaced")
        s = t.screen()
        if "❯ hello " not in s or "hello astro" in s:
            failures.append(f"DEL backspace wrong; tail:\n{s}")

        # Mid-line edit: the line is "hello as" with the caret at the end (index 8);
        # two ← move it to 6, so DEL removes the space there → "helloas" (the
        # delete follows the caret, not the end of the line). The arrows go in
        # as separate writes because Ink parses a coalesced "\x1b[D\x1b[D" burst
        # as ONE left-arrow press and drops the tail, which a real terminal
        # never produces.
        t.key("\x1b[D")
        t.key("\x1b[D")
        t.key("\x7f")
        t.shot("04_midline_delete")
        if "❯ helloas" not in t.screen():
            failures.append(f"mid-line backspace wrong:\n{t.screen()}")

        # ---- 4. paste burst (bracketed markers + newline) ----
        t.key("\x15")  # Ctrl+U clear line first
        t.key("\x1b[200~paste me\nnow please\x1b[201~")
        t.shot("05_pasted")
        if "paste me now please" not in t.screen():
            failures.append(f"paste text missing:\n{t.screen()}")

        # ---- 4b. a long line must stay ONE row ----
        # Ink switches to a direct-write path once a frame reaches the screen
        # height, and the next identical frame then writes nothing: a box that
        # wraps pushes the status bar off screen and freezes repaints. The
        # prompt scrolls horizontally instead, so the last rows stay put.
        t.key("\x15")
        t.key("\x1b[200~" + "verylongdirectoryname/" * 20 + "\x1b[201~")
        t.shot("05b_long_line")
        tail = "\n".join(t.vt.lines()[-4:])
        if "● ready" not in tail:
            failures.append(f"long line overflowed the layout:\n{t.screen()}")

        # ---- 5. clear, then slash menu ----
        t.key("\x15")
        t.send("/")
        t.shot("06_slash_open")
        if "/help" not in t.screen():
            failures.append(f"slash menu did not open:\n{t.screen()}")

        # ---- 6. filter, then Enter RUNS the highlighted command in one press ----
        t.send("pl")
        t.shot("07_slash_filtered")
        if "/plan" not in t.screen():
            failures.append(f"slash filter failed:\n{t.screen()}")
        t.key("\r", wait=1.2)  # Enter runs /plan outright (no accept-then-Enter)
        t.shot("08_slash_ran")

        # ---- 7. the mode message confirms that single Enter ran the command ----
        t.shot("09_plan_ran")
        if "PLAN mode" not in t.screen():
            failures.append(f"/plan did not run on one Enter:\n{t.screen()}")

        # ---- 8. back to act, open /theme modal ----
        t.send("/act\r", per_char_delay=0.03)
        t.drain(0.7)
        t.send("/theme\r", per_char_delay=0.03)
        t.drain(0.9)
        t.shot("10_theme_modal")
        s = t.screen()
        if "Select a theme" not in s:
            failures.append(f"theme modal did not open:\n{s}")
        elif "synthwave" not in s:
            failures.append(f"theme list incomplete:\n{s}")

        # pick the next theme (↓ + Enter applies aurora)
        t.key("\x1b[B")
        t.key("\r", wait=1.0)
        t.shot("11_theme_applied")
        if "Theme switched to" not in t.screen():
            failures.append(f"theme apply failed:\n{t.screen()}")

        # ---- 9. /settings modal + Esc close ----
        t.send("/settings\r", per_char_delay=0.03)
        t.drain(0.9)
        t.shot("12_settings_modal")
        if "Settings" not in t.screen():
            failures.append(f"settings modal did not open:\n{t.screen()}")
        t.key("\x1b")
        t.shot("13_settings_closed")
        if "Settings\n" in t.screen() or " ⚙ Settings" in t.screen():
            failures.append(f"settings modal did not close:\n{t.screen()}")

        # ---- 10. /login modal: providers, key stage, Esc out ----
        t.send("/login\r", per_char_delay=0.03)
        t.drain(0.9)
        t.shot("14_login_modal")
        s = t.screen()
        if "Connect a provider" not in s or "OpenRouter" not in s:
            failures.append(f"login modal incomplete:\n{s}")
        t.key("\r")  # Enter on OpenAI → key stage
        t.send("sk-test-123")
        t.shot("15_login_typed_key")
        if "sk-test-123" not in t.screen():
            failures.append(f"typing into login key field failed:\n{t.screen()}")
        t.key("\x1b")  # back to providers
        t.key("\x1b", wait=0.7)  # close modal
        t.shot("16_login_closed")

        # ---- 11. prompt still healthy after the modal tour ----
        t.send("final check")
        t.shot("17_final_prompt")
        if "❯ final check" not in t.screen():
            failures.append(f"prompt broken after modal tour:\n{t.screen()}")

        if failures:
            print("\n===== FAILURES =====")
            for i, f in enumerate(failures, 1):
                print(f"[{i}] {f}")
            sys.exit(1)
        print("ALL TUI CHECKS PASSED")
    finally:
        t.quit()


if __name__ == "__main__":
    import sys

    main()
