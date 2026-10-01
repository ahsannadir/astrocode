/**
 * Unit tests for slash-command handlers that touch the clipboard (/copy).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterSlashCommands,
  resolveSlashSubmission,
  runSlashCommand,
  SLASH_COMMANDS,
  SLASH_SAFE_WHILE_BUSY,
} from '../src/commands/slash.js';
import type { SlashContext } from '../src/commands/slash.js';

/** Look up a command definition by name (test helper). */
function cmd(name: string) {
  const c = SLASH_COMMANDS.find((x) => x.name === name);
  assert.ok(c, `${name} exists in SLASH_COMMANDS`);
  return c!;
}

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

test('filterSlashCommands: empty query lists every command in declaration order', () => {
  const all = filterSlashCommands('');
  assert.deepEqual(all.map((c) => c.name), SLASH_COMMANDS.map((c) => c.name));
});

test('filterSlashCommands: matches case-insensitively', () => {
  assert.equal(filterSlashCommands('HELP')[0].name, '/help');
});

test('filterSlashCommands: whitespace means arguments — menu closes', () => {
  assert.deepEqual(filterSlashCommands('model '), []);
  assert.deepEqual(filterSlashCommands('load my-session'), []);
});

test('filterSlashCommands: exact beats prefix beats substring, stable within groups', () => {
  // "/model" is both a complete command and a prefix of "/models".
  const model = filterSlashCommands('model').map((c) => c.name);
  assert.equal(model[0], '/model');
  assert.ok(model.includes('/models'));
  // For "s": every name that STARTS with s ranks above names that merely
  // contain it (/cost, /tools, /models, …).
  const s = filterSlashCommands('s').map((c) => c.name);
  const firstContains = s.findIndex((n) => !n.slice(1).toLowerCase().startsWith('s'));
  assert.ok(firstContains > 0, 'there are both prefix and substring matches');
  assert.ok(s.slice(0, firstContains).every((n) => n.slice(1).toLowerCase().startsWith('s')));
  assert.ok(s.slice(firstContains).every((n) => !n.slice(1).toLowerCase().startsWith('s')));
});

test('resolveSlashSubmission: a complete command is never morphed into a longer one', () => {
  // Simulate the old/hostile order where /models sits above /model.
  const matches = [cmd('/models'), cmd('/model')];
  assert.equal(resolveSlashSubmission('/model', matches, 0), '/model');
  assert.equal(resolveSlashSubmission('/models', matches, 0), '/models');
});

test('resolveSlashSubmission: partial text runs the highlighted command', () => {
  assert.equal(resolveSlashSubmission('/he', filterSlashCommands('he'), 0), '/help');
});

test('resolveSlashSubmission: typed arguments survive completion', () => {
  const matches = filterSlashCommands('mod');
  const sel = matches.findIndex((c) => c.name === '/models');
  assert.ok(sel >= 0);
  assert.equal(resolveSlashSubmission('/mod gpt-4o', matches, sel), '/models gpt-4o');
});

test('resolveSlashSubmission: nothing to run returns null', () => {
  assert.equal(resolveSlashSubmission('/nope', [], 0), null);
  assert.equal(resolveSlashSubmission('   ', [], 0), null);
});

test('SLASH_SAFE_WHILE_BUSY: every entry is a real, informational command', () => {
  const names = new Set(SLASH_COMMANDS.map((c) => c.name));
  for (const n of SLASH_SAFE_WHILE_BUSY) assert.ok(names.has(n), `${n} is a slash command`);
  assert.ok(SLASH_SAFE_WHILE_BUSY.has('/help'));
  assert.equal(SLASH_SAFE_WHILE_BUSY.has('/clear'), false);
  assert.equal(SLASH_SAFE_WHILE_BUSY.has('/plan'), false);
});

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
