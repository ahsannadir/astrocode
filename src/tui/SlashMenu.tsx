import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import type { SlashCommandDef } from '../commands/slash.js';

interface Props {
  /** Every filtered slash command (the menu windows over the full list). */
  matches: SlashCommandDef[];
  /** Index of the currently highlighted command (absolute, into `matches`). */
  sel: number;
  /** Usable width for the menu pane, including its border and padding. */
  width?: number;
  /** Max rows to render at once; extra matches scroll under the highlight. */
  maxRows?: number;
}

/**
 * A floating overlay menu of slash commands, shown when the user types "/".
 * Every match is reachable — `maxRows` caps how many rows are visible and the
 * window follows the highlight, so "/" + ↑/↓ can browse the whole catalog
 * without the menu outgrowing the terminal. Rows and the hint line are
 * truncated to the pane width so long descriptions can never wrap and push
 * the layout taller than the reserved space.
 */
export function SlashMenu({ matches, sel, width, maxRows }: Props) {
  // -4: rounded border (2) + paddingX (2). `width` is already the width we get
  // after the parent's marginX, so `inner` is the true content width.
  const inner = Math.max(24, (width ?? 120) - 4);
  const total = matches.length;
  const rows = Math.max(1, Math.min(maxRows ?? total, total));
  // Keep the highlighted row inside the visible window.
  const start = Math.max(0, Math.min(sel - rows + 1, total - rows));
  const window = matches.slice(start, start + rows);
  const position = total > rows ? ` · ${start + 1}–${start + rows}/${total}` : '';
  const hint = `↑↓ navigate · Tab complete · Enter run · Esc close${position}`;
  return (
    <Box
      borderStyle="round"
      borderColor={theme.promptSymbol}
      paddingX={1}
      paddingY={0}
      flexDirection="column"
    >
      <Box flexDirection="column">
        {window.map((c, i) => {
          const idx = start + i;
          const active = idx === sel;
          const name = ` ${c.name}`;
          const desc = `  —  ${c.description}`;
          // Row = marker(1) + name + description, so the description may use
          // `inner - name - 1` cells. Ignoring the marker column let a row run
          // one cell long, wrap, and push the whole frame onto Ink's
          // direct-write path — the repaint stall this menu used to trigger.
          const room = Math.max(0, inner - name.length - 1);
          return (
            <Box key={c.name} flexDirection="row">
              <Text color={active ? theme.promptSymbol : theme.muted} bold={active}>
                {active ? '❯' : ' '}
              </Text>
              <Text color={active ? theme.prompt : theme.muted} bold={active}>
                {name}
              </Text>
              <Text color={theme.muted}>
                {desc.length > room ? desc.slice(0, Math.max(1, room - 1)) + '…' : desc}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Text color={theme.muted}>{hint.length > inner ? hint.slice(0, inner - 1) + '…' : hint}</Text>
    </Box>
  );
}
