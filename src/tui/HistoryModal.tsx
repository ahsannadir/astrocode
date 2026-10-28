import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from './theme.js';
import { scrollWindow } from './layout.js';
import { relativeAge } from './history.js';
import type { SessionMeta } from '../sessions.js';

interface Props {
  /** Saved sessions, newest first (see listSessions). */
  sessions: SessionMeta[];
  /** The session currently open (gets a ✓ marker). */
  current: string;
  /**
   * Row budget for the list region — the "↑/↓ n more…" notices come out of
   * it, so the popup never outgrows its reservation (terminal-height aware).
   */
  maxRows: number;
  /** Resume the highlighted session. */
  onSelect: (name: string) => void;
  onCancel: () => void;
}

/** Keep a session name readable inside one list row. */
const NAME_MAX = 30;
const shortName = (n: string) => (n.length > NAME_MAX ? `${n.slice(0, NAME_MAX - 1)}…` : n);

/**
 * The /history popup — saved conversations, newest first. ↑/↓ highlight
 * (scrolling through long lists), Enter loads the chat into the transcript and
 * continues the same session, Esc cancels.
 */
export function HistoryModal({ sessions, current, maxRows, onSelect, onCancel }: Props) {
  const count = sessions.length;
  const [sel, setSel] = useState(() => {
    const idx = sessions.findIndex((s) => s.name === current);
    return idx >= 0 ? idx : 0;
  });

  useInput(
    (input, key) => {
      // Esc closes even when there is nothing to restore.
      if (key.escape) {
        onCancel();
        return;
      }
      if (input === '[H' || input === 'OH') {
        if (count > 0) setSel(0);
        return;
      }
      if (input === '[F' || input === 'OF') {
        if (count > 0) setSel(count - 1);
        return;
      }
      if (count === 0) return;
      if (key.upArrow) {
        setSel((s) => (s - 1 + count) % count);
        return;
      }
      if (key.downArrow) {
        setSel((s) => (s + 1) % count);
        return;
      }
      if (key.return) {
        const pick = sessions[sel];
        if (pick) onSelect(pick.name);
      }
    },
    { isActive: true },
  );

  // Same windowing contract as the other pickers: maxRows is the whole list
  // region, scroll notices included.
  const win = scrollWindow(count, sel, maxRows ?? count);
  const { start, hasMoreUp, hasMoreDown } = win;
  const visible = sessions.slice(start, start + win.count);
  const empty = count === 0;

  return (
    <Box borderStyle="double" borderColor={theme.promptSymbol} paddingX={1} flexDirection="column">
      <Text color={theme.title} bold>
        🕘 Previous chats
      </Text>
      {hasMoreUp && <Text color={theme.muted}>↑ {start} more…</Text>}
      <Box flexDirection="column">
        {empty ? (
          <Text color={theme.muted}>No saved chats yet — one is written after each turn.</Text>
        ) : null}
        {visible.map((s, i) => {
          const active = start + i === sel;
          const isCurrent = s.name === current;
          return (
            <Box key={s.name} flexDirection="row">
              <Text color={active ? theme.promptSymbol : theme.muted} bold={active}>
                {active ? '❯' : ' '}
              </Text>
              <Text color={active ? theme.prompt : theme.muted} bold={active}>
                {' '}
                {shortName(s.name)}
              </Text>
              {isCurrent ? <Text color={theme.toolOk}> ✓</Text> : null}
              <Box flexGrow={1} />
              <Text color={theme.muted}>
                {s.messages} msg{s.messages === 1 ? '' : 's'} · {relativeAge(s.updatedAt)}
              </Text>
            </Box>
          );
        })}
      </Box>
      {hasMoreDown && (
        <Text color={theme.muted}>↓ {count - start - win.count} more…</Text>
      )}
      <Text color={theme.muted}>
        {empty ? 'Esc close' : '↑↓ navigate · Enter resume · Esc cancel'}
      </Text>
    </Box>
  );
}
