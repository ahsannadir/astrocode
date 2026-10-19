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

test('themes: every palette defines every key with a valid truecolor value', () => {
  for (const name of THEME_NAMES) {
    const t = THEMES[name];
    assert.ok(t, `${name} missing`);
    for (const k of EXPECTED_KEYS) {
      assert.ok(k in t, `${name} missing key ${k}`);
      assert.equal(typeof t[k], 'string', `${name}.${k} not a string`);
    }
    assert.ok(validThemeColors(t), `${name} has a non-hex color: ${JSON.stringify(t)}`);
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

test('themes: palettes are truecolor hex, not terminal-palette names', () => {
  // Named colors inherit whatever the user's terminal scheme paints that
  // slot — schemes that map brightBlack onto their background erase every
  // `muted` label. Hex keeps a palette identical everywhere.
  for (const name of THEME_NAMES) {
    for (const [k, color] of Object.entries(THEMES[name])) {
      assert.match(color, /^#[0-9a-f]{6}$/i, `${name}.${k} is not hex: ${color}`);
    }
  }
});

test('themes: each palette has its own dominant hue', () => {
  // Thirteen themes that all lean on the same cyan-magenta-green triple read as
  // one theme. Primary hues (the border/banner color) must stay far enough
  // apart to tell palettes apart at a glance. `noir` is achromatic by design.
  const hue = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) return -1;
    const d = max - min;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return Math.round((h * 60 + 360) % 360);
  };
  const gap = (a: number, b: number): number => {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  };

  const hues = THEME_NAMES.filter((n) => n !== 'noir').map((n) => ({
    name: n,
    hue: hue(THEMES[n].border),
  }));
  for (let i = 0; i < hues.length; i++) {
    for (let j = i + 1; j < hues.length; j++) {
      const d = gap(hues[i].hue, hues[j].hue);
      assert.ok(
        d >= 15,
        `${hues[i].name} and ${hues[j].name} are only ${d}° apart`,
      );
    }
  }
});

test('themes: cyberpunk reads as red', () => {
  const t = THEMES.cyberpunk;
  const hue = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  for (const role of ['border', 'toolName', 'heading', 'promptSymbol', 'title'] as const) {
    const h = hue(t[role]);
    assert.ok(h <= 20 || h >= 340, `cyberpunk.${role} (${t[role]}) is not red`);
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

test('themes: default active palette is cyberpunk', () => {
  assert.deepEqual(theme, THEMES.cyberpunk);
});

test('themes: setTheme swaps the palette in place and reports the name', () => {
  const before = { ...theme };
  assert.equal(setTheme('ocean'), 'ocean');
  assert.equal(theme.prompt, THEMES.ocean.prompt);
  assert.notDeepEqual(theme, before);
});

test('themes: setTheme falls back to cyberpunk for unknown/empty names', () => {
  assert.equal(setTheme('nope'), 'cyberpunk');
  assert.equal(setTheme(''), 'cyberpunk');
  assert.equal(setTheme(undefined), 'cyberpunk');
  assert.deepEqual(theme, THEMES.cyberpunk);
});

test('themes: setTheme bumps the revision so color caches invalidate', () => {
  setTheme('astro');
  const before = themeRevision;
  setTheme('dracula');
  assert.ok(themeRevision > before, 'revision should increase on theme change');
  assert.equal(theme.synKeyword, THEMES.dracula.synKeyword);
  setTheme('astro');
});
