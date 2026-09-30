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
  await fs.mkdir(path.dirname(registryPath(cwd)), { recursive: true });
  await fs.writeFile(registryPath(cwd), JSON.stringify(reg, null, 2), 'utf8');
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
  const reg = await readRegistry(cwd);
  const branch = branchFor(name);
  const dir = dirFor(cwd, name);
  if (reg[branch]) {
    return { ok: false, text: `Worktree "${name}" already exists (${reg[branch]}). Use list or discard first.` };
  }
  const res = await runShell(`git worktree add "${dir}" -b "${branch}"`, { cwd });
  if (!res.ok) {
    return { ok: false, text: `git worktree add failed:\n${res.text}` };
  }
  reg[branch] = dir;
  await writeRegistry(cwd, reg);
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
  const reg = await readRegistry(cwd);
  const key = findName(reg, name);
  if (!key) return { ok: false, text: `No worktree named "${name}". Use worktree create first.` };
  const dir = reg[key];
  const remove = await runShell(`git worktree remove --force "${dir}"`, { cwd });
  if (!remove.ok) {
    return { ok: false, text: `git worktree remove failed:\n${remove.text}` };
  }
  // Remove the branch (the worktree has already been removed, so this is safe).
  const del = await runShell(`git branch -D "${key}"`, { cwd });
  delete reg[key];
  await writeRegistry(cwd, reg);
  return {
    ok: true,
    text: del.ok
      ? `Discarded worktree "${key}".`
      : `Worktree removed, but branch deletion reported: ${del.text.trim()}`,
  };
}
