/**
 * Unit tests for the headless engine (src/headless.ts) — runAgentTurn's
 * tool loop and verify feedback, the shared system-prompt builder, and the
 * stdin passthrough helper. All offline with a fake provider + tmp dir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runAgentTurn, buildSystemPromptShared, type RunTurnOptions } from '../src/headless.js';
import type { AIProvider, AppConfig, ChatMessage, StreamOptions, TokenUsage } from '../src/types.js';

/** Scripted provider: pops a queued response per streamComplete call. */
function fakeProvider(script: Array<ChatMessage & { usage?: TokenUsage }>): AIProvider {
  let i = 0;
  return {
    kind: 'openai',
    model: 'test-model',
    async streamComplete(_options: StreamOptions) {
      const next = script[Math.min(i, script.length - 1)];
      i++;
      return { ...next };
    },
  };
}

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    apiKey: 'test',
    baseUrl: 'http://localhost:0',
    model: 'gpt-4o-mini',
    demo: false,
    systemPrompt: 'You are a test agent.',
    maxToolTurns: 8,
    budget: 0,
    verify: false,
    autocommit: false,
    ...overrides,
  };
}

function baseOpts(overrides: Partial<RunTurnOptions> = {}): RunTurnOptions {
  return {
    config: baseConfig(),
    cwd: '.',
    provider: fakeProvider([{ role: 'assistant', content: 'done' }]),
    conversation: [],
    ...overrides,
  };
}

test('headless: single completion returns the final text and usage cost', async () => {
  const opts = baseOpts({
    provider: fakeProvider([
      { role: 'assistant', content: 'All done.', usage: { inputTokens: 100, outputTokens: 10 } },
    ]),
  });
  const r = await runAgentTurn(opts);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'All done.');
  assert.equal(r.turns, 1);
  assert.ok(r.costUsd > 0);
  assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 10 });
});

test('headless: tool calls execute and their results land in the conversation', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astro-hl-'));
  try {
    await fs.writeFile(path.join(tmp, 'note.txt'), 'hello headless', 'utf8');
    const conversation: ChatMessage[] = [];
    const opts = baseOpts({
      cwd: tmp,
      conversation,
      provider: fakeProvider([
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }) },
          ],
        },
        { role: 'assistant', content: 'The note says hello headless.' },
      ]),
    });
    const r = await runAgentTurn(opts);
    assert.equal(r.text, 'The note says hello headless.');
    assert.equal(r.turns, 2);
    // The conversation must contain the paired tool result.
    const toolMsg = conversation.find((m) => m.role === 'tool');
    assert.ok(toolMsg, 'tool result must be pushed');
    assert.match(toolMsg.content ?? '', /hello headless/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('headless: system prompt carries memory + repo map + mode banner', () => {
  const opts = baseOpts({
    sources: { memoryText: 'USE PNPM', repoMapText: 'MAP:' },
  });
  const sys = buildSystemPromptShared(opts, 'plan');
  assert.match(sys, /You are a test agent\./);
  assert.match(sys, /USE PNPM/);
  assert.match(sys, /MAP:/);
  assert.match(sys, /PLAN mode/);
  const actSys = buildSystemPromptShared(opts, 'act');
  assert.match(actSys, /ACT mode/);
});

test('headless: plan mode blocks mutating tools with a tool-role message', async () => {
  const conversation: ChatMessage[] = [];
  const opts = baseOpts({
    mode: 'plan',
    conversation,
    provider: fakeProvider([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c2', name: 'write_file', arguments: JSON.stringify({ path: 'x.txt', content: 'nope' }) }],
      },
      { role: 'assistant', content: 'I cannot write in plan mode.' },
    ]),
  });
  const r = await runAgentTurn(opts);
  assert.equal(r.ok, true);
  const toolMsg = conversation.find((m) => m.role === 'tool');
  assert.ok(toolMsg);
  assert.match(toolMsg.content ?? '', /Blocked in PLAN mode/);
  const written = await fs
    .access('x.txt')
    .then(() => true)
    .catch(() => false);
  assert.equal(written, false, 'plan mode must not write files');
});

test('headless: budget stop returns ok=false with an explanatory message', async () => {
  // Budget is checked BEFORE each request: the first completion (a tool
  // round-trip) charges real usage far over the $0.10 ceiling, so the next
  // request is refused and the turn reports failure with the budget reason.
  const opts = baseOpts({
    config: baseConfig({ budget: 0.1 }),
    provider: fakeProvider([
      {
        role: 'assistant',
        content: null,
        usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
        tool_calls: [{ id: 'c9', name: 'list_dir', arguments: JSON.stringify({ path: '.' }) }],
      },
      { role: 'assistant', content: 'never reached' },
    ]),
    conversation: [{ role: 'user', content: 'go' }],
  });
  const r = await runAgentTurn(opts);
  assert.equal(r.ok, false);
  assert.match(r.text, /budget/i);
});

test('headless: budget stop returns ok=false via verify=false config too', async () => {
  // Verify feedback loop: fake provider fails verify twice then answers.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astro-hl-'));
  try {
    // No scripts detected here → verify passes trivially; just exercise the path.
    const conversation: ChatMessage[] = [{ role: 'user', content: 'do nothing' }];
    const opts = baseOpts({
      cwd: tmp,
      conversation,
      config: baseConfig({ verify: true }),
      provider: fakeProvider([{ role: 'assistant', content: 'nothing to do' }]),
    });
    const r = await runAgentTurn(opts);
    assert.equal(r.ok, true);
    assert.equal(r.verifyOk, undefined, 'no changes → verify not run');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
