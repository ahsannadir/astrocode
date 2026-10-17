/**
 * Unit tests for the theme registry (src/tui/theme.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  THEMES,
  THEME_NAMES,
  theme,
  setTheme,
  validThemeColors,
  themeRevision,
} from '../src/tui/theme.js';

const EXPECTED_KEYS = [
  'ascii', 'asciiAccent', 'star', 'user', 'assistant', 'assistantLabel',
  'system', 'error', 'toolName', 'toolOk', 'toolFail', 'muted', 'border',
  'status', 'prompt', 'promptSymbol', 'thinking', 'title', 'plan', 'heading',
  'bullet', 'code', 'synKeyword', 'synString', 'synNumber', 'synComment',
  'synFunction', 'synType', 'synPunct', 'synAdd', 'synDel', 'codeBorder',
];

test('themes: registry has astro plus several palettes', () => {
  assert.ok(THEME_NAMES.includes('astro'));
  assert.ok(THEME_NAMES.length >= 5, `expected >=5 themes, got ${THEME_NAMES.length}`);
  assert.ok(new Set(THEME_NAMES).size === THEME_NAMES.length, 'theme names unique');
});

test('themes: every palette defines every key with a valid ink color', () => {
  for (const name of THEME_NAMES) {
    const t = THEMES[name];
    assert.ok(t, `${name} missing`);
    for (const k of EXPECTED_KEYS) {
      assert.ok(k in t, `${name} missing key ${k}`);
      assert.equal(typeof t[k], 'string', `${name}.${k} not a string`);
    }
    assert.ok(validThemeColors(t), `${name} has a non-ink color: ${JSON.stringify(t)}`);
  }
});

/** WCAG relative luminance for a #rrggbb string. */
function luminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('themes: palettes resolve to truecolor hex, not terminal-palette names', () => {
  // Named colors inherit whatever the user's terminal scheme paints that
  // slot — schemes that map brightBlack onto their background erase every
  // `muted` label. Hex keeps a palette identical everywhere.
  for (const name of THEME_NAMES) {
    for (const [k, color] of Object.entries(THEMES[name])) {
      assert.match(color, /^#[0-9a-f]{6}$/i, `${name}.${k} is not hex: ${color}`);
    }
  }
});

test('themes: every color stays readable on a near-black background', () => {
  // 4.5:1 is the WCAG AA floor for body text. The panes are painted on the
  // terminal's own background, which is dark for every theme we ship.
  for (const name of THEME_NAMES) {
    for (const [k, color] of Object.entries(THEMES[name])) {
      const ratio = contrast(color, '#121212');
      assert.ok(
        ratio >= 4.5,
        `${name}.${k} (${color}) only reaches ${ratio.toFixed(1)}:1 on #121212`,
      );
    }
  }
});

test('themes: default active palette is astro', () => {
  assert.deepEqual(theme, THEMES.astro);
});

test('themes: setTheme swaps the palette in place and reports the name', () => {
  const before = { ...theme };
  assert.equal(setTheme('ocean'), 'ocean');
  assert.equal(theme.prompt, THEMES.ocean.prompt);
  assert.notDeepEqual(theme, before);
});

test('themes: setTheme falls back to astro for unknown/empty names', () => {
  assert.equal(setTheme('nope'), 'astro');
  assert.equal(setTheme(''), 'astro');
  assert.equal(setTheme(undefined), 'astro');
  assert.deepEqual(theme, THEMES.astro);
});

test('themes: setTheme bumps the revision so color caches invalidate', () => {
  setTheme('astro');
  const before = themeRevision;
  setTheme('dracula');
  assert.ok(themeRevision > before, 'revision should increase on theme change');
  assert.equal(theme.synKeyword, THEMES.dracula.synKeyword);
  setTheme('astro');
});
