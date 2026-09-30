/**
 * Unit tests for cost & token accounting (src/cost.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pricingFor,
  formatCost,
  estimateTokens,
  contextLimitFor,
  estimateContextTokens,
} from '../src/cost.js';

test('pricingFor: known models and default fallback', () => {
  assert.deepEqual(pricingFor('gpt-4o'), { inputPerM: 2.5, outputPerM: 10 });
  assert.deepEqual(pricingFor('claude-3-5-sonnet'), { inputPerM: 3, outputPerM: 15 });
  assert.deepEqual(pricingFor('some-unknown-model'), { inputPerM: 1, outputPerM: 3 });
});

test('formatCost: branches for 0, tiny, small, and large amounts', () => {
  assert.equal(formatCost(0), '$0.0000');
  assert.equal(formatCost(0.005), '$0.0050');
  assert.equal(formatCost(0.5), '$0.500');
  assert.equal(formatCost(5), '$5.00');
  assert.equal(formatCost(-1), '$0.0000'); // negative clamps to 0
});

test('estimateTokens: ~4 chars per token', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('x'.repeat(400)), 100);
  assert.equal(estimateTokens('hello'), 2); // 5 chars → ceil(5/4)
  assert.equal(estimateTokens('h'), 1); // minimum 1
});

test('contextLimitFor: family limits', () => {
  assert.equal(contextLimitFor('gpt-4o'), 128_000);
  assert.equal(contextLimitFor('claude-3-5-sonnet'), 200_000);
  assert.equal(contextLimitFor('unknown-model'), 128_000);
});

test('estimateContextTokens: sums message content and tool calls', () => {
  const msgs = [
    { content: 'x'.repeat(400) }, // 100 tokens
    { content: null, tool_calls: [{ name: 'a', arguments: '{}' }] },
  ];
  assert.ok(estimateContextTokens(msgs) > 100);
  assert.equal(estimateContextTokens([]), 0);
});
