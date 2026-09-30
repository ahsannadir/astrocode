/**
 * Integration tests for git-worktree sandboxing (src/worktree.ts).
 * Skipped automatically when git is unavailable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import {
  createWorktree,
  runInWorktree,
  listWorktrees,
  mergeWorktree,
  discardWorktree,
} from '../src/worktree.js';

let hasGit = true;
try {
  execSync('git --version', { stdio: 'ignore' });
} catch {
  hasGit = false;
}

let repo: string;
test.before(async () => {
  if (!hasGit) return;
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'astro-wt-'));
  execSync('git init -q && git config user.email t@t.t && git config user.name t && git commit --allow-empty -qm init', { cwd: repo });
  await fs.writeFile(path.join(repo, 'a.txt'), 'hello\n', 'utf8');
  execSync('git add a.txt && git commit -qm base', { cwd: repo });
});
test.after(async () => {
  if (!hasGit) return;
  await fs.rm(repo, { recursive: true, force: true });
});

test('worktree: full create → run → merge → discard lifecycle', { skip: !hasGit }, async () => {
  const c = await createWorktree(repo, 'exp1');
  assert.ok(c.ok, c.text);

  const list = await listWorktrees(repo);
  assert.ok(list.text.includes('exp1'));

  const run = await runInWorktree(repo, 'exp1', 'node -e "console.log(1+1)"');
  assert.ok(run.ok && run.text.includes('2'), run.text);

  // Make a change in the worktree and merge it back.
  const regRaw = await fs.readFile(path.join(repo, '.astrocode', 'worktrees.json'), 'utf8');
  const wtDir = JSON.parse(regRaw)['astrocode/exp1'];
  assert.ok(wtDir, 'worktree registered in .astrocode/worktrees.json');
  await fs.writeFile(path.join(wtDir, 'a.txt'), 'hello worktree\n', 'utf8');

  const m = await mergeWorktree(repo, 'exp1');
  assert.ok(m.ok, m.text);
  const merged = await fs.readFile(path.join(repo, 'a.txt'), 'utf8');
  assert.ok(merged.includes('worktree'), 'merged content visible in the main tree');

  const d = await discardWorktree(repo, 'exp1');
  assert.ok(d.ok, d.text);
  const after = await listWorktrees(repo);
  assert.ok(!after.text.includes('exp1'), 'worktree no longer listed');
});

test('worktree: unknown name gives a clear error', { skip: !hasGit }, async () => {
  const r = await runInWorktree(repo, 'nope', 'echo hi');
  assert.ok(!r.ok);
  assert.ok(r.text.includes('No worktree named "nope"'));
});
