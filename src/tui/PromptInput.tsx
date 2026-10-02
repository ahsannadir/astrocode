import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from './theme.js';
import {
  backspaceAt,
  countArrow,
  countBackspaces,
  deleteWordBefore,
  moveCursorLeft,
  moveCursorRight,
  normalizePaste,
} from './inputEdit.js';
import { resolveSlashSubmission } from '../commands/slash.js';
import type { SlashCommandDef } from '../commands/slash.js';

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Submit a prompt or slash command. App decides queueing vs running. */
  onSubmit: (v: string) => void;
  history: string[];
  disabled: boolean;
  /** Agent is mid-turn: Enter submits (App queues or refuses), Esc interrupts. */
  busy?: boolean;
  /** Called when the user presses Esc while the agent is busy (interrupt). */
  onAbort?: () => void;
  placeholder: string;
  /**
   * Cells available for the text area (everything outside the pane's border,
   * padding and the ❯ marker). The input is clipped to it so the prompt box
   * always stays exactly one row tall.
   */
  maxWidth?: number;
  /** Matching slash commands for the active "/" overlay (empty when not in slash mode). */
  slashMatches: SlashCommandDef[];
  /** Currently highlighted slash command index. */
  slashSel: number;
  onSlashMove: (dir: 1 | -1) => void;
  /** Called when the user presses Esc with the slash menu open (dismiss it). */
  onSlashDismiss?: () => void;
  /** Enter text-selection mode over the chat area (Ctrl+K). */
  onCopyMode?: () => void;
}

/**
 * A full-featured single-line text input: cursor navigation, insert/delete,
 * robust backspace (works whether the terminal emits \b or DEL — Ink reports
 * them as `key.backspace` and `key.delete` respectively), Ctrl+W word
 * delete, Ctrl+U clear, Ctrl+K copy mode, Home/End (also Ctrl+A/E), history
 * recall, paste support, and the slash-command menu.
 *
 * Slash menu key model — one keypress per intent, no double-Enter dance:
 * - ↑/↓ browse every command (the menu scrolls under the highlight).
 * - Enter RUNS a command: the one typed in full if it is complete, otherwise
 *   the highlighted one. Typing `/model` can never be "completed" into
 *   `/models`, and a partial `/he` runs `/help` immediately.
 * - Tab completes the highlighted name into the line (caret at the end) so
 *   arguments can be typed right away.
 * - Esc closes the menu but KEEPS the line; Esc again (menu closed) clears it.
 * - ←/→ are plain caret movement — they no longer hijack a normal editing
 *   key to accept a suggestion.
 *
 * Terminals (and PTY batching) coalesce rapid keypresses into one input
 * chunk, so Backspace×3 can arrive as `\x7f\x7f\x7f` and ↑↑ as
 * `\x1b[A\x1b[A` with no key flags set. Those bursts are counted and applied
 * one step per key. The cursor is clamped against the value on every render,
 * so external value changes (history recall, autocomplete, submit) can never
 * leave it pointing past the end of the line — the classic "backspace deletes
 * nothing" bug.
 */
export function PromptInput({
  value,
  onChange,
  onSubmit,
  history,
  disabled = false,
  busy = false,
  onAbort,
  placeholder,
  maxWidth,
  slashMatches,
  slashSel,
  onSlashMove,
  onSlashDismiss,
  onCopyMode,
}: Props) {
  const [cursor, setCursor] = useState(value.length);
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const snapshotRef = useRef<string>('');

  const slashActive = value.startsWith('/') && slashMatches.length > 0;

  // Clamp the cursor whenever the value changes externally (history recall,
  // autocomplete, programmatic clear). Effect-free: computed per render.
  const clamped = Math.min(Math.max(0, cursor), value.length);

  /**
   * Complete the highlighted command into the line (Tab), caret at the end.
   * Keeps any typed arguments after a space; the explicit cursor move is what
   * makes "accept then type args" land in the right place instead of mid-word.
   */
  const completeHighlighted = (from: string): void => {
    const m = slashMatches[slashSel];
    if (!m) return;
    const sp = from.indexOf(' ');
    const argPart = sp > 0 ? from.slice(sp) : '';
    const next = m.name + argPart;
    onChange(next);
    setCursor(next.length);
  };

  useInput(
    (input, key) => {
      if (disabled) return;

      // ---- backspace / delete-before-cursor ----
      // Ink reports the Backspace key as `key.backspace` when the terminal
      // sends \b (0x08), but many terminals send DEL (\x7f) which Ink maps to
      // `key.delete` instead. Treat BOTH as deleting the char before the
      // cursor so Backspace works regardless of the byte the terminal emits.
      // Terminals (and PTY batching) coalesce rapid keypresses into one
      // chunk: Backspace×3 can arrive as '\x7f\x7f\x7f' with no key flags
      // set. Count them and delete one char per occurrence.
      const nBackspaces = countBackspaces(input);
      const isBackspace = key.backspace || key.delete || nBackspaces > 0;
      if (isBackspace) {
        if (key.ctrl && nBackspaces === 0 && input.toLowerCase() !== 'h') {
          // Ctrl+Backspace: delete the word before the cursor.
          const r = deleteWordBefore(value, clamped);
          if (r) {
            onChange(r.value);
            setCursor(r.cursor);
          }
          return;
        }
        let v = value;
        let cur = clamped;
        let n = Math.max(1, nBackspaces);
        while (n-- > 0) {
          const r = backspaceAt(v, cur);
          if (!r) break;
          v = r.value;
          cur = r.cursor;
        }
        onChange(v);
        setCursor(cur);
        return;
      }

      // ---- enter text-selection / copy mode (Ctrl+K) ----
      if (key.ctrl && input.toLowerCase() === 'k') {
        onCopyMode?.();
        return;
      }

      // ---- line clears / chords ----
      if (key.ctrl && input.toLowerCase() === 'u') {
        onChange('');
        setCursor(0);
        return;
      }
      // Ctrl+W: delete the word before the cursor (readline behavior).
      if (key.ctrl && input.toLowerCase() === 'w') {
        const r = deleteWordBefore(value, clamped);
        if (r) {
          onChange(r.value);
          setCursor(r.cursor);
        }
        return;
      }

      // ---- interrupt / close menu / clear ----
      // Esc: while the agent runs, INTERRUPT the turn (the typed line is
      // kept so it can be edited and queued). With the slash menu open, close
      // the menu but keep the line; otherwise clear the line.
      if (key.escape) {
        if (busy) {
          onAbort?.();
          return;
        }
        if (slashActive) {
          onSlashDismiss?.();
          return;
        }
        if (value !== '') {
          onChange('');
          setCursor(0);
        }
        return;
      }

      // ---- movement ----
      // Arrow bursts coalesce like backspaces: '\x1b[D\x1b[D' arrives as one
      // chunk with no key flags, so count the sequences.
      const nLeft = countArrow(input, 'left');
      if (key.leftArrow || nLeft > 0) {
        let cur = clamped;
        let n = Math.max(1, nLeft);
        while (n-- > 0) cur = moveCursorLeft(value, cur);
        setCursor(cur);
        return;
      }
      const nRight = countArrow(input, 'right');
      if (key.rightArrow || nRight > 0) {
        // Plain caret movement: → must not silently accept a slash suggestion.
        let cur = clamped;
        let n = Math.max(1, nRight);
        while (n-- > 0) cur = moveCursorRight(value, cur);
        setCursor(cur);
        return;
      }
      // Home/End: many terminals send CSI H / CSI F; Ink parses those into
      // key sequence but not into a named flag, so match the raw sequences.
      if (input === '[H' || input === 'OH') {
        setCursor(0);
        return;
      }
      if (input === '[F' || input === 'OF') {
        setCursor(value.length);
        return;
      }

      // ---- submit / slash selection ----
      if (key.return) {
        if (slashActive) {
          // Run, don't merely complete: the full typed command wins, else the
          // highlighted one. App routes this (queue while busy / run now).
          const cmd = resolveSlashSubmission(value, slashMatches, slashSel);
          if (cmd) {
            onSubmit(cmd);
            return;
          }
        }
        const v = value.trim();
        if (!v) return;
        onSubmit(v);
        return;
      }

      // ---- history / slash navigation ----
      const nUp = countArrow(input, 'up');
      if (key.upArrow || nUp > 0) {
        const n = Math.max(1, nUp);
        if (slashActive) {
          for (let i = 0; i < n; i++) onSlashMove(-1);
          return;
        }
        if (value === '') return; // let the message pane scroll the chat
        if (history.length === 0) return;
        if (histIdx === null) snapshotRef.current = value;
        const base = histIdx === null ? history.length - 1 : histIdx - 1;
        const idx = Math.max(0, base - (n - 1));
        setHistIdx(idx);
        const v = history[idx] ?? '';
        onChange(v);
        setCursor(v.length);
        return;
      }
      const nDown = countArrow(input, 'down');
      if (key.downArrow || nDown > 0) {
        const n = Math.max(1, nDown);
        if (slashActive) {
          for (let i = 0; i < n; i++) onSlashMove(1);
          return;
        }
        if (value === '') return; // let the message pane scroll the chat
        if (histIdx === null) return;
        const next = histIdx + n;
        if (next >= history.length) {
          setHistIdx(null);
          onChange(snapshotRef.current);
          setCursor(snapshotRef.current.length);
        } else {
          setHistIdx(next);
          const v = history[next];
          onChange(v);
          setCursor(v.length);
        }
        return;
      }

      // ---- Tab: complete the highlighted command (then type arguments) ----
      if (key.tab) {
        if (slashActive) completeHighlighted(value);
        return;
      }

      // ---- printable characters & pastes ----
      if (input.length > 0) {
        // Multi-char input = a paste (or a coalesced typing burst): strip
        // bracketed-paste markers, drop control/escape junk, insert at the
        // cursor in one go. A trailing Enter in the chunk means the user
        // (or the terminal's lineDiscipline) finished with Enter — submit
        // the line just as separately-typed keys would have.
        if (input.length > 1) {
          const endsWithSubmit = /[\r\n]$/.test(input);
          const body = endsWithSubmit ? input.slice(0, -1) : input;
          const paste = normalizePaste(body);
          let nextValue = value;
          if (paste.trim()) {
            nextValue = value.slice(0, clamped) + paste + value.slice(clamped);
            onChange(nextValue);
            setCursor(clamped + paste.length);
          }
          if (endsWithSubmit) {
            if (slashActive) {
              const cmd = resolveSlashSubmission(nextValue, slashMatches, slashSel);
              if (cmd) {
                onSubmit(cmd);
                return;
              }
            }
            const t = nextValue.trim();
            if (t) onSubmit(t);
          }
          return;
        }
        const code = input.charCodeAt(0);
        // Accept only printable characters (>= 0x20, not DEL). Previously
        // codes like \x01–\x1f that fell through every handler above were
        // inserted raw, corrupting the line.
        if (code < 0x20 || code === 0x7f) return;
        const next = value.slice(0, clamped) + input + value.slice(clamped);
        onChange(next);
        setCursor(clamped + 1);
      }
    },
    { isActive: !disabled },
  );

  // Reset history browsing when the field is cleared (e.g. after submit).
  useEffect(() => {
    if (value === '') setHistIdx(null);
  }, [value]);

  // The input is always ONE row: a long value (a pasted command, a long path)
  // scrolls horizontally to keep the caret visible instead of wrapping. A
  // wrapping box grows past the height App reserved, which can push the whole
  // frame onto Ink's direct-write path — the repaint stall behind all this.
  const room = Math.max(8, maxWidth ?? 80);
  // The caret is a cell of its own, so the window may start one past
  // `length - room` and still fit: at the end of a long line the caret sits on
  // the synthetic space after the last character.
  const shift =
    value.length > room
      ? Math.min(Math.max(0, clamped - room + 1), value.length - room + 1)
      : 0;
  const view = value.slice(shift, shift + room);
  const caretAt = clamped - shift;
  const before = view.slice(0, caretAt);
  const caretChar = view[caretAt] ?? ' ';
  const after = view.slice(caretAt + 1);
  const clip = (s: string) => (s.length > room ? s.slice(0, room) : s);

  return (
    <Box flexDirection="row">
      <Text color={theme.promptSymbol} bold>
        ❯
      </Text>
      <Text> </Text>
      {disabled ? (
        <Text color={theme.thinking} dimColor>
          {clip(value || placeholder)}
        </Text>
      ) : busy && value.length === 0 ? (
        <Text color={theme.thinking} dimColor>
          {clip('type + Enter to queue · Esc interrupts the agent…')}
        </Text>
      ) : value.length === 0 ? (
        <Text dimColor>{clip(placeholder)}</Text>
      ) : (
        <>
          <Text color={theme.prompt}>{before}</Text>
          <Text inverse color={theme.prompt}>
            {caretChar}
          </Text>
          <Text color={theme.prompt}>{after}</Text>
        </>
      )}
    </Box>
  );
}
