import React from 'react';
import { Box, Text } from 'ink';
import { theme, starFrames, type Theme } from './theme.js';
import { ASCII_LINES } from './ascii.js';
import { VERSION } from '../config.js';

/**
 * Color the wordmark row by row: the palette's base hue with a single
 * accent band across the middle — "lit from the center", calmer than
 * striping every other row.
 */
function rowColor(t: Theme, row: number): string {
  return row === 2 ? t.asciiAccent : t.ascii;
}

/**
 * Render the ASTROCODE wordmark. The header stars twinkle based on tick;
 * the tagline and version stay quiet so the glyph block stays the hero.
 */
export function Banner({ tick }: { tick: number }) {
  const star1 = starFrames[tick % starFrames.length];
  const star2 = starFrames[(tick + 2) % starFrames.length];
  return (
    <Box flexDirection="column" alignItems="center" marginBottom={0}>
      <Box justifyContent="space-between" width="100%" paddingX={1}>
        <Text>
          <Text color={theme.star}>{star1}</Text>{' '}
          <Text color={theme.ascii}>ASTROCODE</Text>{' '}
          <Text color={theme.star}>{star2}</Text>
        </Text>
        <Text color={theme.muted}>v{VERSION}</Text>
      </Box>
      {ASCII_LINES.map((line, i) => (
        <Text key={i} color={rowColor(theme, i)}>
          {line}
        </Text>
      ))}
      <Text color={theme.muted}>✦ AI TERMINAL CODING AGENT ✦</Text>
    </Box>
  );
}
