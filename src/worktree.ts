/**
 * Git-worktree sandboxing for AstroCode.
 *
 * Lets the agent do zero-risk experiments: create an ephemeral git worktree
 * (a separate checkout on its own branch), run/test there, and merge back
 * only when the branch is healthy — or discard it. Parallel tasks can run in
 * separate worktrees without file-lock conflicts.
 *
 * Worktrees live under the system temp dir (git refuses paths inside an
 * existing working tree) and are tracked in `<cwd>/.astrocode/worktrees.json`.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runShell } from './tools/shell.js';
import type { ToolResult } from './types.js';

function sanitize(name: string): string {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || 'sandbox';
}

function registryPath(cwd: string): string {
  return path.join(cwd, '.astrocode', 'worktrees.json');
}

async function readRegistry(cwd: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(registryPath(cwd), 'utf8');
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

async function writeRegistry(cwd: string, reg: Record<string, string>): Promise<void> {
  const file = registryPath(cwd);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Write-then-rename: readers must never observe a half-written registry, and
  // `JSON.parse` failing silently returns {} (see readRegistry), which would
  // make every tracked worktree look like it had vanished.
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(reg, null, 2), 'utf8');
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Serialises read-modify-write cycles on the registry, per `cwd`.
 *
 * Swarm mode creates one worktree per worker CONCURRENTLY. Each create used to
 * read the whole registry, add its own entry, then write the entire file back.
 * Two workers interleaving that cycle meant the second write landed WITHOUT
 * the first worker's entry — a lost update — so the first worker's
 * `mergeWorktree`/`discardWorktree` then reported `No worktree named "..."` and
 * its work was silently dropped. That is an intermittent
 * `tests/swarm.test.ts` failure: it never reproduced in isolation, only under
 * CPU load, because that is the only thing that makes the interleaving
 * likely. The lock is per-registry-path, so unrelated repos still run in
 * parallel.
 */
const registryLocks = new Map<string, Promise<unknown>>();

function withRegistry<T>(
  cwd: string,
  fn: (reg: Record<string, string>) => Promise<T> | T,
): Promise<T> {
  const file = registryPath(cwd);
  const prev = registryLocks.get(file) ?? Promise.resolve();
  const result = prev.then(async () => {
    const reg = await readRegistry(cwd);
    const value = await fn(reg);
    await writeRegistry(cwd, reg);
    return value;
  });
  // Keep the chain alive even if this link rejects, or one failure would
  // deadlock every later operation on this registry.
  registryLocks.set(
    file,
    result.catch(() => undefined),
  );
  return result;
}

function branchFor(name: string): string {
  return `astrocode/${sanitize(name)}`;
}

function dirFor(cwd: string, name: string): string {
  const slug = cwd.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').slice(0, 80);
  return path.join(os.tmpdir(), 'astrocode-worktrees', slug, sanitize(name));
}

function findName(reg: Record<string, string>, name: string): string | null {
  const want = branchFor(name);
  const key = Object.keys(reg).find((b) => b === want);
  return key ?? null;
}

export async function createWorktree(cwd: string, name: string): Promise<ToolResult> {
  const branch = branchFor(name);
  const dir = dirFor(cwd, name);
  // Reserve the slot under the lock, and do it BEFORE touching git so two
  // concurrent creates of the same name cannot both win the check. The git
  // call itself stays outside the lock — worktree creation is the slow part
  // and there is no reason to serialise it across workers.
  const reserved = await withRegistry(cwd, (reg) => {
    if (reg[branch]) return null;
    reg[branch] = dir;
    return true;
  });
  if (!reserved) {
    const existing = await readRegistry(cwd);
    return { ok: false, text: `Worktree "${name}" already exists (${existing[branch]}). Use list or discard first.` };
  }
  const res = await runShell(`git worktree add "${dir}" -b "${branch}"`, { cwd });
  if (!res.ok) {
    // Roll the reservation back, or the name stays permanently "taken" by a
    // worktree that does not exist.
    await withRegistry(cwd, (reg) => {
      delete reg[branch];
    });
    return { ok: false, text: `git worktree add failed:\n${res.text}` };
  }
  return { ok: true, text: `Created worktree branch "${branch}" at ${dir}` };
}

export async function runInWorktree(
  cwd: string,
  name: string,
  command: string,
  timeoutMs?: number,
): Promise<ToolResult> {
  const reg = await readRegistry(cwd);
  const key = findName(reg, name);
  if (!key) return { ok: false, text: `No worktree named "${name}". Use worktree create first.` };
  return runShell(command, { cwd: reg[key], timeoutMs });
}

export async function mergeWorktree(cwd: string, name: string): Promise<ToolResult> {
  const reg = await readRegistry(cwd);
  const key = findName(reg, name);
  if (!key) return { ok: false, text: `No worktree named "${name}". Use worktree create first.` };
  const dir = reg[key];
  // Commit everything in the worktree branch first.
  const add = await runShell('git add -A', { cwd: dir });
  if (!add.ok) return { ok: false, text: `git add (worktree) failed:\n${add.text}` };
  const commit = await runShell('git commit -m "astrocode: worktree merge"', { cwd: dir });
  if (!commit.ok) {
    // Nothing to commit is fine — the branch may be unchanged.
    if (!/nothing to commit/i.test(commit.text)) {
      return { ok: false, text: `git commit (worktree) failed:\n${commit.text}` };
    }
  }
  const merge = await runShell(`git merge --no-edit "${key}"`, { cwd });
  if (merge.ok) {
    return { ok: true, text: `Merged worktree branch "${key}" into the current branch.` };
  }
  const mainStatus = await runShell('git status --porcelain', { cwd });
  const dirty = mainStatus.text.trim().length > 0;
  return {
    ok: false,
    text:
      `git merge failed:\n${merge.text}` +
      (dirty
        ? '\n\nHint: the main working tree has uncommitted/untracked changes. ' +
          'Commit or stash them (or discard them) before merging.'
        : ''),
  };
}

export async function listWorktrees(cwd: string): Promise<ToolResult> {
  const reg = await readRegistry(cwd);
  const res = await runShell('git worktree list', { cwd });
  const entries = Object.entries(reg);
  const tracked =
    entries.length === 0
      ? '  (none tracked)'
      : entries.map(([b, d]) => `  ${b.padEnd(24)} ${d}`).join('\n');
  return {
    ok: true,
    text: `Tracked sandbox worktrees:\n${tracked}\n\n$ git worktree list\n${res.ok ? res.text.trim() : res.text}`,
  };
}

export async function discardWorktree(cwd: string, name: string): Promise<ToolResult> {
  const key = await withRegistry(cwd, (reg) => findName(reg, name));
  if (!key) return { ok: false, text: `No worktree named "${name}". Use worktree create first.` };
  const dir = (await readRegistry(cwd))[key];
  const remove = await runShell(`git worktree remove --force "${dir}"`, { cwd });
  if (!remove.ok) {
    return { ok: false, text: `git worktree remove failed:\n${remove.text}` };
  }
  // Remove the branch (the worktree has already been removed, so this is safe).
  const del = await runShell(`git branch -D "${key}"`, { cwd });
  // Only drop the registry entry now that the worktree is really gone, and do
  // it under the lock so a concurrent create isn't clobbered by our stale copy.
  await withRegistry(cwd, (reg) => {
    delete reg[key];
  });
  return {
    ok: true,
    text: del.ok
      ? `Discarded worktree "${key}".`
      : `Worktree removed, but branch deletion reported: ${del.text.trim()}`,
  };
}
