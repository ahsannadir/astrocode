/**
 * Unit tests for undo snapshots and turn-level checkpoints (src/undo.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  snapshotFile,
  revertLast,
  markTurnBoundary,
  changesSinceLastBoundary,
  rewindTurn,
  undoCount,
} from '../src/undo.js';

let tmp: string;
test.before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astro-undo-'));
});
test.after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

test('undo: snapshot + revert restores previous content', async () => {
  const fp = path.join(tmp, 'a.txt');
  await fs.writeFile(fp, 'original', 'utf8');
  await snapshotFile(fp);
  await fs.writeFile(fp, 'modified', 'utf8');
  const r = await revertLast();
  assert.ok(r.ok);
  assert.equal(await fs.readFile(fp, 'utf8'), 'original');
});

test('undo: reverting a created file removes it', async () => {
  const fp = path.join(tmp, 'b.txt');
  await snapshotFile(fp); // file does not exist yet
  await fs.writeFile(fp, 'new', 'utf8');
  const r = await revertLast();
  assert.ok(r.ok);
  await assert.rejects(fs.readFile(fp, 'utf8'));
});

test('rewind: reverts every change since the turn boundary', async () => {
  const fp = path.join(tmp, 'c.txt');
  await fs.writeFile(fp, 'v0', 'utf8');

  markTurnBoundary();
  await snapshotFile(fp);
  await fs.writeFile(fp, 'v1', 'utf8');
  await snapshotFile(fp);
  await fs.writeFile(fp, 'v2', 'utf8');
  assert.equal(changesSinceLastBoundary(), 2);

  const r = await rewindTurn();
  assert.ok(r.ok);
  assert.equal(r.count, 2);
  assert.equal(await fs.readFile(fp, 'utf8'), 'v0');
  assert.equal(changesSinceLastBoundary(), 0);
  assert.equal(undoCount(), 0); // stack fully drained back to the boundary
});
