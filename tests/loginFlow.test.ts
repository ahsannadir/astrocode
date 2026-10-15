/**
 * Tests for the /login flow's provider routing (src/tui/loginFlow.ts).
 *
 * Covers the reuse path: someone who already connected an 'OpenAI Compatible'
 * endpoint picks that provider again and gets "Use existing configuration" /
 * "Configure again" instead of being forced through the wizard a second time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existingCustomConfig,
  moveReuseSel,
  providerEntryStage,
  reuseRowAt,
  REUSE_ROWS,
} from '../src/tui/loginFlow.js';

test('providerEntryStage: hosted providers always go to the API-key stage', () => {
  for (const id of ['openai', 'anthropic', 'tokenrouter', 'openrouter']) {
    assert.equal(providerEntryStage(id, false), 'key');
    assert.equal(providerEntryStage(id, true), 'key');
  }
});

test('providerEntryStage: a saved custom endpoint offers reuse, otherwise the wizard', () => {
  assert.equal(providerEntryStage('openai-compatible', true), 'existing');
  assert.equal(providerEntryStage('openai-compatible', false), 'baseurl');
});

test('existingCustomConfig: only a saved custom endpoint with a base URL counts', () => {
  assert.deepEqual(
    existingCustomConfig({
      provider: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.1:70b',
    }),
    { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1:70b' },
  );
  // Whitespace-padded values from a hand-edited config file.
  assert.deepEqual(
    existingCustomConfig({ provider: 'openai-compatible', baseUrl: ' http://x/v1 ', model: ' m ' }),
    { baseUrl: 'http://x/v1', model: 'm' },
  );
  // A keyless endpoint is still a real configuration (Ollama, LM Studio).
  assert.deepEqual(
    existingCustomConfig({ provider: 'openai-compatible', baseUrl: 'http://x/v1' }),
    { baseUrl: 'http://x/v1', model: '' },
  );
});

test('existingCustomConfig: nothing to reuse for other providers or empty input', () => {
  assert.equal(existingCustomConfig(null), null);
  assert.equal(existingCustomConfig(undefined), null);
  assert.equal(existingCustomConfig({}), null);
  assert.equal(
    existingCustomConfig({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' }),
    null,
  );
  // loadConfig() falls back to a default base URL at runtime; the saved file
  // is what decides, so an absent baseUrl is genuinely "not configured".
  assert.equal(existingCustomConfig({ provider: 'openai-compatible', model: 'llama3' }), null);
  assert.equal(
    existingCustomConfig({ provider: 'openai-compatible', baseUrl: '   ', model: 'llama3' }),
    null,
  );
});

test('the reuse prompt offers both choices, reuse first', () => {
  assert.deepEqual([...REUSE_ROWS], ['use-existing', 'configure-again']);
  assert.equal(reuseRowAt(0), 'use-existing');
  assert.equal(reuseRowAt(1), 'configure-again');
  assert.equal(reuseRowAt(2), null);
  assert.equal(reuseRowAt(-1), null);
});

test('reuse highlight wraps in both directions', () => {
  assert.equal(moveReuseSel(0, 1), 1);
  assert.equal(moveReuseSel(1, 1), 0);
  assert.equal(moveReuseSel(0, -1), 1);
  assert.equal(moveReuseSel(1, -1), 0);
});
