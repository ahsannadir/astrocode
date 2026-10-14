/**
 * Unit tests for the terminal markdown renderer (src/tui/markdown.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  richLines,
  wrapText,
  fitLine,
  inlineSegments,
  tokenColor,
  clearMarkdownCache,
  type UILine,
} from '../src/tui/markdown.js';
import { setTheme } from '../src/tui/theme.js';

const W = 60;

function texts(lines: UILine[]): string[] {
  return lines.map((l) => l.text);
}

function find(lines: UILine[], needle: string): UILine | undefined {
  return lines.find((l) => l.text.includes(needle));
}

test('wrapText: greedy wrap with hard-cut fallback for long tokens', () => {
  assert.deepEqual(wrapText('one two three', 7), ['one two', 'three']);
  assert.deepEqual(wrapText('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrapText('a\nb', 10), ['a', 'b']);
});

test('fitLine: truncates with an ellipsis', () => {
  assert.equal(fitLine('hello', 10), 'hello');
  assert.equal(fitLine('hello world', 5), 'hell…');
});

test('inline: bold, italic, code, strike and links become segments', () => {
  const segs = inlineSegments('a **b** *c* `d` ~~e~~ [f](http://x)', 'white');
  assert.ok(segs.some((s) => s.text === 'b' && s.bold));
  assert.ok(segs.some((s) => s.text === 'c' && s.italic));
  assert.ok(segs.some((s) => s.text === 'd'));
  assert.ok(segs.some((s) => s.text === 'e' && s.strikethrough));
  assert.ok(segs.some((s) => s.text === 'f' && s.underline));
  // The visible text preserves the link target.
  assert.ok(segs.map((s) => s.text).join('').includes('http://x'));
});

test('inline: snake_case is not mistaken for italics', () => {
  const segs = inlineSegments('call foo_bar_baz now', 'white');
  assert.equal(segs.map((s) => s.text).join(''), 'call foo_bar_baz now');
  assert.ok(!segs.some((s) => s.italic));
});

test('inline: autolinks are underlined', () => {
  const segs = inlineSegments('see https://example.com/x for more', 'white');
  assert.ok(segs.some((s) => s.text === 'https://example.com/x' && s.underline));
});

test('markdown: headings drop the hashes and are styled', () => {
  const lines = richLines('# Title\n\n## Sub', W);
  const h1 = find(lines, 'Title');
  assert.ok(h1 && h1.bold);
  assert.ok(!h1!.text.includes('#'));
  const h2 = find(lines, 'Sub');
  assert.ok(h2 && h2.bold);
});

test('markdown: bullet, ordered and task lists', () => {
  const lines = richLines('- alpha\n1. beta\n- [x] done\n- [ ] todo', W);
  assert.ok(find(lines, '• alpha'));
  assert.ok(find(lines, '1. beta'));
  assert.ok(find(lines, '☑ done'));
  assert.ok(find(lines, '☐ todo'));
});

test('markdown: nested bullets indent by depth', () => {
  const lines = richLines('- top\n  - child\n    - grand', W);
  assert.ok(find(lines, '• top'));
  assert.ok(find(lines, '  ◦ child'));
  assert.ok(find(lines, '    ▪ grand'));
});

test('markdown: blockquotes get a bar and italic content', () => {
  const lines = richLines('> quoted text', W);
  const q = find(lines, 'quoted text');
  assert.ok(q && q.text.startsWith('▍'));
  assert.ok(q!.segments!.some((s) => s.italic));
});

test('markdown: horizontal rules are chrome, not copyable', () => {
  const lines = richLines('a\n\n---\n\nb', W);
  const rule = lines.find((l) => l.text.startsWith('─'));
  assert.ok(rule);
  assert.equal(rule!.copy, '');
});

test('markdown: fenced code gets a language label, gutter and highlighting', () => {
  const md = ['```ts', 'const x = 1; // note', '```'].join('\n');
  const lines = richLines(md, W);
  assert.ok(find(lines, '╭─ ts'), 'language label present');
  assert.ok(find(lines, '╰─'), 'closing bar present');
  const code = find(lines, 'const x = 1');
  assert.ok(code, 'code line present');
  assert.ok(code!.text.startsWith('  │ '), 'code sits in a gutter');
  // Highlighting: the keyword and comment are distinct colored segments.
  const kinds = code!.segments!.map((s) => s.color);
  assert.ok(new Set(kinds).size >= 3, 'multiple syntax colors on the line');
  // Copy strips the gutter chrome.
  assert.equal(code!.copy, 'const x = 1; // note');
});

test('markdown: an unterminated fence still renders as code', () => {
  const lines = richLines('```js\nlet a = 1;', W);
  assert.ok(find(lines, 'let a = 1'));
  assert.ok(!find(lines, '╰─'), 'no closing bar while streaming');
});

test('markdown: code blocks do not leak inline parsing into strings', () => {
  const md = ['```js', 'const s = "**not bold**";', '```'].join('\n');
  const lines = richLines(md, W);
  const code = find(lines, 'not bold');
  assert.ok(code);
  assert.ok(!code!.segments!.some((s) => s.bold), 'no bold inside code');
});

test('markdown: pipe tables align into columns', () => {
  const md = ['| Name | Age |', '| ---- | --- |', '| Ann  | 30  |'].join('\n');
  const lines = richLines(md, W);
  assert.ok(find(lines, 'Name │ Age'), 'header row aligned');
  assert.ok(find(lines, 'Ann'), 'body row present');
  assert.ok(lines.some((l) => l.text.includes('┼')), 'rule under the header');
});

test('markdown: an over-wide table falls back to plain lines', () => {
  const md = ['| A | B |', '| - | - |', '| x | y |'].join('\n');
  const lines = richLines(md, 8);
  assert.ok(!lines.some((l) => l.text.includes('┼')));
  assert.ok(lines.some((l) => l.text.includes('|')));
});

test('markdown: no rendered line exceeds the width', () => {
  const md = [
    '# Heading that is quite long indeed and keeps going on',
    '',
    '- a bullet with a lot of words that should wrap across the width nicely',
    '',
    '```ts',
    'const averyveryverylongidentifier = someFunction(argumentOne, argumentTwo);',
    '```',
  ].join('\n');
  for (const line of richLines(md, 40)) {
    assert.ok(line.text.length <= 40, `line too wide: ${JSON.stringify(line.text)}`);
  }
});

test('markdown: copy strips inline markers but keeps link targets', () => {
  const lines = richLines('See **bold** and [docs](https://x.dev).', W);
  const line = lines[0];
  assert.equal(line.copy, 'See bold and docs (https://x.dev).');
});

test('markdown: tokenColor maps every token kind to a string', () => {
  for (const kind of [
    'plain', 'keyword', 'string', 'number', 'comment', 'function', 'type', 'punct',
  ] as const) {
    assert.equal(typeof tokenColor(kind), 'string');
  }
});

test('markdown: switching themes invalidates the render cache', () => {
  clearMarkdownCache();
  setTheme('astro');
  const a = richLines('```js\nconst x = 1;\n```', W);
  const aColor = a.find((l) => l.text.includes('const'))!.segments![0].color;
  setTheme('inferno');
  const b = richLines('```js\nconst x = 1;\n```', W);
  const bColor = b.find((l) => l.text.includes('const'))!.segments![0].color;
  assert.notEqual(aColor, bColor, 'colors follow the active theme');
  setTheme('astro');
});
