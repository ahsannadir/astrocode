/**
 * Unit tests for the workspace file index and @file attachments
 * (src/files.ts). Offline: temp dirs only, no network, no real repo required
 * (the walker is exercised by pointing it at a plain directory).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_ATTACH_CHARS,
  MAX_ATTACH_FILES,
  clearFileIndexCache,
  listWorkspaceFiles,
  parseGitFileList,
  readMentionAttachments,
} from '../src/files.js';

async function tmpdir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'astrocode-files-'));
}

test('parseGitFileList: trims, drops blanks, sorts, and bounds', () => {
  const index = parseGitFileList(' src/b.ts\nsrc/a.ts\n\n\nREADME.md\n', 10);
  assert.deepEqual(index.files, ['README.md', 'src/a.ts', 'src/b.ts']);
  assert.equal(index.truncated, false);
});

test('parseGitFileList: reports truncation instead of silently cutting', () => {
  const index = parseGitFileList('a\nb\nc\nd', 2);
  assert.equal(index.files.length, 2);
  assert.equal(index.truncated, true);
});

test('listWorkspaceFiles: walks a plain directory and skips build dirs', async () => {
  const dir = await tmpdir();
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  await fs.mkdir(path.join(dir, '.git'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'a.ts'), 'x');
  await fs.writeFile(path.join(dir, 'README.md'), 'x');
  await fs.writeFile(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
  await fs.writeFile(path.join(dir, '.git', 'config'), 'x');
  clearFileIndexCache();

  const index = await listWorkspaceFiles(dir);
  assert.deepEqual(index.files, ['README.md', 'src/a.ts']);

  // Cached: a file added afterwards is not re-indexed until the cache clears.
  await fs.writeFile(path.join(dir, 'late.ts'), 'x');
  assert.deepEqual((await listWorkspaceFiles(dir)).files, ['README.md', 'src/a.ts']);
  clearFileIndexCache();
  assert.ok((await listWorkspaceFiles(dir)).files.includes('late.ts'));

  await fs.rm(dir, { recursive: true, force: true });
});

test('readMentionAttachments: reads files in mention order, workspace-relative', async () => {
  const dir = await tmpdir();
  await fs.writeFile(path.join(dir, 'b.ts'), 'bravo');
  await fs.mkdir(path.join(dir, 'src'));
  await fs.writeFile(path.join(dir, 'src', 'a.ts'), 'alpha\nbeta');

  const r = await readMentionAttachments(['src/a.ts', 'b.ts'], dir);
  assert.deepEqual(r.paths, ['src/a.ts', 'b.ts']);
  assert.match(r.text, /<file path="src\/a.ts" lines="2">\nalpha\nbeta\n<\/file>/);
  assert.match(r.text, /<file path="b.ts" lines="1">\nbravo\n<\/file>/);

  await fs.rm(dir, { recursive: true, force: true });
});

test('readMentionAttachments: paths outside the workspace are refused', async () => {
  const dir = await tmpdir();
  const outside = await tmpdir();
  await fs.writeFile(path.join(outside, 'secret.txt'), 'nope');

  const r = await readMentionAttachments(
    ['../' + path.basename(outside) + '/secret.txt', '/etc/passwd'],
    dir,
  );
  assert.deepEqual(r.paths, []);
  assert.equal(r.text, '');

  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

test('readMentionAttachments: missing, binary, and directory mentions are skipped', async () => {
  const dir = await tmpdir();
  await fs.writeFile(path.join(dir, 'bin.dat'), 'a\u0000b');
  await fs.mkdir(path.join(dir, 'folder'));
  await fs.writeFile(path.join(dir, 'ok.ts'), 'yes');

  const r = await readMentionAttachments(
    ['missing.ts', 'bin.dat', 'folder', 'ok.ts'],
    dir,
  );
  assert.deepEqual(r.paths, ['ok.ts']);
  assert.match(r.text, /yes/);

  await fs.rm(dir, { recursive: true, force: true });
});

test('readMentionAttachments: caps the number of files per turn', async () => {
  const dir = await tmpdir();
  const names = Array.from({ length: MAX_ATTACH_FILES + 3 }, (_, i) => `f${i}.ts`);
  for (const n of names) await fs.writeFile(path.join(dir, n), 'x');

  const r = await readMentionAttachments(names, dir);
  assert.equal(r.paths.length, MAX_ATTACH_FILES);
  assert.deepEqual(r.paths, names.slice(0, MAX_ATTACH_FILES));

  await fs.rm(dir, { recursive: true, force: true });
});

test('readMentionAttachments: truncates a file and marks it for the model', async () => {
  const dir = await tmpdir();
  const big = 'x'.repeat(MAX_ATTACH_CHARS + 5000);
  await fs.writeFile(path.join(dir, 'big.txt'), big);
  await fs.writeFile(path.join(dir, 'small.txt'), 'small');

  const r = await readMentionAttachments(['big.txt', 'small.txt'], dir);
  // The huge file is truncated, not dropped: the remaining budget still fits
  // the small one, so both are attached (order preserved).
  assert.deepEqual(r.paths, ['big.txt', 'small.txt']);
  assert.match(r.text, /truncated="true"/);
  assert.match(r.text, /\[truncated \d+ characters\]/);
  assert.match(r.text, /small/);
  assert.ok(r.text.length < big.length, 'block must be smaller than the file');

  await fs.rm(dir, { recursive: true, force: true });
});

test('readMentionAttachments: reads nothing for an empty mention list', async () => {
  const r = await readMentionAttachments([], process.cwd());
  assert.deepEqual(r, { text: '', paths: [] });
});
