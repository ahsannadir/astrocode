/**
 * Unit tests for the /history picker helpers (src/tui/history.ts) and the
 * save → list → resume round-trip through sessions.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChatMessage } from '../src/types.js';
import {
  itemsFromMessages,
  relativeAge,
  toolResultLooksOk,
} from '../src/tui/history.js';
import { MENTION_BLOCK_OPEN } from '../src/tui/mention.js';
import {
  saveSession,
  loadSession,
  listSessions,
  defaultSessionName,
} from '../src/sessions.js';

test('itemsFromMessages: rebuilds a transcript, tool calls and results included', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'fix the parser' },
    {
      role: 'assistant',
      content: 'Reading the file first.',
      tool_calls: [
        { id: 'c1', name: 'read_file', arguments: '{"path":"src/parse.ts"}' },
        { id: 'c2', name: 'run_command', arguments: '{"command":"npm test"}' },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'File: src/parse.ts\n---\ncode\n---' },
    { role: 'tool', tool_call_id: 'c2', name: 'run_command', content: 'run_command failed: exit 1' },
  ];
  assert.deepEqual(itemsFromMessages(messages), [
    { kind: 'user', text: 'fix the parser' },
    { kind: 'assistant', text: 'Reading the file first.' },
    { kind: 'tool_start', name: 'read_file', args: '{"path":"src/parse.ts"}' },
    { kind: 'tool_start', name: 'run_command', args: '{"command":"npm test"}' },
    {
      kind: 'tool_result',
      name: 'read_file',
      ok: true,
      text: 'File: src/parse.ts\n---\ncode\n---',
    },
    {
      kind: 'tool_result',
      name: 'run_command',
      ok: false,
      text: 'run_command failed: exit 1',
    },
  ]);
});

test('itemsFromMessages: a restored prompt shows the sentence, not the file dump', () => {
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content:
        `explain this\n\n${MENTION_BLOCK_OPEN}\n` +
        `<file path="src/a.ts" lines="900" truncated="true">\nconst a = 1;\n</file>\n` +
        '</mentioned_files>',
    },
  ];
  assert.deepEqual(itemsFromMessages(messages), [{ kind: 'user', text: 'explain this' }]);
});

test('itemsFromMessages: compaction summaries and empty messages survive', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Earlier turns were compacted: built the parser.' },
    { role: 'assistant', content: null },
    { role: 'assistant', content: '   ' },
    { role: 'user', content: '' },
  ];
  assert.deepEqual(itemsFromMessages(messages), [
    { kind: 'system', text: 'Earlier turns were compacted: built the parser.' },
  ]);
});

test('toolResultLooksOk: registry failures are marked, normal output is not', () => {
  assert.equal(toolResultLooksOk('Wrote 120 bytes to /tmp/a'), true);
  assert.equal(toolResultLooksOk('⛔ Command looks dangerous and was NOT run'), false);
  assert.equal(toolResultLooksOk('Blocked in PLAN mode: "write_file"'), false);
  assert.equal(toolResultLooksOk('Unknown tool: nope'), false);
  assert.equal(toolResultLooksOk('apply_patch failed: no such file'), false);
  assert.equal(toolResultLooksOk('Tool read_file threw: EACCES'), false);
});

test('relativeAge: compact labels that never go backwards', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  assert.equal(relativeAge('2026-10-28T11:59:40Z', now), 'just now');
  assert.equal(relativeAge('2026-10-28T11:45:00Z', now), '15m ago');
  assert.equal(relativeAge('2026-10-28T09:00:00Z', now), '3h ago');
  assert.equal(relativeAge('2026-10-26T12:00:00Z', now), '2d ago');
  assert.equal(relativeAge('not a date', now), '');
  // Clock skew: a future timestamp reads as "just now" rather than negative.
  assert.equal(relativeAge('2026-10-28T12:05:00Z', now), 'just now');
});

test('defaultSessionName: unique per second, filesystem-safe, sortable', () => {
  const a = defaultSessionName(new Date(2026, 9, 28, 14, 32, 5));
  assert.equal(a, 'session-1028-143205');
  assert.match(a, /^session-\d{4}-\d{6}$/);
  const b = defaultSessionName(new Date(2026, 9, 28, 14, 32, 6));
  assert.notEqual(a, b);
});

test('save → list → resume round-trip keeps the transcript', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astro-history-'));
  const orig = process.env.ASTROCODE_SESSION_DIR;
  process.env.ASTROCODE_SESSION_DIR = tmp;
  try {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'add rate limiting' },
      { role: 'assistant', content: 'Done — middleware added.' },
    ];
    const name = defaultSessionName(new Date(2026, 9, 28, 14, 32, 5));
    await saveSession(name, {
      cwd: '/tmp/x',
      model: 'gpt-4o',
      mode: 'act',
      createdAt: new Date().toISOString(),
      messages,
    });

    const listed = await listSessions();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, name);
    assert.equal(listed[0].messages, 2);

    const loaded = await loadSession(listed[0].name);
    assert.ok(loaded);
    assert.equal(loaded!.model, 'gpt-4o');
    assert.deepEqual(itemsFromMessages(loaded!.messages), [
      { kind: 'user', text: 'add rate limiting' },
      { kind: 'assistant', text: 'Done — middleware added.' },
    ]);
  } finally {
    if (orig === undefined) delete process.env.ASTROCODE_SESSION_DIR;
    else process.env.ASTROCODE_SESSION_DIR = orig;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
