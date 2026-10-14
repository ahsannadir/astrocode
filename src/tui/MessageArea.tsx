import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme, spinnerFrames } from './theme.js';
import {
  richLines,
  wrapText,
  fitLine,
  type UILine,
} from './markdown.js';

export type { UISegment } from './markdown.js';

/** One worker's live state inside an agent_activity item. */
export interface AgentWorker {
  /** 1-based worker index (0 for a single spawn). */
  worker: number;
  role: string;
  task: string;
  /** Tool names used so far, in order. */
  tools: string[];
  turns: number;
  actions: number;
  done: boolean;
}

export type UIItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_start'; name: string; args: string }
  | { kind: 'tool_result'; name: string; ok: boolean; text: string }
  | { kind: 'agent_activity'; workers: AgentWorker[]; active: boolean }
  | { kind: 'system'; text: string }
  | { kind: 'error'; text: string };

function flatten(items: UIItem[], width: number, tick: number): UILine[] {
  const lines: UILine[] = [];
  for (const item of items) {
    switch (item.kind) {
      case 'agent_activity': {
        const spin = item.active
          ? spinnerFrames[tick % spinnerFrames.length]
          : '✓';
        const running = item.workers.filter((w) => !w.done).length;
        lines.push({
          text: item.active
            ? `${spin} sub-agents — ${running} running`
            : `✓ sub-agents — ${item.workers.length} spawned`,
          color: theme.heading,
          copy: '',
        });
        for (const w of item.workers) {
          const mark = w.done ? '✓' : '▶';
          const color = w.done ? theme.toolOk : theme.heading;
          lines.push({
            text: `  ${mark} #${w.worker} ${w.role}` +
              (w.turns > 0 ? ` (${w.turns}t/${w.actions}a)` : ''),
            color,
            copy: '',
          });
          if (w.task) {
            wrapText(`      ↳ ${w.task}`, width).forEach((l) =>
              lines.push({ text: l, color: theme.muted, dim: true, copy: '' }),
            );
          }
          if (w.tools.length > 0) {
            // Cap the tool list so a long run can't balloon the card.
            const shown = w.tools.slice(-6);
            const extra = w.tools.length - shown.length;
            wrapText(
              `      ⚙ ${shown.join(', ')}${extra > 0 ? ` (+${extra})` : ''}`,
              width,
            ).forEach((l) =>
              lines.push({ text: l, color: theme.muted, dim: true, copy: '' }),
            );
          }
        }
        lines.push({ text: '' });
        break;
      }
      case 'user': {
        // Wrap long user messages with a hanging indent so they can never
        // overflow the pane (which wrapped at the terminal edge and broke
        // the layout math / status bar alignment).
        const wrapped = wrapText(item.text, Math.max(10, width - 2));
        wrapped.forEach((l, i) =>
          lines.push({
            text: i === 0 ? `❯ ${l}` : `  ${l}`,
            color: theme.user,
            copy: item.text,
          }),
        );
        lines.push({ text: '' });
        break;
      }
      case 'assistant':
        if (item.text) {
          richLines(item.text, width).forEach((l) => lines.push(l));
          lines.push({ text: '' });
        }
        break;
      case 'thinking':
        {
          // Live thinking line: one row, re-anchored to the tail so it
          // animates instead of growing a wall of wrapped text.
          const head = item.text.length > width ? '…' : '';
          const tail = item.text.slice(-(width - head.length));
          lines.push({ text: head + tail, color: theme.thinking, dim: true, copy: '' });
        }
        lines.push({ text: '' });
        break;
      case 'tool_start': {
        // `☄ name` in the tool color with the (compact) JSON args trailing
        // in muted text on the same line when it fits, else truncated.
        let snippet = item.args;
        try {
          snippet = JSON.stringify(JSON.parse(item.args));
        } catch {
          // keep the raw string — still bound below
        }
        const label = `☄ ${item.name}`;
        const maxSnippet = Math.max(10, width - label.length - 2);
        if (snippet.length > maxSnippet) snippet = snippet.slice(0, maxSnippet) + '…';
        lines.push({
          text: fitLine(`${label} ${snippet}`, width),
          copy: '',
          segments: [
            { text: label, color: theme.toolName },
            { text: ` ${snippet}`, color: theme.muted },
          ],
        });
        break;
      }
      case 'tool_result': {
        const status = item.ok ? '✔' : '✘';
        lines.push({
          text: `  ${status} ${item.name}`,
          color: item.ok ? theme.toolOk : theme.toolFail,
          copy: '',
        });
        wrapText(item.text, width).forEach((l) =>
          lines.push({ text: l, color: theme.muted, dim: true, copy: l }),
        );
        lines.push({ text: '' });
        break;
      }
      case 'system':
        wrapText(item.text, width).forEach((l) =>
          lines.push({ text: l, color: theme.system, copy: l }),
        );
        lines.push({ text: '' });
        break;
      case 'error':
        wrapText(item.text, width).forEach((l) =>
          lines.push({ text: l, color: theme.error, copy: l }),
        );
        lines.push({ text: '' });
        break;
    }
  }
  // Trim trailing blank lines.
  while (lines.length > 0 && lines[lines.length - 1].text === '') {
    lines.pop();
  }
  return lines;
}

/** Trim stray newlines at the edges of a pasted selection. */
function tidyCopied(text: string): string {
  return text.replace(/^\n+/, '').replace(/\n+$/, '');
}

interface Props {
  items: UIItem[];
  height: number; // available terminal lines for this pane
  width: number;
  thinking: boolean;
  /** When true, allow ↑/↓ arrows to scroll (i.e. when the prompt is empty). */
  scrollEnabled: boolean;
  /** Animation tick (drives the activity spinner). */
  tick?: number;
  /**
   * Selection mode (entered via Ctrl+K): ↑/↓ move a cursor through the
   * transcript, Enter copies the highlighted lines to the clipboard.
   */
  selMode?: boolean;
  /**
   * True while an interactive modal (login/models/settings/theme) owns the
   * keyboard: this pane's useInput stays registered (hook order must remain
   * stable) but ignores every key so it cannot eat the modal's input.
   */
  inputPaused?: boolean;
  /** Called with the selected text + number of selected lines on Enter. */
  onCopy?: (text: string, lines: number) => void;
  /** Called when the user cancels selection mode with Esc. */
  onCancelSel?: () => void;
}

export function MessageArea({
  items,
  height,
  width,
  thinking,
  scrollEnabled,
  tick = 0,
  selMode = false,
  inputPaused = false,
  onCopy,
  onCancelSel,
}: Props) {
  const paneWidth = Math.max(20, width - 2);
  const all = flatten(items, paneWidth, tick);
  const [offset, setOffset] = useState(0);
  const [stick, setStick] = useState(true);
  const maxOffset = Math.max(0, all.length - height);

  // ---- selection-mode state ----
  const [selCursor, setSelCursor] = useState(0);
  const [selAnchor, setSelAnchor] = useState(0);
  useEffect(() => {
    if (selMode) {
      const last = Math.max(0, all.length - 1);
      setSelCursor(last);
      setSelAnchor(last);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selMode]);

  // Re-anchor to the live tail when new content streams in while the user
  // hasn't intentionally scrolled up (stick = auto-follow).
  useEffect(() => {
    if (stick) setOffset(maxOffset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all.length, height, stick, maxOffset]);

  useInput((_input, key) => {
    // A modal owns the keyboard — never react (hook order stays stable).
    if (inputPaused) return;
    if (selMode) {
      // Esc always exits — even on an empty chat.
      if (key.escape) {
        onCancelSel?.();
        return;
      }
      if (all.length === 0) return;
      const maxIdx = all.length - 1;
      if (key.upArrow) {
        setSelCursor((c) => Math.max(0, Math.min(c, maxIdx) - 1));
        return;
      }
      if (key.downArrow) {
        setSelCursor((c) => Math.min(maxIdx, Math.min(c, maxIdx) + 1));
        return;
      }
      if (key.pageUp) {
        setSelCursor((c) => Math.max(0, Math.min(c, maxIdx) - height));
        return;
      }
      if (key.pageDown) {
        setSelCursor((c) => Math.min(maxIdx, Math.min(c, maxIdx) + height));
        return;
      }
      if (key.return) {
        const cur = Math.min(selCursor, maxIdx);
        const lo = Math.min(selAnchor, cur);
        const hi = Math.max(selAnchor, cur);
        const lines = all.slice(lo, hi + 1);
        const text = tidyCopied(
          lines.map((l) => (l.copy !== undefined ? l.copy : l.text)).join('\n'),
        );
        onCopy?.(text, hi - lo + 1);
        return;
      }
      return;
    }
    if (key.pageUp) {
      setStick(false);
      const base = stick ? maxOffset : offset;
      setOffset(Math.max(0, base - height));
      return;
    }
    if (key.pageDown) {
      const target = (stick ? maxOffset : offset) + height;
      if (target >= maxOffset) {
        setStick(true);
      } else {
        setStick(false);
        setOffset(target);
      }
      return;
    }
    // Fine-grained arrow scrolling when the prompt is empty (no conflict).
    if (scrollEnabled && all.length > height) {
      if (key.upArrow) {
        setStick(false);
        const base = stick ? maxOffset : offset;
        setOffset(Math.max(0, base - 1));
        return;
      }
      if (key.downArrow) {
        const base = stick ? maxOffset : offset;
        if (base >= maxOffset) {
          setStick(true);
        } else {
          setStick(false);
          setOffset(base + 1);
        }
        return;
      }
    }
  });

  let displayLines: UILine[];
  let displayBase = 0;
  let scrolledUp = false;
  let selLo = 0;
  let selHi = -1;

  if (selMode) {
    const cursor = Math.max(0, Math.min(selCursor, all.length - 1));
    displayBase = Math.max(
      0,
      Math.min(cursor - Math.floor(height / 2), maxOffset),
    );
    displayLines = all.slice(displayBase, displayBase + height);
    selLo = Math.min(selAnchor, cursor);
    selHi = Math.max(selAnchor, cursor);
  } else {
    const effectiveOffset = Math.max(0, Math.min(offset, maxOffset));
    displayLines =
      stick || all.length <= height
        ? all.slice(maxOffset)
        : all.slice(effectiveOffset, effectiveOffset + height);
    scrolledUp = !stick && all.length > height;
  }

  return (
    <Box flexDirection="column">
      {selMode ? (
        <Text color={theme.promptSymbol} bold>
          ⬚ select — ↑/↓ move · PgUp/PgDn page · Enter copy · Esc cancel
        </Text>
      ) : (
        scrolledUp && (
          <Text color={theme.muted}>
            ▲ scrolled · {Math.max(0, Math.min(offset, maxOffset))}/{maxOffset} · PgDn/↓ to follow
          </Text>
        )
      )}
      {displayLines.map((l, i) => {
        const idx = selMode ? displayBase + i : i;
        const selected = selMode && idx >= selLo && idx <= selHi;
        const text = l.text || ' ';
        if (l.inverse || selected) {
          return (
            <Text key={i} inverse color={l.color ?? 'white'}>
              {text}
            </Text>
          );
        }
        if (l.segments && l.segments.length > 0) {
          return (
            <Text key={i}>
              {l.segments.map((s, j) => (
                <Text
                  key={j}
                  color={s.color ?? l.color ?? 'white'}
                  bold={s.bold}
                  italic={s.italic}
                  underline={s.underline}
                  strikethrough={s.strikethrough}
                  dimColor={l.dim}
                >
                  {s.text}
                </Text>
              ))}
            </Text>
          );
        }
        return (
          <Text key={i} dimColor={l.dim} color={l.color ?? 'white'} bold={l.bold}>
            {text}
          </Text>
        );
      })}
      {thinking && !selMode && (
        <Text color={theme.thinking} dimColor>
          ◌ thinking…
        </Text>
      )}
    </Box>
  );
}
