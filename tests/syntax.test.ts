/**
 * Unit tests for the dependency-free syntax highlighter (src/tui/syntax.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLanguage,
  highlightCode,
  clearHighlightCache,
  type Token,
  type TokenKind,
} from '../src/tui/syntax.js';

function flat(code: string, lang: string): Token[] {
  return highlightCode(code, lang).flat();
}

function textOfKind(code: string, lang: string, kind: TokenKind): string {
  return flat(code, lang)
    .filter((t) => t.kind === kind)
    .map((t) => t.text)
    .join('');
}

function kinds(code: string, lang: string): TokenKind[] {
  return flat(code, lang).map((t) => t.kind);
}

test('syntax: detectLanguage maps aliases and degrades to plain', () => {
  assert.equal(detectLanguage('ts'), 'js');
  assert.equal(detectLanguage('typescript'), 'js');
  assert.equal(detectLanguage('TSX'), 'js');
  assert.equal(detectLanguage('python'), 'python');
  assert.equal(detectLanguage('bash'), 'shell');
  assert.equal(detectLanguage('yml'), 'yaml');
  assert.equal(detectLanguage('c++'), 'plain'); // no alias → plain, still colored
  assert.equal(detectLanguage('cpp'), 'c');
  assert.equal(detectLanguage(''), 'plain');
  assert.equal(detectLanguage(undefined), 'plain');
  assert.equal(detectLanguage('ts title="app.ts"'), 'js');
  assert.equal(detectLanguage('js:src/index.js'), 'js');
});

test('syntax: javascript keywords, numbers, strings and comments', () => {
  const code = 'const answer = 42; // the answer';
  assert.equal(textOfKind(code, 'js', 'keyword'), 'const');
  assert.equal(textOfKind(code, 'js', 'number'), '42');
  assert.equal(textOfKind(code, 'js', 'comment'), '// the answer');

  const s = 'const name = "astro";';
  assert.equal(textOfKind(s, 'js', 'string'), '"astro"');
});

test('syntax: function names are detected before the paren', () => {
  const code = 'function greet(name) { return name; }';
  const fns = flat(code, 'js').filter((t) => t.kind === 'function').map((t) => t.text);
  assert.deepEqual(fns, ['greet']);
  assert.ok(kinds(code, 'js').includes('keyword'));
});

test('syntax: block comments span lines and close correctly', () => {
  const code = '/* first\n   second */\nconst a = 1;';
  const rows = highlightCode(code, 'js');
  assert.ok(rows[0].every((t) => t.kind === 'comment'), 'line 1 is comment');
  assert.ok(rows[1].every((t) => t.kind === 'comment'), 'line 2 is comment');
  assert.ok(
    rows[2].some((t) => t.kind === 'keyword' && t.text === 'const'),
    'line 3 is code again',
  );
});

test('syntax: an unterminated block comment colors the rest of the block', () => {
  const rows = highlightCode('/* never closed\nstill comment', 'js');
  assert.ok(rows[1].every((t) => t.kind === 'comment'));
});

test('syntax: javascript template literals span lines', () => {
  const code = 'const s = `line one\nline two`;';
  const rows = highlightCode(code, 'js');
  assert.ok(rows[0].some((t) => t.kind === 'keyword' && t.text === 'const'));
  assert.ok(rows[0].some((t) => t.kind === 'string' && t.text.includes('line one')));
  assert.ok(rows[1].some((t) => t.kind === 'string' && t.text.includes('line two')));
});

test('syntax: python def/class and triple-quoted strings', () => {
  const code = 'def compute(x):\n    return x';
  assert.equal(textOfKind(code, 'python', 'keyword'), 'defreturn');
  const fns = flat(code, 'python').filter((t) => t.kind === 'function').map((t) => t.text);
  assert.deepEqual(fns, ['compute']);

  const doc = 'x = """doc\nstring"""\ny = 1';
  const rows = highlightCode(doc, 'python');
  assert.ok(rows[0].some((t) => t.kind === 'string' && t.text.includes('"""doc')));
  assert.ok(rows[1].some((t) => t.kind === 'string' && t.text.includes('string"""')));
  assert.ok(rows[2].some((t) => t.kind === 'number' && t.text === '1'));
});

test('syntax: python decorators are colored as types', () => {
  const code = '@app.route("/x")';
  const t = flat(code, 'python').find((tok) => tok.kind === 'type');
  assert.ok(t && t.text === '@app');
});

test('syntax: go raw strings span lines', () => {
  const code = 's := `raw\nstring`';
  const rows = highlightCode(code, 'go');
  assert.ok(rows[0].some((t) => t.kind === 'string' && t.text.includes('raw')));
  assert.ok(rows[1].some((t) => t.kind === 'string' && t.text.includes('string`')));
});

test('syntax: rust lifetimes vs char literals', () => {
  const life = "fn f<'a>(x: &'a str) {}";
  const lifeTokens = flat(life, 'rust');
  assert.ok(
    lifeTokens.some((t) => t.kind === 'type' && t.text === "'a"),
    'lifetime colored as type',
  );

  const chr = "let c = 'x';";
  assert.equal(textOfKind(chr, 'rust', 'string'), "'x'");
});

test('syntax: json colors keys, numbers and literals', () => {
  const code = '{ "a": 1, "b": true, "c": null }';
  assert.equal(textOfKind(code, 'json', 'number'), '1');
  assert.equal(textOfKind(code, 'json', 'keyword'), 'truenull');
  assert.ok(textOfKind(code, 'json', 'string').includes('"a"'));
});

test('syntax: shell keywords and variables', () => {
  const code = 'echo "$HOME" > out.txt';
  assert.ok(flat(code, 'shell').some((t) => t.kind === 'keyword' && t.text === 'echo'));
  assert.ok(flat(code, 'shell').some((t) => t.kind === 'string'));
});

test('syntax: css selector vs property', () => {
  const code = 'body { color: red; margin: 4px; }';
  const toks = flat(code, 'css');
  assert.ok(toks.some((t) => t.kind === 'keyword' && t.text === 'body'), 'selector');
  assert.ok(toks.some((t) => t.kind === 'function' && t.text === 'color'), 'property');
  assert.ok(toks.some((t) => t.kind === 'number' && t.text === '4'), 'number');
});

test('syntax: html tags, attributes and strings', () => {
  const code = '<a href="/x" class="link">hi</a>';
  const toks = flat(code, 'markup');
  assert.ok(toks.some((t) => t.kind === 'keyword' && t.text === 'a'));
  assert.ok(toks.some((t) => t.kind === 'function' && t.text === 'href'));
  assert.ok(toks.some((t) => t.kind === 'string' && t.text === '"/x"'));
});

test('syntax: html comments span lines', () => {
  const rows = highlightCode('<!-- start\nend -->\n<p>x</p>', 'markup');
  assert.ok(rows[0].every((t) => t.kind === 'comment'));
  assert.ok(rows[1].every((t) => t.kind === 'comment'));
  assert.ok(rows[2].some((t) => t.kind === 'keyword' && t.text === 'p'));
});

test('syntax: yaml keys and values', () => {
  const code = 'name: astro\ncount: 3';
  const toks = flat(code, 'yaml');
  assert.ok(toks.some((t) => t.kind === 'function' && t.text === 'name'));
  assert.ok(toks.some((t) => t.kind === 'number' && t.text === '3'));
});

test('syntax: toml sections and keys', () => {
  const code = '[server]\nport = 8080';
  const toks = flat(code, 'toml');
  assert.ok(toks.some((t) => t.kind === 'type' && t.text === '[server]'));
  assert.ok(toks.some((t) => t.kind === 'function' && t.text === 'port'));
  assert.ok(toks.some((t) => t.kind === 'number' && t.text === '8080'));
});

test('syntax: unknown languages still get strings, numbers and comments', () => {
  const code = 'x = "hi" 12 // note';
  const toks = flat(code, 'plain');
  assert.ok(toks.some((t) => t.kind === 'string' && t.text === '"hi"'));
  assert.ok(toks.some((t) => t.kind === 'number' && t.text === '12'));
  assert.ok(toks.some((t) => t.kind === 'comment' && t.text === '// note'));
});

test('syntax: adjacent same-kind tokens are coalesced', () => {
  const toks = flat('a + b', 'js');
  // 'a + b' → plain 'a', punct '+', plain 'b' — no two plain tokens adjacent.
  assert.deepEqual(toks.map((t) => t.kind), ['plain', 'punct', 'plain']);
});

test('syntax: results are memoized by language and source', () => {
  clearHighlightCache();
  const a = highlightCode('const x = 1;', 'js');
  const b = highlightCode('const x = 1;', 'js');
  assert.equal(a, b, 'same reference from the cache');
  const c = highlightCode('const x = 1;', 'python');
  assert.notEqual(a, c, 'different language is a different entry');
});

test('syntax: line count always matches the source', () => {
  const code = 'a\n\nb\n';
  assert.equal(highlightCode(code, 'js').length, 4);
});
