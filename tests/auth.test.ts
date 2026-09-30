/**
 * Unit tests for auth/config persistence (src/auth.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadAuth, saveAuth } from '../src/auth.js';

let tmp: string;
const origFile = process.env.ASTROCODE_AUTH_FILE;
test.before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astro-auth-'));
  process.env.ASTROCODE_AUTH_FILE = path.join(tmp, 'config.json');
});
test.after(async () => {
  if (origFile === undefined) delete process.env.ASTROCODE_AUTH_FILE;
  else process.env.ASTROCODE_AUTH_FILE = origFile;
  await fs.rm(tmp, { recursive: true, force: true });
});

test('auth: save → load round-trip', () => {
  saveAuth({
    provider: 'anthropic',
    apiKey: 'sk-ant-test-123',
    model: 'claude-3-5-sonnet-20241022',
  });
  const loaded = loadAuth();
  assert.ok(loaded);
  assert.equal(loaded!.provider, 'anthropic');
  assert.equal(loaded!.apiKey, 'sk-ant-test-123');
  assert.equal(loaded!.model, 'claude-3-5-sonnet-20241022');
});

test('auth: settings fields round-trip', () => {
  saveAuth({
    provider: 'openrouter',
    apiKey: 'sk-or-x',
    model: 'openai/gpt-4o',
    verify: true,
    autocommit: true,
    maxToolTurns: 50,
    budget: 5,
  });
  const loaded = loadAuth();
  assert.ok(loaded);
  assert.equal(loaded!.verify, true);
  assert.equal(loaded!.autocommit, true);
  assert.equal(loaded!.maxToolTurns, 50);
  assert.equal(loaded!.budget, 5);
});

test('auth: baseUrl round-trips for the openai-compatible provider', () => {
  saveAuth({
    provider: 'openai-compatible',
    apiKey: '',
    model: 'llama3.1:70b',
    baseUrl: 'http://localhost:11434/v1',
  });
  const loaded = loadAuth();
  assert.ok(loaded);
  assert.equal(loaded!.provider, 'openai-compatible');
  assert.equal(loaded!.baseUrl, 'http://localhost:11434/v1');
  assert.equal(loaded!.apiKey, '');
  assert.equal(loaded!.model, 'llama3.1:70b');
  // Built-in providers just leave the field out entirely.
  saveAuth({ provider: 'openai', apiKey: 'sk-x', model: 'gpt-4o' });
  const bare = loadAuth();
  assert.ok(bare);
  assert.equal(bare!.baseUrl, undefined);
});

test('auth: config without apiKey still loads (settings persist in demo)', () => {
  saveAuth({ provider: 'openai', apiKey: '', model: 'gpt-4o', verify: true });
  const loaded = loadAuth();
  assert.ok(loaded);
  assert.equal(loaded!.apiKey, '');
  assert.equal(loaded!.verify, true);
});

test('auth: loadAuth returns null when no file exists', () => {
  process.env.ASTROCODE_AUTH_FILE = path.join(tmp, 'missing.json');
  assert.equal(loadAuth(), null);
});

test('auth: corrupt file returns null instead of throwing', async () => {
  const file = path.join(tmp, 'corrupt.json');
  process.env.ASTROCODE_AUTH_FILE = file;
  await fs.writeFile(file, '{not json', 'utf8');
  assert.equal(loadAuth(), null);
});

test('auth: empty object file returns null', async () => {
  const file = path.join(tmp, 'empty.json');
  process.env.ASTROCODE_AUTH_FILE = file;
  await fs.writeFile(file, '{}', 'utf8');
  assert.equal(loadAuth(), null);
});
