import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import type { Todo } from '../todos.js';

interface Props {
  todos: Todo[];
  /** Max number of rows to render (older tasks trimmed). */
  maxRows?: number;
  /** Usable inner width for truncating task rows (optional). */
  width?: number;
}

/**
 * A compact, live task panel. Shown above the prompt only when there are
 * tasks, so the user always sees what the agent is working through —
 * inspired by Claude Code's TodoWrite, tuned for the terminal.
 */
export function TodoPanel({ todos, maxRows = 6, width }: Props) {
  if (todos.length === 0) return null;
  const visible = todos.slice(-maxRows);
  const trimmed = todos.length - visible.length;
  const done = todos.filter((t) => t.status === 'completed').length;
  const cells = 8;
  const filled = Math.round((done / todos.length) * cells);
  const bar = '▰'.repeat(filled) + '▱'.repeat(cells - filled);
  // -4: rounded border (2) + paddingX (2); header row: "▣ tasks ── n/n bar".
  const inner = Math.max(20, (width ?? 120) - 4);
  const taskRoom = Math.max(10, inner - 4); // mark + space per task row
  return (
    <Box
      borderStyle="round"
      borderColor={theme.plan}
      paddingX={1}
      flexDirection="column"
    >
      <Box flexDirection="row">
        <Text color={theme.plan} bold>▣ tasks</Text>
        <Text color={theme.muted}> ── </Text>
        <Text color={theme.toolOk}>{done}/{todos.length}</Text>
        <Text color={theme.muted}> </Text>
        <Text color={done === todos.length ? theme.toolOk : theme.plan}>{bar}</Text>
      </Box>
      {trimmed > 0 && (
        <Text color={theme.muted}>▲ {trimmed} earlier task(s) hidden</Text>
      )}
      {visible.map((t) => {
        const mark =
          t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '○';
        const color =
          t.status === 'completed'
            ? theme.toolOk
            : t.status === 'in_progress'
              ? theme.heading
              : theme.muted;
        const text =
          t.status === 'completed'
            ? t.text
            : t.status === 'in_progress'
              ? `${t.text} …`
              : t.text;
        const body = `${t.id}: ${text}`;
        const shown =
          body.length > taskRoom ? body.slice(0, Math.max(1, taskRoom - 1)) + '…' : body;
        return (
          <Box key={t.id} flexDirection="row">
            <Text color={color}>{mark} </Text>
            <Text color={color} dimColor={t.status !== 'in_progress'}>
              {shown}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
