/**
 * Unit tests for the provider registry (src/providers.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, providerById } from '../src/providers.js';

test('providers: openai, anthropic, inferx, agentrouter, zenmux, tokenrouter, openrouter, and openai-compatible are registered', () => {
  const ids = PROVIDERS.map((p) => p.id);
  assert.deepEqual(ids, [
    'openai',
    'anthropic',
    'inferx',
    'agentrouter',
    'zenmux',
    'tokenrouter',
    'openrouter',
    'openai-compatible',
  ]);
});

test('providers: every built-in provider has a base URL, default model, and models', () => {
  for (const p of PROVIDERS) {
    if (p.id === 'openai-compatible') continue; // template filled in by /login
    assert.ok(p.baseUrl.startsWith('https://'), `${p.id} baseUrl`);
    assert.ok(p.defaultModel, `${p.id} defaultModel`);
    assert.ok(p.models.length > 0, `${p.id} models`);
    assert.ok(p.models.includes(p.defaultModel), `${p.id} default in models`);
  }
});

test('providers: openai-compatible is a /login-filled template', () => {
  const oc = providerById('openai-compatible');
  // No static endpoint or catalog: the user types the base URL and the model
  // list is fetched live from GET <baseUrl>/models (or typed as a custom ID).
  assert.equal(oc.baseUrl, '');
  assert.equal(oc.defaultModel, '');
  assert.deepEqual(oc.models, []);
  assert.equal(oc.name, 'OpenAI Compatible');
});

test('providers: providerById resolves known ids', () => {
  assert.equal(providerById('anthropic').id, 'anthropic');
  assert.equal(providerById('inferx').id, 'inferx');
  assert.equal(providerById('agentrouter').id, 'agentrouter');
  assert.equal(providerById('zenmux').id, 'zenmux');
  assert.equal(providerById('tokenrouter').id, 'tokenrouter');
  assert.equal(providerById('openrouter').id, 'openrouter');
  assert.equal(providerById('openai-compatible').id, 'openai-compatible');
});

test('providers: providerById falls back to OpenAI for unknown ids', () => {
  assert.equal(providerById('nope').id, 'openai');
  assert.equal(providerById(undefined).id, 'openai');
  assert.equal(providerById(null).id, 'openai');
});

test('providers: ids are unique', () => {
  assert.equal(new Set(PROVIDERS.map((p) => p.id)).size, PROVIDERS.length);
});

test('providers: agentrouter exposes its endpoint and account catalog', () => {
  const ar = providerById('agentrouter');
  assert.equal(ar.baseUrl, 'https://agentrouter.org/v1');
  assert.equal(ar.defaultModel, 'gpt-5.6-sol');
  assert.ok(ar.models.includes(ar.defaultModel), 'agentrouter default in models');
  // Model IDs available on the user's AgentRouter account.
  for (const m of ['gpt-5.6-sol', 'claude-opus-4-8', 'claude-opus-5']) {
    assert.ok(ar.models.includes(m), `agentrouter missing ${m}`);
  }
});

test('providers: inferx exposes its endpoint and default model', () => {
  const ix = providerById('inferx');
  assert.equal(ix.baseUrl, 'https://model.inferx.net/endpoints/v1');
  assert.equal(ix.defaultModel, 'deepseek-v4-flash');
  assert.ok(ix.models.includes(ix.defaultModel), 'inferx default in models');
});

test('providers: zenmux ships its verified free models', () => {
  const zx = providerById('zenmux');
  assert.equal(zx.baseUrl, 'https://zenmux.ai/api/v1');
  // Free set verified live against https://zenmux.ai/api/v1/models (0/0 pricing).
  for (const m of [
    'deepseek/deepseek-v4-flash-free',
    'z-ai/glm-4.7-flash-free',
    'z-ai/glm-4.6v-flash-free',
  ]) {
    assert.ok(zx.models.includes(m), `zenmux missing ${m}`);
  }
  assert.equal(zx.defaultModel, 'deepseek/deepseek-v4-flash-free');
  assert.ok(zx.models.includes(zx.defaultModel), 'zenmux default in models');
});

test('providers: tokenrouter ships routing modes and the kimi-k3-free model', () => {
  const tr = providerById('tokenrouter');
  // Routing modes let TokenRouter pick the provider per request.
  for (const mode of ['auto:balance', 'auto:cost', 'auto:quality', 'auto:latency']) {
    assert.ok(tr.models.includes(mode), `tokenrouter missing ${mode}`);
  }
  // The user-requested model must be selectable from /models.
  assert.ok(
    tr.models.includes('moonshotai/kimi-k3-free'),
    'tokenrouter missing moonshotai/kimi-k3-free',
  );
  assert.equal(tr.baseUrl, 'https://api.tokenrouter.io/v1');
  assert.equal(tr.defaultModel, 'auto:balance');
});

test('providers: openrouter ships a healthy set of free models (:free)', () => {
  const or = providerById('openrouter');
  const free = or.models.filter(
    (m) => m === 'openrouter/free' || m.endsWith(':free'),
  );
  assert.ok(
    free.length >= 10,
    `expected at least 10 free models, got ${free.length}`,
  );
  // Paid entries must not masquerade as free.
  const paid = or.models.filter((m) => !free.includes(m));
  assert.ok(paid.length > 0, 'openrouter should still list paid models');
});

test('providers: model lists contain no duplicates', () => {
  for (const p of PROVIDERS) {
    assert.equal(
      new Set(p.models).size,
      p.models.length,
      `${p.id} model list has duplicates`,
    );
  }
});
