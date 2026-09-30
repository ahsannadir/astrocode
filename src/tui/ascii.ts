/**
 * ASTROCODE wordmark built from a consistent 6×5 block-letter font.
 * Each glyph is 6 columns wide and 5 rows tall; the word is composed by
 * joining glyphs with single spaces so alignment is always perfect.
 */

type Glyph = [string, string, string, string, string];

const GLYPHS: Record<string, Glyph> = {
  A: [' ███  ', '██ ██ ', '█████ ', '██ ██ ', '██ ██ '],
  S: ['█████ ', '██    ', '█████ ', '   ██ ', '█████ '],
  T: ['██████', '  ██  ', '  ██  ', '  ██  ', '  ██  '],
  R: ['████  ', '██  ██', '████  ', '██ ██ ', '██  ██'],
  O: [' ████ ', '██  ██', '██  ██', '██  ██', ' ████ '],
  C: [' ████ ', '██    ', '██    ', '██    ', ' ████ '],
  D: ['████  ', '██  ██', '██  ██', '██  ██', '████  '],
  E: ['█████ ', '██    ', '████  ', '██    ', '█████ '],
};

const WORD = 'ASTROCODE';

export const ASCII_LINES: string[] = Array.from({ length: 5 }, (_, row) =>
  WORD.split('')
    .map((c) => GLYPHS[c][row])
    .join(' '),
);

export function renderAsciiText(color: (s: string) => string = (s) => s): string {
  const star = '✦';
  const header = `${star} ASTROCODE ${star}`;
  const footer = `${star} ✦ AI TERMINAL CODING AGENT ✦ ${star}`;
  return [header, ...ASCII_LINES, footer]
    .map((l) => (l ? color(l) : l))
    .join('\n');
}

