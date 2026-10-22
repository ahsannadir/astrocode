/**
 * Unit tests for slash-command handling and the "/" menu.
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

test('filterSlashCommands: prefix matches beat substring matches, stable within groups', () => {
  // A partial name ranks its prefix match first (/model for "mode").
  const model = filterSlashCommands('mode').map((c) => c.name);
  assert.equal(model[0], '/model');
  // For "s": every name that STARTS with s ranks above names that merely
  // contain it (/cost, /tools, …).
  const s = filterSlashCommands('s').map((c) => c.name);
  const firstContains = s.findIndex((n) => !n.slice(1).toLowerCase().startsWith('s'));
  assert.ok(firstContains > 0, 'there are both prefix and substring matches');
  assert.ok(s.slice(0, firstContains).every((n) => n.slice(1).toLowerCase().startsWith('s')));
  assert.ok(s.slice(firstContains).every((n) => !n.slice(1).toLowerCase().startsWith('s')));
});

test('resolveSlashSubmission: a complete command is never morphed into a longer one', () => {
  // A synthetic prefix pair, independent of what the registry happens to hold.
  const matches = [
    { name: '/run', description: 'probe', usage: '/run' },
    { name: '/running', description: 'probe', usage: '/running' },
  ];
  assert.equal(resolveSlashSubmission('/run', matches, 0), '/run');
  assert.equal(resolveSlashSubmission('/running', matches, 0), '/running');
});

test('resolveSlashSubmission: partial text runs the highlighted command', () => {
  assert.equal(resolveSlashSubmission('/he', filterSlashCommands('he'), 0), '/help');
});

test('resolveSlashSubmission: typed arguments survive completion', () => {
  const matches = filterSlashCommands('mod');
  const sel = matches.findIndex((c) => c.name === '/model');
  assert.ok(sel >= 0);
  assert.equal(resolveSlashSubmission('/mod gpt-4o', matches, sel), '/model gpt-4o');
});

test('resolveSlashSubmission: nothing to run returns null', () => {
  assert.equal(resolveSlashSubmission('/nope', [], 0), null);
  assert.equal(resolveSlashSubmission('   ', [], 0), null);
});

test('SLASH_SAFE_WHILE_BUSY: every entry is a real, informational command', () => {
  const names = new Set(SLASH_COMMANDS.map((c) => c.name));
  for (const n of SLASH_SAFE_WHILE_BUSY) assert.ok(names.has(n), `${n} is a slash command`);
  assert.ok(SLASH_SAFE_WHILE_BUSY.has('/help'));
  assert.equal(SLASH_SAFE_WHILE_BUSY.has('/plan'), false);
});

test('/commit: passes a custom message through (not just a boolean flag)', async () => {
  const ctx = makeCtx([]);
  const withMsg = await runSlashCommand('/commit fix: tidy the parser', ctx);
  assert.equal(withMsg.handled, true);
  assert.equal(withMsg.autocommit, 'fix: tidy the parser');
  assert.ok(withMsg.message!.includes('fix: tidy the parser'));

  const noMsg = await runSlashCommand('/commit', ctx);
  assert.equal(noMsg.handled, true);
  // Empty string = "use the generated default message"; must still trigger a commit.
  assert.equal(noMsg.autocommit, '');
  assert.notEqual(noMsg.autocommit, undefined);
});

test('/act and /clear are no longer commands', async () => {
  const names = new Set(SLASH_COMMANDS.map((c) => c.name));
  assert.equal(names.has('/act'), false);
  assert.equal(names.has('/clear'), false);

  const ctx = makeCtx([]);
  for (const removed of ['/act', '/clear']) {
    const res = await runSlashCommand(removed, ctx);
    assert.equal(res.handled, true, `${removed} is handled as unknown`);
    assert.equal(res.clear, undefined, `${removed} does not clear the conversation`);
    assert.equal(res.mode, undefined, `${removed} does not change the mode`);
    assert.ok(res.message!.includes('Unknown slash command'), `${removed} → unknown command`);
  }
});

test('/quit and /copy are no longer commands', async () => {
  const names = new Set(SLASH_COMMANDS.map((c) => c.name));
  assert.equal(names.has('/quit'), false);
  assert.equal(names.has('/copy'), false);

  const ctx = makeCtx([]);
  for (const removed of ['/quit', '/copy', '/copy all']) {
    const res = await runSlashCommand(removed, ctx);
    assert.equal(res.handled, true, `${removed} is handled as unknown`);
    assert.equal(res.exit, undefined);
    assert.ok(res.message!.includes('Unknown slash command'), `${removed} → unknown command`);
  }
});

test('/exit quits the app', async () => {
  const ctx = makeCtx([]);
  const res = await runSlashCommand('/exit', ctx);
  assert.equal(res.handled, true);
  assert.equal(res.exit, true);
});
