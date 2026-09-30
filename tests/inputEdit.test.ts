/**
 * Unit tests for the TUI text-editing primitives (src/tui/inputEdit.ts).
 * These encode the backspace/typing fixes: dual backspace encodings, control
 * character filtering, paste normalization, and surrogate-pair safety.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backspaceAt,
  deleteForwardAt,
  deleteWordBefore,
  insertAtCursor,
  isPrintableChar,
  moveCursorLeft,
  moveCursorRight,
  normalizePaste,
} from '../src/tui/inputEdit.js';

test('isPrintableChar: accepts printable text, rejects control chars and DEL', () => {
  assert.equal(isPrintableChar('a'), true);
  assert.equal(isPrintableChar('9'), true);
  assert.equal(isPrintableChar(' '), true);
  assert.equal(isPrintableChar('✦'), true); // astral-safe: BMP non-ASCII
  assert.equal(isPrintableChar('\x00'), false);
  assert.equal(isPrintableChar('\x1b'), false);
  assert.equal(isPrintableChar('\x7f'), false);
  assert.equal(isPrintableChar('ab'), false); // multi-char is not a char
  assert.equal(isPrintableChar(''), false);
});

test('backspaceAt: deletes the char before the cursor', () => {
  assert.deepEqual(backspaceAt('hello', 5), { value: 'hell', cursor: 4 });
  assert.deepEqual(backspaceAt('hello', 3), { value: 'helo', cursor: 2 });
  assert.deepEqual(backspaceAt('abc', 1), { value: 'bc', cursor: 0 });
  assert.equal(backspaceAt('abc', 0), null); // nothing before cursor
  assert.equal(backspaceAt('', 0), null);
  // Out-of-range cursor (stale state) is refused, not corrupted.
  assert.equal(backspaceAt('abc', 7), null);
});

test('backspaceAt: treats an astral emoji surrogate pair as one character', () => {
  const s = 'a🚀b'; // units: a(0) hi(1) lo(2) b(3)
  // Deleting from after the emoji removes the whole pair.
  const r = backspaceAt(s, 3);
  assert.equal(r!.value, 'ab');
  assert.equal(r!.cursor, 1);
  // Deleting at the end removes only 'b'.
  const r2 = backspaceAt(s, 4);
  assert.equal(r2!.value, 'a🚀');
  assert.equal(r2!.cursor, 3);
});

test('deleteForwardAt: deletes the char after the cursor', () => {
  assert.deepEqual(deleteForwardAt('hello', 0), { value: 'ello', cursor: 0 });
  assert.equal(deleteForwardAt('hello', 5), null); // nothing ahead
  assert.equal(deleteForwardAt('', 0), null);
});

test('deleteWordBefore: readline Ctrl+W semantics', () => {
  assert.deepEqual(deleteWordBefore('hello world', 11), {
    value: 'hello ',
    cursor: 6,
  });
  // Trailing spaces are consumed together with the word.
  assert.deepEqual(deleteWordBefore('hello   ', 8), { value: '', cursor: 0 });
  assert.equal(deleteWordBefore('plain', 0), null);
});

test('moveCursorLeft/Right: surrogate pairs move as one cell', () => {
  const s = 'a🚀b'; // units: a(0) hi(1) lo(2) b(3)
  assert.equal(moveCursorLeft(s, 3), 1); // step over the pair
  assert.equal(moveCursorRight(s, 1), 3);
  assert.equal(moveCursorLeft(s, 0), 0);
  assert.equal(moveCursorRight(s, s.length), s.length);
});

test('normalizePaste: strips bracketed markers, newlines become spaces', () => {
  assert.equal(normalizePaste('\x1b[200~line one\nline two\x1b[201~'), 'line one line two');
  assert.equal(normalizePaste('tab\there'), 'tab here');
  assert.equal(normalizePaste('\x1b[?1c'), ''); // device-attributes reply dropped
  assert.equal(normalizePaste('clean'), 'clean');
});

test('insertAtCursor: single printable chars insert at the cursor', () => {
  assert.deepEqual(insertAtCursor('heo', 2, 'l'), { value: 'helo', cursor: 3 });
  // Control characters are dropped entirely (this was the corruption bug).
  assert.equal(insertAtCursor('abc', 1, '\x03'), null);
  assert.equal(insertAtCursor('abc', 1, '\x1b[200~'), null);
  // Enter/Tab inside a text field become spaces, not newlines.
  assert.deepEqual(insertAtCursor('ab', 2, '\r'), { value: 'ab ', cursor: 3 });
});

test('insertAtCursor: multi-char input is treated as a paste', () => {
  assert.deepEqual(insertAtCursor('ac', 1, 'bbb'), { value: 'abbbc', cursor: 4 });
  assert.deepEqual(insertAtCursor('', 0, 'x\ny'), { value: 'x y', cursor: 3 });
  assert.equal(insertAtCursor('', 0, '\x1b[201~'), null); // paste of pure markers
});

test('insertAtCursor: out-of-range cursor is refused', () => {
  assert.equal(insertAtCursor('abc', 9, 'x'), null);
  assert.equal(insertAtCursor('abc', -1, 'x'), null);
});
