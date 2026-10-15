import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme, THEMES, THEME_NAMES } from './theme.js';
import { scrollWindow } from './layout.js';
import { isPrintableChar } from './inputEdit.js';

interface Props {
  /** The currently active theme name (gets a ✓ marker). */
  current: string;
  /**
   * Row budget for the list region — the "↑/↓ n more…" notices come out of
   * it, so the modal never outgrows its reservation (terminal-height aware).
   */
  maxRows?: number;
  /**
   * Called with the highlighted theme name as the selection moves, so the
   * whole UI repaints in that palette before the user commits (live preview).
   */
  onPreview: (name: string) => void;
  /** Called with the chosen theme name when the user confirms. */
  onSelect: (name: string) => void;
  onCancel: () => void;
}

/**
 * The /theme popup — an opencode-style list of palettes. Each row shows the
 * theme's own colors as a small swatch, so you see the palette before picking.
 * ↑/↓ highlight (scrolling through long lists), Enter applies, Esc reverts;
 * typing a letter jumps to it.
 *
 * Moving the highlight previews the palette LIVE: the parent applies it on
 * every change, so the banner, transcript and status bar repaint in the
 * highlighted theme as you scroll. Esc restores the theme that was live when
 * the popup opened, so a previewed-but-unconfirmed palette never sticks.
 */
export function ThemeModal({ current, maxRows, onPreview, onSelect, onCancel }: Props) {
  const [sel, setSel] = useState(() => {
    const idx = THEME_NAMES.indexOf(current);
    return idx >= 0 ? idx : 0;
  });
  const nameW = Math.max(...THEME_NAMES.map((n) => n.length));
  // The palette that was live when the popup opened (initial `current`); the
  // ref keeps it stable because `current` follows the live preview.
  const originRef = useRef(current);

  // Live preview: every highlight move (arrows, type-ahead, wrap-around)
  // repaints the app in the highlighted palette. The parent holds the applied
  // name in state, so this also re-renders the rest of the tree — the mutated
  // `theme` singleton alone would only repaint the modal.
  useEffect(() => {
    onPreview(THEME_NAMES[sel]);
  }, [sel, onPreview]);

  /** Esc: put the original palette back before closing the popup. */
  const cancel = () => {
    onPreview(originRef.current);
    onCancel();
  };

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
        cancel();
        return;
      }
      // Type-ahead: jump to the first theme starting with the typed char.
      // Single printable characters only — multi-char input is a paste or an
      // escape sequence fragment, and control bytes (DEL included) are never a
      // navigation keystroke.
      if (isPrintableChar(input)) {
        const idx = THEME_NAMES.findIndex((n) => n.startsWith(input.toLowerCase()));
        if (idx >= 0) setSel(idx);
      }
    },
    { isActive: true },
  );

  // Scroll window (same treatment as the models picker): maxRows covers the
  // "↑/↓ n more…" notices too, so the modal never outgrows its reservation.
  const win = scrollWindow(THEME_NAMES.length, sel, maxRows ?? THEME_NAMES.length);
  const { count, start, hasMoreUp, hasMoreDown } = win;
  const visible = THEME_NAMES.slice(start, start + count);

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
      <Text color={theme.muted}>↑↓ preview live · Enter apply · Esc revert</Text>
    </Box>
  );
}
