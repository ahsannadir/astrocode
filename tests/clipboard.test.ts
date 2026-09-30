/**
 * Unit tests for clipboard support (src/clipboard.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyToClipboard } from '../src/clipboard.js';

/** Capture writes to process.stdout (monkeypatched around each test). */
function captureStdout(fn: () => void): string {
  const orig = process.stdout.write;
  let captured = '';
  (process.stdout as unknown as { write: unknown }).write = ((chunk: unknown) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    (process.stdout as unknown as { write: unknown }).write = orig;
  }
  return captured;
}

test('clipboard: emits an OSC 52 payload with base64 text', () => {
  const out = captureStdout(() => {
    const res = copyToClipboard('hello world');
    assert.equal(res, 'osc52');
  });
  const b64 = Buffer.from('hello world', 'utf8').toString('base64');
  assert.ok(out.startsWith('\x1b]52;c;'), 'starts with OSC 52 prefix');
  assert.ok(out.includes(b64), 'contains base64 text');
  assert.ok(out.endsWith('\x07'), 'ends with BEL terminator');
});

test('clipboard: empty text fails without writing anything', () => {
  const out = captureStdout(() => {
    const res = copyToClipboard('');
    assert.equal(res, 'failed');
  });
  assert.equal(out, '');
});
