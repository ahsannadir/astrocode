/**
 * Unit tests for real provider-usage parsing (src/ai/openai.ts) and the
 * usage-based cost math (src/cost.ts). Offline — no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUsage } from '../src/ai/openai.js';
import { costFromUsage, pricingFor } from '../src/cost.js';

test('usage: extracts OpenAI chat-completions usage with cache details', () => {
  const u = extractUsage({
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 400 },
    },
  });
  assert.deepEqual(u, { inputTokens: 1000, outputTokens: 50, cachedTokens: 400 });
});

test('usage: accepts the alt field names gateways use', () => {
  const u = extractUsage({
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 },
  });
  assert.deepEqual(u, { inputTokens: 10, outputTokens: 2, cachedTokens: 5 });
});

test('usage: absent / null / all-zero usage means unknown', () => {
  assert.equal(extractUsage({}), undefined);
  assert.equal(extractUsage({ usage: null }), undefined);
  assert.equal(extractUsage({ usage: { prompt_tokens: 0, completion_tokens: 0 } }), undefined);
  assert.equal(extractUsage(undefined), undefined);
});

test('usage: cached tokens above input are not accepted blindly later', () => {
  // Math caps cached at input inside costFromUsage — verify with extremes.
  const p = pricingFor('gpt-4o');
  const cost = costFromUsage(
    'gpt-4o',
    { inputTokens: 100, outputTokens: 10, cachedTokens: 999 },
    0,
    0,
  );
  // 0 fresh input + 100 cached (capped) + 10 output
  const expected = (100 / 1e6) * (p.cachedInputPerM ?? p.inputPerM / 2) + (10 / 1e6) * p.outputPerM;
  assert.ok(Math.abs(cost - expected) < 1e-12);
});

test('cost: usage-based math beats the chars estimate when present', () => {
  const p = pricingFor('gpt-4o');
  const cost = costFromUsage(
    'gpt-4o',
    { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 0 },
    4, // tiny char counts that would estimate ~1 token
    4,
  );
  const expected = p.inputPerM + p.outputPerM;
  assert.ok(Math.abs(cost - expected) < 1e-9);
});

test('cost: falls back to char estimation when usage is missing', () => {
  const p = pricingFor('gpt-4o');
  // 4M chars ≈ 1M tokens on both sides (chars÷4 estimator).
  const cost = costFromUsage('gpt-4o', undefined, 4_000_000, 4_000_000);
  const expected = p.inputPerM + p.outputPerM;
  assert.ok(Math.abs(cost - expected) < 1e-9);
});

test('cost: cached input is billed at the cache rate', () => {
  const p = pricingFor('gpt-4o');
  const allFresh = costFromUsage('gpt-4o', { inputTokens: 1000, outputTokens: 0 }, 0, 0);
  const halfCached = costFromUsage(
    'gpt-4o',
    { inputTokens: 1000, outputTokens: 0, cachedTokens: 500 },
    0,
    0,
  );
  const cacheRate = p.cachedInputPerM ?? p.inputPerM / 2;
  const expected = (500 / 1e6) * p.inputPerM + (500 / 1e6) * cacheRate;
  assert.ok(Math.abs(halfCached - expected) < 1e-12);
  assert.ok(halfCached < allFresh);
});

test('cost: longest pricing key wins (gpt-4o-mini vs gpt-4o)', () => {
  assert.equal(pricingFor('gpt-4o-mini-2024-07-18').inputPerM, 0.15);
  assert.equal(pricingFor('gpt-4o').inputPerM, 2.5);
  assert.equal(pricingFor('GPT-5-MINI').inputPerM, 0.25);
});

test('cost: unknown models get the conservative default', () => {
  const p = pricingFor('totally-unknown-model');
  assert.equal(p.inputPerM, 1);
  assert.equal(p.outputPerM, 3);
});
