import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme, spinnerFrames } from './theme.js';

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

/** One styled span inside a line (markdown-lite inline: **bold**, `code`). */
export interface UISegment {
  text: string;
  color?: string;
  bold?: boolean;
}

interface UILine {
  text: string;
  color?: string;
  dim?: boolean;
  inverse?: boolean;
  bold?: boolean;
  /**
   * Styled spans to render instead of `text` (which must stay the plain
   * concatenation of the segments so selection/copy keeps working).
   */
  segments?: UISegment[];
  /**
   * Plain text to copy when this line is inside a selection. Chrome-only
   * lines (labels, tool banners, activity cards) set copy: '' so they are
   * skipped; lines without a copy field copy their visible text as-is.
   */
  copy?: string;
}

/**
 * Wrap long text into lines of at most `width` characters (greedy).
 * Falls back to hard-cutting words longer than the width (e.g. URLs or
 * minified code) instead of letting them overflow the pane, where they
 * wrap and corrupt the layout math.
 */
function wrapText(text: string, width: number): string[] {
  if (width <= 1) return [text];
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine === '') {
      out.push('');
      continue;
    }
    let line = rawLine;
    while (line.length > width) {
      let cut = line.lastIndexOf(' ', width);
      if (cut <= 0) cut = width; // hard-cut overlong unbroken tokens
      out.push(line.slice(0, cut));
      line = line.slice(cut).replace(/^ /, '');
    }
    out.push(line);
  }
  return out;
}

/** Keep a single UI row within `width` cells (ellipsis for the overflow). */
function fitLine(text: string, width: number): string {
  if (width <= 0 || text.length <= width) return text;
  return width <= 1 ? '…' : text.slice(0, width - 1) + '…';
}

/**
 * Parse markdown-lite inline spans (**bold**, `code`) from a single wrapped
 * line into styled segments. Unknown markers are left untouched, so plain
 * text (and code that happens to contain backticks at line boundaries)
 * degrades gracefully.
 */
function inlineSegments(line: string, base?: string): UISegment[] {
  const segs: UISegment[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) segs.push({ text: line.slice(last, m.index), color: base });
    const tok = m[0];
    if (tok.startsWith('**')) {
      segs.push({ text: tok.slice(2, -2), color: base, bold: true });
    } else {
      segs.push({ text: tok.slice(1, -1), color: theme.code });
    }
    last = m.index + tok.length;
  }
  if (last < line.length) segs.push({ text: line.slice(last), color: base });
  return segs.length > 0 ? segs : [{ text: line, color: base }];
}

/**
 * Markdown-lite renderer for assistant text: converts headings, bullets,
 * blockquotes, code fences, and inline bold/code into thematically-colored
 * lines. Content lines carry `copy` so a selection pastes clean text (no
 * `#`/`-`/`**`/backtick markers, no ``` fence bars).
 */
function richLines(text: string, width: number): UILine[] {
  const out: UILine[] = [];
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      wrapText(line.trim(), width).forEach((l) =>
        out.push({ text: l, color: theme.muted, dim: true, copy: '' }),
      );
      continue;
    }
    if (fence) {
      wrapText(line, width).forEach((l) =>
        out.push({ text: l, color: theme.code, copy: l }),
      );
      continue;
    }
    let color: string = theme.assistant;
    let display = line;
    let bold = false;
    if (/^#{1,3}\s+/.test(line)) {
      color = theme.heading;
      display = line.replace(/^#{1,3}\s+/, '').trim();
      bold = true;
    } else if (/^\s*[-*]\s+/.test(line)) {
      color = theme.bullet;
      display = '  • ' + line.replace(/^\s*[-*]\s+/, '');
    } else if (/^\s*>\s?/.test(line)) {
      color = theme.muted;
      display = '▍ ' + line.replace(/^\s*>\s?/, '');
    }
    wrapText(display === '' ? line : display, width).forEach((l) =>
      out.push({ text: l, color, bold, copy: l, segments: inlineSegments(l, color) }),
    );
  }
  return out;
}

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
