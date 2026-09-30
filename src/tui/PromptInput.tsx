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
import type { SlashCommandDef } from '../commands/slash.js';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  history: string[];
  disabled: boolean;
  /** Agent is mid-turn: Enter QUEUES the prompt, Esc interrupts the turn. */
  busy?: boolean;
  /** Called with the typed text when the user submits while busy. */
  onQueue?: (v: string) => void;
  /** Called when the user presses Esc while the agent is busy (interrupt). */
  onAbort?: () => void;
  placeholder: string;
  /** Matching slash commands for the active "/" overlay (empty when not in slash mode). */
  slashMatches: SlashCommandDef[];
  /** Currently highlighted slash command index. */
  slashSel: number;
  onSlashMove: (dir: 1 | -1) => void;
  onSlashAccept: () => void;
  /** Enter text-selection mode over the chat area (Ctrl+K). */
  onCopyMode?: () => void;
}

/**
 * A full-featured single-line text input: cursor navigation, insert/delete,
 * robust backspace (works whether the terminal emits \b or DEL — Ink reports
 * them as `key.backspace` and `key.delete` respectively), Ctrl+W word
 * delete, Ctrl+U clear, Ctrl+K line-tail delete, Home/End (also Ctrl+A/E),
 * history recall (↑/↓ when there's text), paste support, Enter to submit,
 * and Tab autocomplete with a slash-command menu (↑/↓ highlight, Enter/→/Tab
 * select). The cursor is clamped against the value on every render, so
 * external value changes (history recall, autocomplete, submit) can never
 * leave it pointing past the end of the line — the classic "backspace
 * deletes nothing" bug.
 */
export function PromptInput({
  value,
  onChange,
  onSubmit,
  history,
  disabled = false,
  busy = false,
  onQueue,
  onAbort,
  placeholder,
  slashMatches,
  slashSel,
  onSlashMove,
  onSlashAccept,
  onCopyMode,
}: Props) {
  const [cursor, setCursor] = useState(value.length);
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const snapshotRef = useRef<string>('');

  const slashActive = value.startsWith('/') && slashMatches.length > 0;

  // Clamp the cursor whenever the value changes externally (history recall,
  // autocomplete, programmatic clear). Effect-free: computed per render.
  const clamped = Math.min(Math.max(0, cursor), value.length);

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
      // ---- interrupt / clear ----
      // Esc: while the agent runs, INTERRUPT the turn (the typed line is
      // kept so it can be edited and queued); when idle, clear the line.
      if (key.escape) {
        if (busy) {
          onAbort?.();
          return;
        }
        if (value !== '') {
          onChange('');
          setCursor(0);
        }
        return;
      }
      // Ctrl+K again with selection mode open is handled above; plain
      // Ctrl+K-line-tail is omitted so Ctrl+K keeps its copy binding.

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
        // In slash mode, → selects the highlighted command (like other agents).
        if (slashActive && slashMatches[slashSel]) {
          onSlashAccept();
          return;
        }
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

      // ---- submit / queue / slash selection ----
      if (key.return) {
        if (slashActive) {
          const v = value.trim().toLowerCase();
          const sel = slashMatches[slashSel];
          // If the typed command already equals the highlighted one, run it.
          if (sel && v === sel.name.toLowerCase()) {
            if (busy) onQueue?.(value.trim());
            else onSubmit(value);
          } else if (sel) {
            onSlashAccept();
          }
          return;
        }
        const v = value.trim();
        if (!v) return;
        if (busy) {
          // Agent mid-turn: queue the message instead of dropping it.
          onQueue?.(v);
          return;
        }
        onSubmit(v);
        return;
      }

      // ---- history / slash navigation ----
      if (key.upArrow) {
        if (slashActive) {
          onSlashMove(-1);
          return;
        }
        if (value === '') return; // let the message pane scroll the chat
        if (history.length === 0) return;
        let idx = histIdx === null ? history.length - 1 : histIdx - 1;
        if (idx < 0) idx = 0;
        if (histIdx === null) snapshotRef.current = value;
        setHistIdx(idx);
        const v = history[idx] ?? '';
        onChange(v);
        setCursor(v.length);
        return;
      }
      if (key.downArrow) {
        if (slashActive) {
          onSlashMove(1);
          return;
        }
        if (value === '') return; // let the message pane scroll the chat
        if (histIdx === null) return;
        const next = histIdx + 1;
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

      // ---- Tab: autocomplete / pick the highlighted command ----
      if (key.tab) {
        if (slashActive) {
          const sel = slashMatches[slashSel];
          if (sel) onSlashAccept();
        }
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
              const selCmd = slashMatches[slashSel];
              const typed = nextValue.trim().toLowerCase();
              if (selCmd && typed === selCmd.name.toLowerCase()) {
                onSubmit(nextValue);
              } else if (selCmd) {
                onSlashAccept();
              }
              return;
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

  const before = value.slice(0, clamped);
  const caretChar = value[clamped] ?? ' ';
  const after = value.slice(clamped + 1);

  return (
    <Box flexDirection="row">
      <Text color={theme.promptSymbol} bold>
        ❯
      </Text>
      <Text> </Text>
      {disabled ? (
        <Text color={theme.thinking} dimColor>
          {value || placeholder}
        </Text>
      ) : busy && value.length === 0 ? (
        <Text color={theme.thinking} dimColor>
          type + Enter to queue · Esc interrupts the agent…
        </Text>
      ) : value.length === 0 ? (
        <Text dimColor>{placeholder}</Text>
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
