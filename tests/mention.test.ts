/**
 * Unit tests for the `@file` mention syntax (src/tui/mention.ts).
 *
 * These pin the rules that are invisible on screen: which `@` opens the
 * picker, how a caret parked mid-path resolves its token, how paths rank, and
 * what a submitted line turns into. The menu rendering and key routing are
 * covered by scripts/probe_mentions.py, which drives the real TUI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMention,
  buildMentionBlock,
  extractMentions,
  mentionAt,
  rankMentionFiles,
  scoreMentionPath,
  stripMentionBlock,
} from '../src/tui/mention.js';

test('mentionAt: a bare @ at the start of the line lists everything', () => {
  assert.deepEqual(mentionAt('@', 1), { start: 0, end: 1, query: '' });
  assert.deepEqual(mentionAt('@', 0), { start: 0, end: 1, query: '' });
});

test('mentionAt: the query is the whole token, not just the text left of the caret', () => {
  const line = 'explain @src/tui/App.tsx please';
  const token = mentionAt(line, 'explain @src/tu'.length);
  assert.deepEqual(token, { start: 8, end: 24, query: 'src/tui/App.tsx' });
});

test('mentionAt: the caret at the end of the token still finds it', () => {
  const line = 'look at @package.json';
  assert.deepEqual(mentionAt(line, line.length), {
    start: 8,
    end: line.length,
    query: 'package.json',
  });
});

test('mentionAt: a second mention later in the line resolves to its own token', () => {
  const line = '@a.ts and @b.ts';
  const token = mentionAt(line, line.length - 1);
  assert.deepEqual(token, { start: 10, end: 15, query: 'b.ts' });
});

test('mentionAt: emails and glued @s never open the picker', () => {
  assert.equal(mentionAt('you@example.com', 5), null);
  assert.equal(mentionAt('ping you@example.com', 20), null);
  assert.equal(mentionAt('foo@bar @baz', 4), null);
});

test('mentionAt: a token that has scrolled out of the current word is not a mention', () => {
  assert.equal(mentionAt('check src/tui/App.tsx', 20), null);
  assert.equal(mentionAt('', 0), null);
});

test('mentionAt: out-of-range carets are clamped instead of throwing', () => {
  assert.deepEqual(mentionAt('@a', 99), { start: 0, end: 2, query: 'a' });
  assert.deepEqual(mentionAt('@a', -5), { start: 0, end: 2, query: 'a' });
});

test('rankMentionFiles: an exact basename outranks a deeper contain', () => {
  const files = ['src/tui/theme.ts', 'docs/theme.md', 'theme.ts'];
  assert.deepEqual(rankMentionFiles('theme.ts', files), [
    'theme.ts',
    'src/tui/theme.ts',
  ]);
});

test('rankMentionFiles: matching is case-insensitive and prefix-friendly', () => {
  const files = ['src/tui/App.tsx', 'src/tui/MessageArea.tsx', 'README.md'];
  const ranked = rankMentionFiles('app', files);
  assert.equal(ranked[0], 'src/tui/App.tsx');
  assert.ok(!ranked.includes('README.md'));
});

test('rankMentionFiles: a subsequence over the path still finds the file', () => {
  const files = ['src/tui/FileMenu.tsx', 'src/commands/slash.ts'];
  assert.deepEqual(rankMentionFiles('tfmenu', files), ['src/tui/FileMenu.tsx']);
});

test('rankMentionFiles: a basename subsequence beats a path-only subsequence', () => {
  const files = ['xx/t/h/m.ts', 'src/theme.ts'];
  // 'thm' fits both, but only as a scattered path in the first — the file
  // whose NAME matches is the one being typed.
  assert.deepEqual(rankMentionFiles('thm', files), ['src/theme.ts', 'xx/t/h/m.ts']);
});

test('rankMentionFiles: an empty query prefers shallow, short paths', () => {
  const files = ['src/deep/nested/thing.ts', 'src/a.ts', 'README.md'];
  assert.deepEqual(rankMentionFiles('', files), [
    'README.md',
    'src/a.ts',
    'src/deep/nested/thing.ts',
  ]);
});

test('rankMentionFiles: respects the limit and never invents paths', () => {
  const files = Array.from({ length: 30 }, (_, i) => `src/file${i}.ts`);
  assert.equal(rankMentionFiles('file', files, 5).length, 5);
  assert.deepEqual(rankMentionFiles('zzzz', files), []);
  assert.deepEqual(rankMentionFiles('file', files, 0), []);
});

test('scoreMentionPath: backslashes are treated as separators', () => {
  assert.equal(
    scoreMentionPath('theme.ts', 'src\\tui\\theme.ts'),
    scoreMentionPath('theme.ts', 'src/tui/theme.ts'),
  );
});

test('applyMention: replaces the token and leaves a trailing space', () => {
  const line = 'explain @src/tu please';
  const r = applyMention(line, 'explain @src/tu'.length, 'src/tui/App.tsx');
  assert.equal(r.value, 'explain @src/tui/App.tsx please');
  // The existing space is kept, so the caret sits right after the path.
  assert.equal(r.cursor, 'explain @src/tui/App.tsx'.length);
});

test('applyMention: at the end of the line the caret lands after the space', () => {
  const r = applyMention('@pack', 5, 'package.json');
  assert.equal(r.value, '@package.json ');
  assert.equal(r.cursor, r.value.length);
});

test('applyMention: an existing space is not doubled', () => {
  const r = applyMention('@pack now', 5, 'package.json');
  assert.equal(r.value, '@package.json now');
});

test('applyMention: keeps text after the caret in a mid-token edit', () => {
  const r = applyMention('see @sr and', 7, 'src/a.ts');
  assert.equal(r.value, 'see @src/a.ts and');
});

test('applyMention: with no token, inserts at the caret', () => {
  const r = applyMention('hello ', 6, 'a.ts');
  assert.equal(r.value, 'hello @a.ts ');
  assert.equal(r.cursor, r.value.length);
});

test('extractMentions: order, dedupe, and sentence punctuation', () => {
  assert.deepEqual(
    extractMentions('compare @src/a.ts, @src/b.ts and @src/a.ts.'),
    ['src/a.ts', 'src/b.ts'],
  );
});

test('extractMentions: emails, bare @s, and glued tokens are ignored', () => {
  assert.deepEqual(extractMentions('mail me@example.com'), []);
  assert.deepEqual(extractMentions('nothing @ here'), []);
  assert.deepEqual(extractMentions('@ @ @'), []);
});

test('extractMentions: paths at the start and end of the line', () => {
  assert.deepEqual(extractMentions('@a.ts'), ['a.ts']);
  assert.deepEqual(extractMentions('look @a.ts'), ['a.ts']);
});

test('buildMentionBlock: wraps files with path/line metadata', () => {
  const block = buildMentionBlock([
    { path: 'a.ts', content: 'hello', lines: 1, truncated: false },
    { path: 'b.ts', content: 'bye', lines: 3, truncated: true },
  ]);
  assert.match(block, /^<mentioned_files>/);
  assert.match(block, /<file path="a.ts" lines="1">\nhello\n<\/file>/);
  assert.match(block, /<file path="b.ts" lines="3" truncated="true">/);
  assert.match(block, /<\/mentioned_files>$/);
  assert.equal(buildMentionBlock([]), '');
});

test('stripMentionBlock: a reloaded session shows the typed sentence only', () => {
  const stored = 'fix the bug\n\n<mentioned_files>\n<file path="a.ts">\nx\n</file>\n</mentioned_files>';
  assert.equal(stripMentionBlock(stored), 'fix the bug');
  assert.equal(stripMentionBlock('plain message'), 'plain message');
});
