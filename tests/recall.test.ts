/**
 * Unit tests for /recall retrieval over saved sessions (src/recall.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { saveSession } from '../src/sessions.js';
import { recallSessions } from '../src/recall.js';

let tmp: string;
const origDir = process.env.ASTROCODE_SESSION_DIR;
test.before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astro-recall-'));
  process.env.ASTROCODE_SESSION_DIR = tmp;
  await saveSession('cache-fix', {
    cwd: '/tmp/x', model: 'm', mode: 'act',
    createdAt: new Date().toISOString(),
    messages: [
      { role: 'user', content: 'the build cache is stale again' },
      { role: 'assistant', content: 'We fixed the build cache by adding a version hash to the output dir.' },
    ],
  });
  await saveSession('deploy-notes', {
    cwd: '/tmp/x', model: 'm', mode: 'act',
    createdAt: new Date().toISOString(),
    messages: [
      { role: 'user', content: 'deploy to production' },
      { role: 'assistant', content: 'Deployment goes through the release pipeline.' },
    ],
  });
});
test.after(async () => {
  if (origDir === undefined) delete process.env.ASTROCODE_SESSION_DIR;
  else process.env.ASTROCODE_SESSION_DIR = origDir;
  await fs.rm(tmp, { recursive: true, force: true });
});

test('recall: ranks the relevant session first', async () => {
  const hits = await recallSessions('build cache');
  assert.ok(hits.length > 0);
  assert.equal(hits[0].name, 'cache-fix');
});

test('recall: snippet contains a query term', async () => {
  const hits = await recallSessions('build cache');
  assert.ok(hits[0].snippet.toLowerCase().includes('cache'));
});

test('recall: empty or single-char queries return nothing', async () => {
  assert.deepEqual(await recallSessions(''), []);
  assert.deepEqual(await recallSessions('x'), []); // tokens shorter than 2 chars filtered
});

test('recall: no matches returns empty', async () => {
  assert.deepEqual(await recallSessions('quantum waffles'), []);
});
