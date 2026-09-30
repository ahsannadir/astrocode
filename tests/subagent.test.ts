/**
 * Unit tests for the bounded sub-agent loop (src/subagent.ts) using a fake
 * provider — no network, no API key.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSubAgent, SUBAGENT_ROLES, SUBAGENT_ROLE_NAMES } from '../src/subagent.js';
import type { AIProvider, ChatMessage, StreamOptions } from '../src/types.js';

const runTool = async (name: string) => ({ ok: true, text: `result of ${name}` });

class FakeProvider implements AIProvider {
  readonly kind = 'openai' as const;
  readonly model = 'fake';
  constructor(private script: ChatMessage[]) {}
  async streamComplete(options: StreamOptions): Promise<ChatMessage> {
    const msg = this.script.shift();
    if (!msg) throw new Error('fake provider script exhausted');
    if (typeof msg.content === 'string') options.onToken({ type: 'text', text: msg.content });
    return msg;
  }
}

class HangingProvider implements AIProvider {
  readonly kind = 'openai' as const;
  readonly model = 'fake';
  async streamComplete(options: StreamOptions): Promise<ChatMessage> {
    // Never resolves on its own — only via the abort signal.
    await new Promise((_, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    return { role: 'assistant', content: 'never' };
  }
}

const listDirTool = [
  {
    type: 'function' as const,
    function: {
      name: 'list_dir',
      description: 'list',
      parameters: { type: 'object' as const, properties: {} },
    },
  },
];

test('sub-agent roles: every preset is well-formed and read-only', () => {
  assert.equal(SUBAGENT_ROLE_NAMES.length, Object.keys(SUBAGENT_ROLES).length);
  for (const name of SUBAGENT_ROLE_NAMES) {
    const r = SUBAGENT_ROLES[name];
    assert.ok(r.prompt.length > 0, `role ${name} missing prompt`);
    assert.ok(r.tools.length > 0, `role ${name} missing tools`);
    for (const banned of ['write_file', 'edit_file', 'apply_patch', 'worktree', 'todo', 'spawn_agent']) {
      assert.ok(!r.tools.includes(banned), `role ${name} must not have ${banned}`);
    }
  }
});

test('runSubAgent: plain answer completes in one turn', async () => {
  const provider = new FakeProvider([{ role: 'assistant', content: 'The repo map shows a src/ dir.' }]);
  const r = await runSubAgent({
    task: 'explore',
    role: 'researcher',
    cwd: '/tmp',
    provider,
    tools: [],
    runTool,
  });
  assert.equal(r.turns, 1);
  assert.ok(r.text.includes('Sub-agent "researcher" report'));
  assert.ok(r.text.includes('The repo map shows a src/ dir.'));
});

test('runSubAgent: tool calls loop and get executed', async () => {
  const provider = new FakeProvider([
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', name: 'list_dir', arguments: '{}' }] },
    { role: 'assistant', content: 'Found 3 files.' },
  ]);
  const r = await runSubAgent({
    task: 'explore',
    role: 'researcher',
    cwd: '/tmp',
    provider,
    tools: listDirTool,
    runTool,
  });
  assert.equal(r.turns, 2);
  assert.equal(r.actions, 1);
  assert.ok(r.text.includes('list_dir'));
  assert.ok(r.text.includes('Found 3 files.'));
});

test('runSubAgent: turn budget bounds the loop', async () => {
  const provider = new FakeProvider([
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', name: 'list_dir', arguments: '{}' }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 't2', name: 'list_dir', arguments: '{}' }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 't3', name: 'list_dir', arguments: '{}' }] },
  ]);
  const r = await runSubAgent({
    task: 'explore',
    role: 'researcher',
    cwd: '/tmp',
    provider,
    tools: listDirTool,
    runTool,
    maxTurns: 2,
  });
  assert.equal(r.turns, 2);
  assert.ok(r.text.includes('2-turn budget'));
});

test('runSubAgent: wall-clock timeout interrupts the loop', async () => {
  const r = await runSubAgent({
    task: 'hang',
    role: 'researcher',
    cwd: '/tmp',
    provider: new HangingProvider(),
    tools: [],
    runTool,
    timeoutMs: 100,
  });
  assert.ok(r.text.includes('interrupted by the timeout'), r.text);
});
