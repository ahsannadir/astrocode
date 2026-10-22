/**
 * Regression tests for the /model picker's key routing (src/tui/modelPicker.ts).
 *
 * The bug these pin down: /model on a provider with an empty model list — an
 * 'OpenAI Compatible' endpoint, whose models are fetched live during /login —
 * opened a picker that ignored Esc. Every keystroke was swallowed, including
 * the one the popup itself advertised ("Esc cancel"), so the only way back to
 * the prompt was killing the process. Cancelling must not depend on there
 * being something to pick.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelPickerIntent } from '../src/tui/modelPicker.js';

const CANCEL = { kind: 'cancel' };

test('Esc cancels with an empty model list — the trapped-picker regression', () => {
  assert.deepEqual(modelPickerIntent(0, '', { escape: true }), CANCEL);
});

test('Esc cancels regardless of the list length or other key flags', () => {
  for (const count of [0, 1, 12, 400]) {
    assert.deepEqual(modelPickerIntent(count, '', { escape: true }), CANCEL);
    // A real escape byte can arrive alongside decoded arrow fragments.
    assert.deepEqual(
      modelPickerIntent(count, '', { escape: true, upArrow: true, return: true }),
      CANCEL,
    );
  }
});

test('an empty list ignores navigation and Enter instead of selecting nothing', () => {
  for (const input of ['', 'a', '[H']) {
    assert.equal(modelPickerIntent(0, input, { upArrow: true }), null);
    assert.equal(modelPickerIntent(0, input, { downArrow: true }), null);
    assert.equal(modelPickerIntent(0, input, { return: true }), null);
    assert.equal(modelPickerIntent(0, input, {}), null);
  }
});

test('arrows move up/down and wrap in the picker', () => {
  assert.deepEqual(modelPickerIntent(3, '', { upArrow: true }), { kind: 'move', dir: -1 });
  assert.deepEqual(modelPickerIntent(3, '', { downArrow: true }), { kind: 'move', dir: 1 });
  // Wrapping is applied by the component; the intent only names a direction.
  for (const count of [1, 2, 50]) {
    assert.deepEqual(modelPickerIntent(count, '', { upArrow: true }), { kind: 'move', dir: -1 });
  }
});

test('Enter selects and type-ahead is a single lowercased printable char', () => {
  assert.deepEqual(modelPickerIntent(5, '', { return: true }), { kind: 'select' });
  assert.deepEqual(modelPickerIntent(5, 'O', {}), { kind: 'typeahead', char: 'o' });
  assert.deepEqual(modelPickerIntent(5, ' ', {}), { kind: 'typeahead', char: ' ' });
  // Multi-char input is a paste or an escape-sequence fragment, never a jump.
  assert.equal(modelPickerIntent(5, 'gpt', {}), null);
  assert.equal(modelPickerIntent(5, '\x1b[B', {}), null);
  assert.equal(modelPickerIntent(5, '\u0000', {}), null);
});

test('control characters never move the highlight', () => {
  for (const input of ['\x03', '\x7f', '\u0001']) {
    assert.equal(modelPickerIntent(9, input, {}), null);
  }
});
