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
} from '../src/tui/theme.js';

const EXPECTED_KEYS = [
  'ascii', 'asciiAccent', 'star', 'user', 'assistant', 'assistantLabel',
  'system', 'error', 'toolName', 'toolOk', 'toolFail', 'muted', 'border',
  'status', 'prompt', 'promptSymbol', 'thinking', 'title', 'plan', 'heading',
  'bullet', 'code',
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
