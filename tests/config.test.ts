/**
 * Unit tests for config loading (src/config.ts) — env-vs-persisted precedence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { saveAuth } from '../src/auth.js';
import { loadConfig, parseArgs } from '../src/config.js';

let tmp: string;
const origFile = process.env.ASTROCODE_AUTH_FILE;
const ENV_NAMES = [
  'ASTROCODE_API_KEY',
  'ASTROCODE_MODEL',
  'ASTROCODE_BASE_URL',
  'ASTROCODE_MAX_TURNS',
  'ASTROCODE_BUDGET',
  'ASTROCODE_VERIFY',
  'ASTROCODE_AUTOCOMMIT',
  'ASTROCODE_THEME',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
];
const origEnv = new Map(ENV_NAMES.map((n) => [n, process.env[n]]));
test.before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astro-cfg-'));
  process.env.ASTROCODE_AUTH_FILE = path.join(tmp, 'config.json');
});
test.after(async () => {
  if (origFile === undefined) delete process.env.ASTROCODE_AUTH_FILE;
  else process.env.ASTROCODE_AUTH_FILE = origFile;
  for (const [n, v] of origEnv) {
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
  await fs.rm(tmp, { recursive: true, force: true });
});

test('config: persisted auth + settings are merged into loadConfig', () => {
  saveAuth({
    provider: 'openrouter',
    apiKey: 'sk-or-1',
    model: 'openai/gpt-4o',
    verify: true,
    autocommit: true,
    maxToolTurns: 50,
    budget: 5,
    theme: 'ocean',
  });
  const cfg = loadConfig(parseArgs([]));
  assert.equal(cfg.apiKey, 'sk-or-1');
  assert.equal(cfg.model, 'openai/gpt-4o');
  assert.equal(cfg.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(cfg.verify, true);
  assert.equal(cfg.autocommit, true);
  assert.equal(cfg.maxToolTurns, 50);
  assert.equal(cfg.budget, 5);
  assert.equal(cfg.theme, 'ocean');
  assert.equal(cfg.demo, false);
});

test('config: ASTROCODE_THEME env wins over the persisted theme', () => {
  // Use a separate auth file so this test doesn't clobber the shared one.
  const prev = process.env.ASTROCODE_AUTH_FILE;
  process.env.ASTROCODE_AUTH_FILE = path.join(tmp, 'theme.json');
  saveAuth({
    provider: 'openai',
    apiKey: 'sk-x',
    model: 'gpt-4o',
    theme: 'ocean',
  });
  process.env.ASTROCODE_THEME = 'matrix';
  const cfg = loadConfig(parseArgs([]));
  assert.equal(cfg.theme, 'matrix');
  delete process.env.ASTROCODE_THEME;
  if (prev === undefined) delete process.env.ASTROCODE_AUTH_FILE;
  else process.env.ASTROCODE_AUTH_FILE = prev;
});

test('config: env vars win over persisted settings', () => {
  process.env.ASTROCODE_MODEL = 'gpt-4o-mini';
  process.env.ASTROCODE_VERIFY = '1';
  process.env.ASTROCODE_BUDGET = '2';
  const cfg = loadConfig(parseArgs([]));
  assert.equal(cfg.model, 'gpt-4o-mini');
  assert.equal(cfg.verify, true);
  assert.equal(cfg.budget, 2);
  assert.equal(cfg.maxToolTurns, 50); // no env override → stored value
  delete process.env.ASTROCODE_MODEL;
  delete process.env.ASTROCODE_VERIFY;
  delete process.env.ASTROCODE_BUDGET;
});

test('config: explicit env "off" overrides persisted settings', () => {
  saveAuth({
    provider: 'openai',
    apiKey: 'sk-x',
    model: 'gpt-4o',
    verify: true,
    autocommit: true,
    maxToolTurns: 50,
    budget: 5,
  });
  process.env.ASTROCODE_VERIFY = '0';
  process.env.ASTROCODE_AUTOCOMMIT = '0';
  process.env.ASTROCODE_BUDGET = '0';
  const cfg = loadConfig(parseArgs([]));
  assert.equal(cfg.verify, false, 'env 0 must override persisted true');
  assert.equal(cfg.autocommit, false, 'env 0 must override persisted true');
  assert.equal(cfg.budget, 0, 'env 0 (unlimited) must override persisted 5');
  delete process.env.ASTROCODE_VERIFY;
  delete process.env.ASTROCODE_AUTOCOMMIT;
  delete process.env.ASTROCODE_BUDGET;
});

test('config: no config file → demo defaults', () => {
  process.env.ASTROCODE_AUTH_FILE = path.join(tmp, 'none.json');
  const cfg = loadConfig(parseArgs([]));
  assert.equal(cfg.apiKey, '');
  assert.equal(cfg.demo, true);
  assert.equal(cfg.verify, false);
  assert.equal(cfg.autocommit, false);
  assert.equal(cfg.maxToolTurns, 20);
  assert.equal(cfg.model, 'gpt-4o'); // OpenAI default
});
