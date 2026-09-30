/**
 * Unit tests for the fuzzy, context-tolerant patch engine (src/applypatch.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, levenshtein, lineSimilarity } from '../src/applypatch.js';

test('levenshtein: basic distances', () => {
  assert.equal(levenshtein('', ''), 0);
  assert.equal(levenshtein('abc', ''), 3);
  assert.equal(levenshtein('', 'abc'), 3);
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('same', 'same'), 0);
});

test('lineSimilarity: identical and whitespace-drift lines score 1', () => {
  assert.equal(lineSimilarity('  return x;', '  return x;'), 1);
  assert.equal(lineSimilarity('    return x;', '  return x;'), 1); // indent drift
  assert.equal(lineSimilarity('a  b   c', 'a b c'), 1); // whitespace collapse
});

test('lineSimilarity: substring boost for meaningful fragments only', () => {
  // 'greet' is a substring of 'function greet(name: string) {' → boost.
  assert.equal(lineSimilarity('function greet(name: string) {', 'greet'), 0.95);
  // Tiny fragments (< 4 chars) do NOT get the boost (fall to Levenshtein).
  assert.notEqual(lineSimilarity('if (x) return;', 'if'), 0.95);
});

test('applyPatch: exact substring replacement (edit_file semantics)', () => {
  const out = applyPatch('function greet() {}', [{ search: 'greet', replace: 'hi' }]);
  assert.equal(out.applied, 1);
  assert.deepEqual(out.unmatched, []);
  assert.equal(out.content, 'function hi() {}');
});

test('applyPatch: replace_all applies every occurrence', () => {
  const src = 'a.greet();\nb.greet();\nc.other();';
  const out = applyPatch(src, [{ search: 'greet', replace: 'welcome', replace_all: true }]);
  assert.equal(out.applied, 2);
  assert.equal(out.content, 'a.welcome();\nb.welcome();\nc.other();');
});

test('applyPatch: fuzzy single-line fallback preserves leading indent', () => {
  const src = 'function f() {\n    return old();\n}';
  // Search line has 2-space indent; file has 4 — raw substring misses.
  const out = applyPatch(src, [{ search: '  return old();', replace: '  return new();' }]);
  assert.equal(out.applied, 1);
  assert.equal(out.content, 'function f() {\n    return new();\n}');
});

test('applyPatch: multi-line block replacement', () => {
  const src = 'function greet(name) {\n  return name;\n}\n';
  const out = applyPatch(src, [
    {
      search: 'function greet(name) {\n  return name;',
      replace: 'export function greet(name) {\n  return name.toUpperCase();',
    },
  ]);
  assert.equal(out.applied, 1);
  assert.ok(out.content.includes('export function greet(name) {\n  return name.toUpperCase();'));
});

test('applyPatch: unmatched hunk is reported, caller decides', () => {
  const src = 'const a = 1;\n';
  const out = applyPatch(src, [
    { search: 'const a = 1;', replace: 'const a = 2;' },
    { search: 'this does not exist', replace: 'x' },
  ]);
  assert.equal(out.applied, 1);
  assert.equal(out.unmatched.length, 1);
  assert.equal(out.unmatched[0].reason, 'no fuzzy match found');
});

test('applyPatch: empty search is rejected', () => {
  const out = applyPatch('abc', [{ search: '   ', replace: 'x' }]);
  assert.equal(out.applied, 0);
  assert.equal(out.unmatched.length, 1);
  assert.equal(out.unmatched[0].reason, 'empty search');
});

test('applyPatch: preserves the file trailing newline', () => {
  const out = applyPatch('line1\nline2\n', [{ search: 'line1', replace: 'changed' }]);
  assert.equal(out.content, 'changed\nline2\n');
});

test('applyPatch: tiny fragment fails cleanly (no false match)', () => {
  const out = applyPatch('const value = compute(42);', [{ search: 'zz', replace: 'xx' }]);
  assert.equal(out.applied, 0);
  assert.equal(out.unmatched.length, 1);
});
