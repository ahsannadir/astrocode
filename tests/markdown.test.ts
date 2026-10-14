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
  displayWidth,
  sliceToWidth,
  wrapSegments,
  clearMarkdownCache,
  type UILine,
} from '../src/tui/markdown.js';
import { setTheme, theme } from '../src/tui/theme.js';

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

test('inline: angle autolinks and trailing punctuation', () => {
  const segs = inlineSegments('see <https://x.dev/a> and https://y.dev.', 'white');
  assert.ok(segs.some((s) => s.text === 'https://x.dev/a' && s.underline));
  assert.ok(segs.some((s) => s.text === 'https://y.dev' && s.underline));
  // The sentence-ending period stays plain text, not part of the link.
  assert.ok(segs.some((s) => s.text === '.' && !s.underline));
});

test('inline: bold-italic runs and nesting', () => {
  const both = inlineSegments('***loud***', 'white');
  assert.ok(both.some((s) => s.text === 'loud' && s.bold && s.italic));

  const nested = inlineSegments('**bold with _italic_ inside**', 'white');
  assert.ok(nested.some((s) => s.text === 'bold with ' && s.bold && !s.italic));
  assert.ok(nested.some((s) => s.text === 'italic' && s.bold && s.italic));
  assert.ok(!nested.some((s) => s.text.includes('_')), 'underscores are consumed');
});

test('inline: backslash escapes suppress markers', () => {
  const segs = inlineSegments('\\*not italic\\* and \\`not code\\`', 'white');
  assert.equal(segs.map((s) => s.text).join(''), '*not italic* and `not code`');
  assert.ok(!segs.some((s) => s.italic));
});

test('inline: multi-backtick code spans', () => {
  const segs = inlineSegments('use ``a `b` c`` here', 'white');
  assert.ok(segs.some((s) => s.text === 'a `b` c'));
});

test('inline: images render a labeled placeholder with the target', () => {
  const segs = inlineSegments('![diagram](https://x.dev/a.png)', 'white');
  const text = segs.map((s) => s.text).join('');
  assert.ok(text.includes('diagram'));
  assert.ok(text.includes('https://x.dev/a.png'));
});

test('display width: wide and zero-width characters are measured in cells', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('日本語'), 6);
  assert.equal(displayWidth('🖼'), 2);
  assert.equal(displayWidth('e\u0301'), 1);
  assert.equal(sliceToWidth('日本語です', 5), '日本');
  // Never returns an empty slice for non-empty input (wrap loops must advance).
  assert.equal(sliceToWidth('日', 1), '日');
});

test('wrapSegments: style survives a line break', () => {
  const rows = wrapSegments(
    [
      { text: 'plain ', color: 'a' },
      { text: 'bold span that wraps', color: 'a', bold: true },
      { text: ' after', color: 'a' },
    ],
    12,
  );
  const flat = rows.map((r) => r.map((s) => s.text).join(''));
  assert.ok(flat.length > 1, 'wraps into multiple rows');
  assert.ok(flat.every((l) => displayWidth(l) <= 12), flat.join('|'));
  const boldRows = rows.filter((r) => r.some((s) => s.bold));
  assert.ok(boldRows.length >= 2, 'bold continues across rows');
  assert.equal(flat.join('').replace(/ +/g, ' '), 'plain bold span that wraps after');
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

test('markdown: emphasis crossing a wrap keeps its style and drops markers', () => {
  const md = 'before **a really quite long bold phrase that wraps now**';  
  const lines = richLines(md, 20);
  const joined = lines.map((l) => l.text).join(' ');
  assert.ok(!joined.includes('**'), 'no raw markers on any wrapped row');
  const boldRows = lines.filter((l) => (l.segments ?? []).some((s) => s.bold));
  assert.ok(boldRows.length >= 2, 'the bold span continues onto the next row');
  for (const l of lines) assert.ok(displayWidth(l.text) <= 20, l.text);
});

test('markdown: setext headings render as h1/h2', () => {
  const lines = richLines('Big Title\n=========\n\nSection\n-------\n\nbody', W);
  const h1 = find(lines, 'Big Title');
  assert.ok(h1 && h1.bold, 'h1 bold');
  assert.ok(h1!.segments!.some((s) => s.underline), 'h1 underlined');
  const h2 = find(lines, 'Section');
  assert.ok(h2 && h2.bold, 'h2 bold');
  assert.ok(!find(lines, '===='), 'the underline is consumed');
  assert.ok(find(lines, 'body'));
});

test('markdown: indented list continuations join the item', () => {
  const lines = richLines('- first item\n  continued here\n- second', W);
  assert.ok(find(lines, '• first item continued here'), 'continuation folded in');
  assert.ok(find(lines, '• second'));
  assert.ok(!lines.some((l) => l.text.startsWith('  continued')), 'no stray paragraph');
});

test('markdown: tables keep inline styling in cells', () => {
  const md = ['| **Name** | Count |', '| --- | ---: |', '| `a` | 12 |'].join('\n');
  const lines = richLines(md, W);
  const header = find(lines, 'Name');
  assert.ok(header!.segments!.some((s) => s.text.includes('Name') && s.bold), 'header cell bold');
  const body = find(lines, '12');
  const code = body!.segments!.find((s) => s.text.trim() === 'a');
  assert.ok(code && code.color === theme.code, 'inline code keeps its color in a cell');
});

test('markdown: diff fences color added and removed lines', () => {
  const md = ['```diff', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '-old', '+new', '```'].join('\n');
  const lines = richLines(md, W);
  const added = find(lines, '+new');
  const removed = find(lines, '-old');
  assert.ok(added!.segments!.some((s) => s.color === theme.synAdd), 'added line uses synAdd');
  assert.ok(removed!.segments!.some((s) => s.color === theme.synDel), 'removed line uses synDel');
  const hunk = find(lines, '@@ -1 +1 @@');
  assert.ok(hunk!.segments!.some((s) => s.color === theme.synType), 'hunk header stands out');
});

test('markdown: wrapped code rows copy exactly once', () => {
  const long = 'const veryLongIdentifierName = someFunction(argumentOne, argumentTwo, argumentThree);';
  const md = ['```ts', long, '```'].join('\n');
  const lines = richLines(md, 40);
  const code = lines.filter((l) => l.text.startsWith('  │ ') || l.text.startsWith('  ↪ '));
  assert.ok(code.length > 1, 'the long line wraps');
  assert.equal(code.map((l) => l.copy).join('').trim(), long, 'copies concatenate back to the source');
  assert.ok(code[1].text.startsWith('  ↪ '), 'continuation rows use a wrap marker');
});

test('markdown: code frame rules never exceed the width', () => {
  for (const width of [20, 40, 100]) {
    const lines = richLines('```ts\nconst x = 1;\n```', width);
    for (const l of lines) {
      assert.ok(displayWidth(l.text) <= width, `too wide at ${width}: ${JSON.stringify(l.text)}`);
    }
    const head = lines.find((l) => l.text.includes('╭─'));
    const tail = lines.find((l) => l.text.includes('╰─'));
    assert.ok(head && tail);
    assert.equal(head!.copy, '');
    assert.equal(tail!.copy, '');
  }
});

test('markdown: wide characters respect the width budget', () => {
  const md = '日本語のテキストがとても長い場合に折り返されるはずです。';
  for (const l of richLines(md, 20)) {
    assert.ok(displayWidth(l.text) <= 20, `line too wide: ${JSON.stringify(l.text)}`);
  }
});

test('markdown: wrapped list items hang under their text', () => {
  const lines = richLines('- a bullet with enough words that it has to wrap somewhere', 24);
  assert.ok(lines.length >= 2, 'wrapped');
  assert.ok(lines[1].text.startsWith('  '), 'continuation is indented under the bullet');
  for (const l of lines) assert.ok(displayWidth(l.text) <= 24, l.text);
});

test('markdown: tokenColor maps every token kind to a string', () => {
  for (const kind of [
    'plain', 'keyword', 'string', 'number', 'comment', 'function', 'type', 'punct',
    'add', 'del',
  ] as const) {
    assert.equal(typeof tokenColor(kind), 'string');
  }
  assert.equal(tokenColor('add'), theme.synAdd);
  assert.equal(tokenColor('del'), theme.synDel);
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
