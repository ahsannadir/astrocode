/**
 * Unit tests for the session-scoped sub-agent spawn history (src/agents.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordAgentSpawn,
  getAgentHistory,
  clearAgentHistory,
} from '../src/agents.js';

test('agent history: records and returns newest-first', () => {
  clearAgentHistory();
  recordAgentSpawn({ role: 'researcher', task: 'first', turns: 1, actions: 2, ok: true });
  recordAgentSpawn({ role: 'reviewer', task: 'second', turns: 3, actions: 1, ok: true });
  const h = getAgentHistory();
  assert.equal(h.length, 2);
  assert.equal(h[0].role, 'reviewer'); // newest first
  assert.equal(h[0].task, 'second');
  assert.equal(h[1].role, 'researcher');
});

test('agent history: limit and zero-limit behavior', () => {
  clearAgentHistory();
  for (let i = 0; i < 10; i++) {
    recordAgentSpawn({ role: 'researcher', task: `t${i}`, turns: 1, actions: 0, ok: true });
  }
  assert.equal(getAgentHistory(3).length, 3);
  assert.equal(getAgentHistory(0).length, 0); // guarded against slice(-0)
  assert.equal(getAgentHistory().length, 10);
});

test('agent history: clear empties the store', () => {
  clearAgentHistory();
  assert.equal(getAgentHistory().length, 0);
});
