/**
 * Unit tests for the tool-call formatter (src/tui/toolFormat.ts).
 *
 * The bug this guards against: a `write_file` call used to render as one
 * truncated blob of escaped JSON (`{"content":"def f():\n  ...`). Now the
 * call is meant to read like a preview — path, then the payload as real lines.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatToolCall } from '../src/tui/toolFormat.js';
import { displayWidth, type UILine } from '../src/tui/markdown.js';
import { setTheme } from '../src/tui/theme.js';

setTheme('astro');

const W = 60;

function texts(lines: UILine[]): string[] {
  return lines.map((l) => l.text);
}

function joined(lines: UILine[]): string {
  return texts(lines).join('\n');
}

test('write_file: shows the path and the content as real lines (no \\n literals)', () => {
  const src = 'def is_prime(n):\n    if n <= 1:\n        return False\n    return True\n';
  const args = JSON.stringify({ path: '/home/x/prime.py', content: src });
  const lines = formatToolCall('write_file', args, W);

  assert.ok(texts(lines)[0].includes('write_file'));
  assert.ok(texts(lines)[0].includes('prime.py'));
  assert.ok(texts(lines).some((t) => t.includes('path:')));

  // The payload is decoded: `def is_prime(n):` appears on its own row and no
  // escaped `\n` survives anywhere in the visible output.
  assert.ok(joined(lines).includes('def is_prime(n):'));
  assert.ok(!joined(lines).includes('\\n'));
  assert.ok(texts(lines).some((t) => /\d+ lines/.test(t)));
});

test('write_file: syntax-highlights the preview and keeps it within the width', () => {
  const args = JSON.stringify({ path: 'prime.py', content: 'def f():\n    return 1\n' });
  const lines = formatToolCall('write_file', args, W);
  for (const l of lines) {
    assert.ok(displayWidth(l.text) <= W, `row too wide: ${l.text}`);
  }
  // The `def` keyword should be tokenized to its themed color.
  const hasKeyword = lines.some(
    (l) => l.segments?.some((s) => s.text.includes('def') && s.color !== undefined),
  );
  assert.ok(hasKeyword);
});

test('write_file: caps a long payload and reports how many lines were hidden', () => {
  const body = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
  const lines = formatToolCall('write_file', JSON.stringify({ path: 'a.txt', content: body }), W);
  assert.ok(joined(lines).includes('line 1'));
  assert.ok(joined(lines).includes('more lines'));
});

test('run_command: renders the shell command on its own row', () => {
  const lines = formatToolCall(
    'run_command',
    JSON.stringify({ command: 'npm test', timeout_ms: 5000 }),
    W,
  );
  assert.ok(texts(lines)[0].includes('run_command'));
  assert.ok(joined(lines).includes('npm test'));
  assert.ok(joined(lines).includes('timeout 5000ms'));
});

test('edit_file: shows search as - and replace as +', () => {
  const lines = formatToolCall(
    'edit_file',
    JSON.stringify({ path: 'x.ts', search: 'const a = 1;', replace: 'const a = 2;' }),
    W,
  );
  assert.ok(joined(lines).includes('- const a = 1;'));
  assert.ok(joined(lines).includes('+ const a = 2;'));
});

test('multi_edit: lists the hunks under the path', () => {
  const lines = formatToolCall(
    'multi_edit',
    JSON.stringify({
      path: 'x.ts',
      edits: [
        { search: 'a', replace: 'b' },
        { search: 'c', replace: 'd' },
      ],
    }),
    W,
  );
  assert.ok(joined(lines).includes('2 hunks'));
  assert.ok(joined(lines).includes('#1'));
  assert.ok(joined(lines).includes('#2'));
});

test('read_file: shows the path inline on the header', () => {
  const lines = formatToolCall('read_file', JSON.stringify({ path: 'src/app.ts' }), W);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].text.includes('read_file'));
  assert.ok(lines[0].text.includes('src/app.ts'));
});

test('search_files: shows the pattern plus non-empty extras', () => {
  const lines = formatToolCall(
    'search_files',
    JSON.stringify({ pattern: 'TODO', glob: '.ts' }),
    W,
  );
  assert.ok(lines[0].text.includes('TODO'));
  assert.ok(joined(lines).includes('glob=.ts'));
});

test('unknown tool: falls back to a wrapped compact JSON blob (never truncated)', () => {
  const args = JSON.stringify({ foo: 'bar', nested: { n: 1 } });
  const lines = formatToolCall('mystery_tool', args, W);
  assert.ok(lines[0].text.includes('mystery_tool'));
  assert.ok(joined(lines).includes('"foo":"bar"'));
  for (const l of lines) assert.ok(displayWidth(l.text) <= W);
});

test('malformed args: still yields a header line, never throws', () => {
  const lines = formatToolCall('write_file', '{not json', W);
  assert.ok(lines.length >= 1);
  assert.ok(lines[0].text.includes('write_file'));
});

test('todo: summarises the call instead of dumping argument JSON', () => {
  const lines = formatToolCall(
    'todo',
    JSON.stringify({ action: 'update', id: 't3', status: 'in_progress' }),
    W,
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, '☄ todo update t3 → in_progress');
  assert.ok(!lines[0].text.includes('{'));
});

test('todo: add carries the task text', () => {
  const lines = formatToolCall(
    'todo',
    JSON.stringify({ action: 'add', text: 'Wire the status bar' }),
    W,
  );
  assert.ok(lines[0].text.includes('add'));
  assert.ok(lines[0].text.includes('Wire the status bar'));
});

test('repomap: bare header with no trailing detail', () => {
  const lines = formatToolCall('repomap', '{}', W);
  assert.equal(lines[0].text.trim(), '☄ repomap');
});
