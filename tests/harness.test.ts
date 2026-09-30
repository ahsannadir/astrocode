/**
 * Unit tests for harness improvements: tool-output truncation, loop
 * sensor, conversation compaction, tool-arg repair/coercion, and the
 * hardened executeTool pipeline. All offline — no network, no API keys.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  truncateToolText,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
} from '../src/tooloutput.js';
import {
  LoopSensor,
  NUDGE_THRESHOLD,
  BLOCK_THRESHOLD,
  callKey,
} from '../src/loopsensor.js';
import {
  compactConversation,
  describeCompaction,
} from '../src/compact.js';
import {
  repairToolArgsJson,
  coerceArgsToSchema,
} from '../src/toolargs.js';
import { executeTool } from '../src/tools/registry.js';
import type { ToolFunctionSchema } from '../src/types.js';

// ── tooloutput: truncation ────────────────────────────────────────────────

test('truncateToolText: short text passes through untouched', () => {
  const r = truncateToolText('hello world');
  assert.equal(r.truncated, false);
  assert.equal(r.text, 'hello world');
  assert.equal(r.originalChars, 11);
});

test('truncateToolText: keeps head + tail and explains the elision', () => {
  const big = 'A'.repeat(10_000) + 'MIDDLE'.repeat(2_000) + 'Z'.repeat(2_000);
  const r = truncateToolText(big, { maxChars: 4_000 });
  assert.equal(r.truncated, true);
  assert.ok(r.text.length < 5_000, 'capped near maxChars');
  assert.ok(r.text.startsWith('A'), 'head preserved');
  assert.ok(r.text.endsWith('Z'), 'tail preserved');
  assert.ok(r.text.includes('elided'), 'explains what was dropped');
  assert.ok(r.text.includes('Narrow the query'), 'suggests re-querying');
});

test('truncateToolText: default cap is generous but real', () => {
  assert.ok(DEFAULT_MAX_TOOL_RESULT_CHARS >= 8_000);
  const big = 'x'.repeat(DEFAULT_MAX_TOOL_RESULT_CHARS + 1);
  const r = truncateToolText(big);
  assert.equal(r.truncated, true);
});

// ── loopsensor: backpressure ──────────────────────────────────────────────

test('callKey: whitespace and key order do not hide repeats', () => {
  assert.equal(
    callKey({ name: 't', args: '{"a": 1, "b": 2}' }),
    callKey({ name: 't', args: '{"b":2,"a":1}' }),
  );
  assert.notEqual(
    callKey({ name: 't', args: '{"a":1}' }),
    callKey({ name: 't', args: '{"a":2}' }),
  );
  assert.notEqual(
    callKey({ name: 't1', args: '{"a":1}' }),
    callKey({ name: 't2', args: '{"a":1}' }),
  );
});

test('LoopSensor: nudges at the threshold, blocks later, caches the result', () => {
  const s = new LoopSensor();
  const call = { name: 'search_files', args: '{"pattern":"foo"}' };

  const v1 = s.observe(call);
  assert.equal(v1.allow, true);
  assert.equal(v1.nudge, '');
  s.remember(call, 'the original output');

  for (let i = 2; i < NUDGE_THRESHOLD; i++) {
    assert.equal(s.observe(call).nudge, '');
  }
  const nudge = s.observe(call);
  assert.equal(nudge.allow, true);
  assert.ok(nudge.nudge.includes('identical arguments'));

  // Keep observing until BLOCK_THRESHOLD: now blocked with cached replay.
  let blocked = null;
  for (let i = NUDGE_THRESHOLD; i < BLOCK_THRESHOLD; i++) {
    const v = s.observe(call);
    if (!v.allow) blocked = v;
  }
  blocked = s.observe(call);
  assert.equal(blocked.allow, false);
  assert.ok(blocked.cachedResult?.includes('the original output'));
  assert.ok(blocked.nudge.includes('MUST change your approach'));
});

test('LoopSensor: different args are independent', () => {
  const s = new LoopSensor();
  assert.equal(s.observe({ name: 't', args: '{"a":1}' }).count, 1);
  assert.equal(s.observe({ name: 't', args: '{"a":2}' }).count, 1);
  s.reset();
  assert.equal(s.observe({ name: 't', args: '{"a":1}' }).count, 1);
});

// ── compact: conversation compaction ──────────────────────────────────────

function toolBatch(id: string, name: string, body: string): any[] {
  return [
    { role: 'assistant', content: null, tool_calls: [{ id, name, arguments: '{}' }] },
    { role: 'tool', tool_call_id: id, name, content: body },
  ];
}

test('compactConversation: no-op under keepRecent', () => {
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ];
  const r = compactConversation(msgs as any, { keepRecent: 12 });
  assert.equal(r.dropped, 0);
  assert.equal(r.messages.length, 2);
  assert.equal(r.charsBefore, r.charsAfter);
});

test('compactConversation: summarizes old tool batches, keeps the tail, never orphans tool results', () => {
  const msgs: any[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'the task' },
    ...toolBatch('t1', 'read_file', 'x'.repeat(2_000)),
    { role: 'assistant', content: 'thinking about it '.repeat(30) },
    ...toolBatch('t2', 'list_dir', 'y'.repeat(2_000)),
    { role: 'assistant', content: 'final answer' },
  ];
  const r = compactConversation(msgs, { keepRecent: 4 });
  // Tool results must never appear without their assistant tool_calls batch.
  for (let i = 0; i < r.messages.length; i++) {
    if (r.messages[i].role === 'tool') {
      const prev = r.messages[i - 1];
      assert.ok(
        prev && prev.role === 'assistant' && prev.tool_calls?.length,
        `orphaned tool result at ${i}`,
      );
    }
  }
  assert.ok(r.dropped > 0, 'something was dropped');
  assert.ok(r.charsAfter < r.charsBefore, 'context shrank');
  assert.ok(
    r.messages.some((m) => typeof m.content === 'string' && m.content.includes('[compacted] called read_file')),
    'old batch summarized with tool names',
  );
  // The user's task statement always survives.
  assert.ok(r.messages.some((m) => m.role === 'user' && m.content === 'the task'));
  assert.equal(r.messages[r.messages.length - 1].content, 'final answer');
});

test('describeCompaction: mentions the savings', () => {
  const msgs: any[] = [
    { role: 'user', content: 'task' },
    ...toolBatch('t1', 'read_file', 'z'.repeat(3_000)),
    { role: 'assistant', content: 'done' },
  ];
  const r = compactConversation(msgs, { keepRecent: 2 });
  const text = describeCompaction(r);
  assert.ok(text.includes('Compacted context'));
  assert.ok(text.includes('dropped'));
});

// ── toolargs: JSON repair + schema coercion ───────────────────────────────

test('repairToolArgsJson: parses clean JSON directly', () => {
  assert.deepEqual(repairToolArgsJson('{"a":1}'), { a: 1 });
  assert.deepEqual(repairToolArgsJson(''), {});
});

test('repairToolArgsJson: fixes fences, prose prefixes, trailing commas, single quotes, raw newlines', () => {
  assert.deepEqual(
    repairToolArgsJson('```json\n{"path": "a.ts"}\n```'),
    { path: 'a.ts' },
  );
  assert.deepEqual(
    repairToolArgsJson('Here you go: {"path": "a.ts"}'),
    { path: 'a.ts' },
  );
  assert.deepEqual(
    repairToolArgsJson('{"a": 1,}'),
    { a: 1 },
  );
  assert.deepEqual(
    repairToolArgsJson("{'path': 'a.ts'}"),
    { path: 'a.ts' },
  );
  assert.deepEqual(
    repairToolArgsJson('{"content": "line1\nline2"}'),
    { content: 'line1\nline2' },
  );
});

test('coerceArgsToSchema: numbers/booleans as strings, objects into arrays', () => {
  const schema: ToolFunctionSchema = {
    name: 't',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        max_lines: { type: 'number' },
        force: { type: 'boolean' },
        hunks: { type: 'array' },
        name: { type: 'string' },
      },
    },
  };
  const out = coerceArgsToSchema(
    { max_lines: '5', force: 'true', hunks: { search: 'a', replace: 'b' }, name: 42 },
    schema,
  );
  assert.equal(out.max_lines, 5);
  assert.equal(out.force, true);
  assert.deepEqual(out.hunks, [{ search: 'a', replace: 'b' }]);
  assert.equal(out.name, '42');
});

// ── executeTool: the integrated pipeline ──────────────────────────────────

test('executeTool: repairs malformed args instead of failing', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astro-harness-'));
  try {
    await fs.writeFile(path.join(tmp, 'a.txt'), 'hello', 'utf8');
    const r = await executeTool(
      'read_file',
      '```json\n{"path": "a.txt", "max_lines": "10"}\n```',
      { cwd: tmp },
    );
    assert.equal(r.ok, true, r.text);
    assert.ok(r.text.includes('hello'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('executeTool: truncates oversized results with an elision notice', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astro-harness-'));
  try {
    await fs.writeFile(path.join(tmp, 'big.txt'), 'x'.repeat(40_000), 'utf8');
    const r = await executeTool('read_file', '{"path": "big.txt"}', { cwd: tmp });
    assert.ok(r.text.length < 20_000, 'result was bounded');
    assert.ok(r.text.includes('elided'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('executeTool: unknown tool lists the available tools', async () => {
  const r = await executeTool('nope', '{}', { cwd: '.' });
  assert.equal(r.ok, false);
  assert.ok(r.text.includes('read_file'));
});

test('executeTool: loop sensor blocks the 6th identical call with a replay', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astro-harness-'));
  try {
    const sensor = new LoopSensor();
    const ctx = { cwd: tmp, loopSensor: sensor };
    const args = '{"path": "."}';
    for (let i = 0; i < BLOCK_THRESHOLD - 1; i++) {
      const r = await executeTool('list_dir', args, ctx);
      assert.equal(r.ok, true, r.text);
    }
    const blocked = await executeTool('list_dir', args, ctx);
    assert.equal(blocked.ok, false);
    assert.ok(blocked.text.includes('MUST change your approach'));
    assert.ok(blocked.text.includes('entries'), 'cached result replayed');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
