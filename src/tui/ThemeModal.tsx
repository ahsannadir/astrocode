import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme, THEMES, THEME_NAMES } from './theme.js';

interface Props {
  /** The currently active theme name (gets a ✓ marker). */
  current: string;
  /** How many rows fit on screen at once (terminal-height aware). */
  maxRows?: number;
  /** Called with the chosen theme name when the user confirms. */
  onSelect: (name: string) => void;
  onCancel: () => void;
}

/**
 * The /theme popup — an opencode-style list of palettes. Each row shows the
 * theme's own colors as a small swatch, so you see the palette before picking.
 * ↑/↓ highlight (scrolling through long lists), Enter applies, Esc cancels;
 * typing a letter jumps to it.
 */
export function ThemeModal({ current, maxRows, onSelect, onCancel }: Props) {
  const [sel, setSel] = useState(() => {
    const idx = THEME_NAMES.indexOf(current);
    return idx >= 0 ? idx : 0;
  });
  const nameW = Math.max(...THEME_NAMES.map((n) => n.length));

  useInput(
    (input, key) => {
      if (key.upArrow) {
        setSel((s) => (s - 1 + THEME_NAMES.length) % THEME_NAMES.length);
        return;
      }
      if (key.downArrow) {
        setSel((s) => (s + 1) % THEME_NAMES.length);
        return;
      }
      if (key.return) {
        onSelect(THEME_NAMES[sel]);
        return;
      }
      if (key.escape) {
        onCancel();
        return;
      }
      // Type-ahead: jump to the first theme starting with the typed char.
      // Single printable characters only — multi-char input is a paste or an
      // escape sequence fragment, never a navigation keystroke.
      if (input.length === 1 && input.charCodeAt(0) >= 32) {
        const idx = THEME_NAMES.findIndex((n) => n.startsWith(input.toLowerCase()));
        if (idx >= 0) setSel(idx);
      }
    },
    { isActive: true },
  );

  // Scroll window (same treatment as the models picker): keep the selection
  // centered within maxRows so the modal never outgrows the terminal.
  const count = Math.max(1, Math.min(maxRows ?? THEME_NAMES.length, THEME_NAMES.length));
  const start = Math.max(
    0,
    Math.min(
      sel - Math.floor((count - 1) / 2),
      Math.max(0, THEME_NAMES.length - count),
    ),
  );
  const visible = THEME_NAMES.slice(start, start + count);
  const hasMoreUp = start > 0;
  const hasMoreDown = start + count < THEME_NAMES.length;

  return (
    <Box borderStyle="double" borderColor={theme.promptSymbol} paddingX={1} flexDirection="column">
      <Text color={theme.title} bold>
        🎨 Select a theme
      </Text>
      <Text color={theme.muted} dimColor>
        Themes persist to ~/.astrocode/config.json (env ASTROCODE_THEME wins).
      </Text>
      {hasMoreUp && <Text color={theme.muted}>↑ {start} more…</Text>}
      <Box flexDirection="column">
        {visible.map((name, i) => {
          const active = start + i === sel;
          const t = THEMES[name];
          const isCurrent = name === current;
          return (
            <Box key={name} flexDirection="row">
              <Text color={active ? theme.promptSymbol : theme.muted} bold={active}>
                {active ? '❯' : ' '}
              </Text>
              <Text color={active ? theme.prompt : theme.muted} bold={active}>
                {' '}
                {name.padEnd(nameW)}
              </Text>
              <Text>  </Text>
              {/* Swatch sampled from the palette itself. */}
              <Text color={t.ascii}>██</Text>
              <Text color={t.promptSymbol}>██</Text>
              <Text color={t.prompt}>██</Text>
              <Text color={t.status}>██</Text>
              <Text color={t.title}>██</Text>
              {isCurrent ? <Text color={theme.toolOk}>  ✓ active</Text> : null}
            </Box>
          );
        })}
      </Box>
      {hasMoreDown && (
        <Text color={theme.muted}>↓ {THEME_NAMES.length - start - count} more…</Text>
      )}
      <Text color={theme.muted}>↑↓ navigate · Enter apply · Esc cancel</Text>
    </Box>
  );
}
