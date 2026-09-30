/**
 * Unit tests for slash-command handlers that touch the clipboard (/copy).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSlashCommand } from '../src/commands/slash.js';
import type { SlashContext } from '../src/commands/slash.js';

/** Capture OSC 52 writes so tests never touch a real clipboard. */
async function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const orig = process.stdout.write;
  let captured = '';
  (process.stdout as unknown as { write: unknown }).write = ((chunk: unknown) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    (process.stdout as unknown as { write: unknown }).write = orig;
  }
  return captured;
}

function makeCtx(messages: SlashContext['messages']): SlashContext {
  return {
    config: {
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      demo: true,
      systemPrompt: 'x',
      maxToolTurns: 20,
      budget: 0,
      verify: false,
      autocommit: false,
    },
    conversationLength: messages.length,
    messages,
    setModel: () => {},
    mode: 'act',
    sessionName: 'session',
    cwd: '/tmp',
    costUsd: 0,
    tokens: 0,
    contextTokens: 0,
  };
}

test('/copy: copies the last assistant reply via OSC 52', async () => {
  const ctx = makeCtx([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there, operator' },
    { role: 'user', content: 'again' },
    { role: 'assistant', content: 'second reply' },
  ]);
  const out = await captureStdout(async () => {
    const res = await runSlashCommand('/copy', ctx);
    assert.equal(res.handled, true);
    assert.ok(res.message!.includes('Copied the last reply'));
  });
  const b64 = Buffer.from('second reply', 'utf8').toString('base64');
  assert.ok(out.includes(b64), 'OSC 52 payload contains the last reply');
});

test('/copy all: joins user + assistant content', async () => {
  const ctx = makeCtx([
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
  ]);
  const out = await captureStdout(async () => {
    const res = await runSlashCommand('/copy all', ctx);
    assert.equal(res.handled, true);
    assert.ok(res.message!.includes('Copied the conversation'));
  });
  const b64 = Buffer.from('q1\n\na1\n\nq2\n\na2', 'utf8').toString('base64');
  assert.ok(out.includes(b64), 'OSC 52 payload contains the joined transcript');
});

test('/copy: no assistant reply yet → helpful message, no clipboard write', async () => {
  const ctx = makeCtx([{ role: 'user', content: 'only a question' }]);
  const out = await captureStdout(async () => {
    const res = await runSlashCommand('/copy', ctx);
    assert.equal(res.handled, true);
    assert.ok(res.message!.includes('No assistant reply'));
  });
  assert.equal(out, '', 'no clipboard write happened');
});
