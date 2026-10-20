import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';

interface Props {
  /** Every filtered path (the menu windows over the full list). */
  matches: string[];
  /** Index of the currently highlighted path (absolute, into `matches`). */
  sel: number;
  /** Usable width for the menu pane, including its border and padding. */
  width?: number;
  /** Max rows to render at once; extra matches scroll under the highlight. */
  maxRows?: number;
}

/** Split a repo-relative path into its basename and its directory part. */
function splitPath(p: string): { base: string; dir: string } {
  const i = p.lastIndexOf('/');
  if (i < 0) return { base: p, dir: '' };
  return { base: p.slice(i + 1), dir: p.slice(0, i + 1) };
}

/**
 * The `@` file picker. Rendered exactly like SlashMenu — same border, same
 * scroll window, same row budget — because it occupies the same reserved
 * space above the prompt box (only one completion menu is ever open).
 *
 * Rows are truncated to the pane width: a long path that wrapped would add a
 * row the layout did not reserve, which is how a frame creeps onto Ink's
 * direct-write path.
 */
export function FileMenu({ matches, sel, width, maxRows }: Props) {
  // -4: rounded border (2) + paddingX (2).
  const inner = Math.max(24, (width ?? 120) - 4);
  const total = matches.length;
  const rows = Math.max(1, Math.min(maxRows ?? total, total));
  const start = Math.max(0, Math.min(sel - rows + 1, total - rows));
  const window = matches.slice(start, start + rows);
  const position = total > rows ? ` · ${start + 1}–${start + rows}/${total}` : '';
  const hint = `↑↓ navigate · Tab complete · Enter insert · Esc close${position}`;
  return (
    <Box
      borderStyle="round"
      borderColor={theme.promptSymbol}
      paddingX={1}
      paddingY={0}
      flexDirection="column"
    >
      <Box flexDirection="column">
        {window.map((p, i) => {
          const idx = start + i;
          const active = idx === sel;
          const { base, dir } = splitPath(p);
          const marker = ' ';
          // marker + basename + directory, so the directory may use what is
          // left after the name (and one gap cell).
          const room = Math.max(0, inner - base.length - marker.length - 1);
          let shownDir = dir;
          if (shownDir.length > room) {
            shownDir =
              room <= 1 ? '' : '…' + shownDir.slice(shownDir.length - room + 1);
          }
          const shownBase = base.length > inner - marker.length - 1
            ? base.slice(0, Math.max(1, inner - marker.length - 2)) + '…'
            : base;
          return (
            <Box key={p} flexDirection="row">
              <Text color={active ? theme.promptSymbol : theme.muted} bold={active}>
                {active ? '❯' : marker}
              </Text>
              <Text color={active ? theme.prompt : theme.muted} bold={active}>
                {shownBase}
              </Text>
              {shownDir ? <Text color={theme.muted}>{`  ${shownDir}`}</Text> : null}
            </Box>
          );
        })}
      </Box>
      <Text color={theme.muted}>{hint.length > inner ? hint.slice(0, inner - 1) + '…' : hint}</Text>
    </Box>
  );
}
