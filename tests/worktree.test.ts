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

test('worktree: concurrent creates do not clobber each other', { skip: !hasGit }, async () => {
  // Swarm mode creates one worktree per worker at the SAME time. Each create
  // used to read the whole registry, add its entry, and write the file back —
  // so two interleaved creates lost one's entry and the loser later failed
  // with `No worktree named ...`, silently dropping its work. The failure was
  // load-dependent (it never reproduced in isolation), which is exactly why
  // it needs a test that creates them all at once.
  const names = ['par1', 'par2', 'par3', 'par4', 'par5', 'par6'];
  const results = await Promise.all(names.map((n) => createWorktree(repo, n)));
  for (let i = 0; i < names.length; i++) {
    assert.ok(results[i].ok, `${names[i]}: ${results[i].text}`);
  }
  // Every single one must still be resolvable — that is what was being lost.
  for (const n of names) {
    const r = await runInWorktree(repo, n, 'echo hi');
    assert.ok(r.ok, `${n} vanished from the registry: ${r.text}`);
  }
  // And the on-disk registry must be valid JSON, not a truncated write.
  const raw = await fs.readFile(path.join(repo, '.astrocode', 'worktrees.json'), 'utf8');
  const reg = JSON.parse(raw);
  for (const n of names) assert.ok(reg[`astrocode/${n}`], `${n} missing from registry file`);

  for (const n of names) {
    const d = await discardWorktree(repo, n);
    assert.ok(d.ok, `${n}: ${d.text}`);
  }
});

test('worktree: a duplicate create is refused and the name is reusable after discard', { skip: !hasGit }, async () => {
  // createWorktree reserves the name under the lock BEFORE running git so two
  // concurrent creates cannot both win the check — and so the check and the
  // insert are a single atomic step rather than two racing ones.
  const name = 'dupe-check';
  const first = await createWorktree(repo, name);
  assert.ok(first.ok, first.text);
  const dup = await createWorktree(repo, name);
  assert.ok(!dup.ok, 'a second create of the same name must be refused');
  assert.ok(dup.text.includes('already exists'), dup.text);

  const d = await discardWorktree(repo, name);
  assert.ok(d.ok, d.text);
  // Discard released the reservation, so the name is free again.
  const again = await createWorktree(repo, name);
  assert.ok(again.ok, `name was not released after discard: ${again.text}`);
  const d2 = await discardWorktree(repo, name);
  assert.ok(d2.ok, d2.text);
});
