import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import type { SlashCommandDef } from '../commands/slash.js';

interface Props {
  /** The filtered slash commands (0..8) to show in the overlay. */
  matches: SlashCommandDef[];
  /** Index of the currently highlighted command. */
  sel: number;
  /** Usable inner width for truncating command rows (optional). */
  width?: number;
}

/**
 * A floating overlay menu of slash commands, shown when the user types "/".
 * Rows are truncated to the pane width so long descriptions can never wrap
 * and push the layout taller than the reserved space.
 */
export function SlashMenu({ matches, sel, width }: Props) {
  // -4: rounded border (2) + paddingX (2). Row chrome: "❯ /name  —  desc".
  const inner = Math.max(24, (width ?? 120) - 4);
  return (
    <Box
      borderStyle="round"
      borderColor={theme.promptSymbol}
      paddingX={1}
      paddingY={0}
      flexDirection="column"
    >
      <Box flexDirection="column">
        {matches.map((c, i) => {
          const active = i === sel;
          const name = ` ${c.name}`;
          const desc = `  —  ${c.description}`;
          const room = Math.max(0, inner - name.length);
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
      <Text color={theme.muted}>↑↓ navigate · Enter select · Esc close</Text>
    </Box>
  );
}
