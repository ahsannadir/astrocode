/**
 * Unit tests for session persistence (src/sessions.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
} from '../src/sessions.js';

let tmp: string;
const origDir = process.env.ASTROCODE_SESSION_DIR;
test.before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astro-sess-'));
  process.env.ASTROCODE_SESSION_DIR = tmp;
});
test.after(async () => {
  if (origDir === undefined) delete process.env.ASTROCODE_SESSION_DIR;
  else process.env.ASTROCODE_SESSION_DIR = origDir;
  await fs.rm(tmp, { recursive: true, force: true });
});

test('sessions: save → load round-trip', async () => {
  const saved = await saveSession('My Session!', {
    cwd: '/tmp/x',
    model: 'gpt-4o-mini',
    mode: 'act',
    createdAt: new Date().toISOString(),
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ],
  });
  assert.equal(saved.name, 'my-session'); // slugified
  const loaded = await loadSession('my-session');
  assert.ok(loaded);
  assert.equal(loaded!.messages.length, 2);
  assert.equal(loaded!.model, 'gpt-4o-mini');
});

test('sessions: legacy trailing-dash files still load (sanitize fallback)', async () => {
  // A session saved before sanitize trimmed dashes is filed as legacy-session-.json
  // (no modern legacy-session.json exists, so the raw-name fallback must find it).
  const legacy = path.join(tmp, 'legacy-session-.json');
  await fs.writeFile(
    legacy,
    JSON.stringify({
      name: 'legacy-session-', cwd: '/tmp/x', model: 'm', mode: 'act',
      createdAt: '2026-01-01', updatedAt: '2026-01-01',
      messages: [{ role: 'user', content: 'legacy' }],
    }),
    'utf8',
  );
  const loaded = await loadSession('legacy-session-');
  assert.ok(loaded, 'loadSession should fall back to the raw name');
  assert.equal(loaded!.name, 'legacy-session-');
});

test('sessions: list sorts by recency and reports metadata', async () => {
  await saveSession('older', {
    cwd: '/tmp/x', model: 'm', mode: 'act',
    createdAt: new Date(Date.now() - 10_000).toISOString(),
    messages: [],
  });
  await saveSession('newer', {
    cwd: '/tmp/x', model: 'm', mode: 'plan',
    createdAt: new Date().toISOString(),
    messages: [{ role: 'user', content: 'x' }],
  });
  const list = await listSessions();
  assert.ok(list.length >= 2);
  assert.equal(list[0].name, 'newer'); // newest first
  assert.equal(list[0].mode, 'plan');
});

test('sessions: delete removes the file', async () => {
  assert.equal(await deleteSession('older'), true);
  assert.equal(await loadSession('older'), null);
  assert.equal(await deleteSession('does-not-exist'), false);
});
