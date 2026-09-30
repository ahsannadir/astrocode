/**
 * Repo map for AstroCode.
 *
 * Builds a compact, token-efficient overview of the workspace so the agent
 * understands project structure without first having to list every directory.
 * Inspired by Aider's repo map, but lightweight & dependency-free: a filtered
 * directory tree (node_modules/.git/dist etc. skipped), file counts, and
 * summaries of key files (package.json scripts/dep counts, README blurb,
 * .gitignore presence). Cached after first build; call buildRepoMap(cwd) to
 * refresh (e.g. /map).
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { runShell } from './tools/shell.js';

export interface RepoMapResult {
  text: string;
  fileCount: number;
  dirCount: number;
  pruned: boolean;
}

const SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.turbo',
  '.svelte-kit', '.cache', 'coverage', '.astro', '.gradle', 'target',
  '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache',
  '.DS_Store', 'out', '.output', '.vercel',
]);

const MAX_FILES = 400;
const MAX_DEPTH = 6;

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
}

interface Budget {
  count: number;
}

async function buildTree(dir: string, depth: number, budget: Budget): Promise<TreeNode> {
  const node: TreeNode = { name: path.basename(dir) || dir, path: dir, isDir: true };
  if (depth > MAX_DEPTH || budget.count <= 0) {
    node.children = [];
    return node;
  }
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    node.children = [];
    return node;
  }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const kids: TreeNode[] = [];
  for (const e of entries) {
    if (budget.count <= 0) break;
    if (SKIP.has(e.name)) continue;
    if (e.isDirectory()) {
      kids.push(await buildTree(path.join(dir, e.name), depth + 1, budget));
    } else if (e.isFile() || e.isSymbolicLink()) {
      kids.push({ name: e.name, path: path.join(dir, e.name), isDir: false });
      budget.count--;
    }
  }
  node.children = kids;
  return node;
}

function renderTree(
  node: TreeNode,
  prefix: string,
  isLast: boolean,
  depth: number,
  acc: { lines: string[]; files: number },
): void {
  if (acc.files > MAX_FILES) return;
  if (depth > 0) {
    const branch = isLast ? '└─ ' : '├─ ';
    acc.lines.push(`${prefix}${branch}${node.isDir ? node.name + '/' : node.name}`);
  }
  if (!node.isDir) {
    acc.files++;
    return;
  }
  const nextPrefix = depth === 0 ? '' : prefix + (isLast ? '   ' : '│  ');
  const kids = node.children ?? [];
  for (let i = 0; i < kids.length; i++) {
    renderTree(kids[i], nextPrefix, i === kids.length - 1, depth + 1, acc);
    if (acc.files > MAX_FILES) {
      acc.lines.push(`${nextPrefix}└─ … (truncated)`);
      return;
    }
  }
}

function countNodes(node: TreeNode, acc: { files: number; dirs: number }): void {
  if (!node.isDir) {
    acc.files++;
    return;
  }
  acc.dirs++;
  for (const c of node.children ?? []) countNodes(c, acc);
}

async function summarizeKeyFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const raw = await fs.readFile(path.join(root, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    const scripts = pkg.scripts ? Object.keys(pkg.scripts) : [];
    const deps = pkg.dependencies ? Object.keys(pkg.dependencies) : [];
    const devDeps = pkg.devDependencies ? Object.keys(pkg.devDependencies) : [];
    out.push(
      `package.json — ${pkg.name ?? '(unnamed)'} v${pkg.version ?? '?'} · ` +
        `${pkg.type === 'module' ? 'ESM' : 'CJS'} · ` +
        `${scripts.length} scripts [${scripts.slice(0, 12).join(', ')}] · ` +
        `${deps.length} deps, ${devDeps.length} devDeps`,
    );
  } catch {
    /* not a node project */
  }
  for (const name of ['README.md', 'README', 'readme.md', 'README.txt']) {
    try {
      const txt = (await fs.readFile(path.join(root, name), 'utf8')).slice(0, 4000);
      const firstLines = txt
        .split('\n')
        .filter((l) => l.trim())
        .slice(0, 3)
        .map((l) => l.replace(/^#+\s*/, '').trim())
        .join(' / ');
      if (firstLines) {
        out.push(`${name}: ${firstLines.slice(0, 160)}`);
        break;
      }
    } catch {
      /* no readme */
    }
  }
  try {
    await fs.access(path.join(root, '.gitignore'));
    out.push('.gitignore: present');
  } catch {
    /* no gitignore */
  }
  return out;
}

let cache: { cwd: string; map: RepoMapResult } | null = null;

export async function buildRepoMap(cwd: string): Promise<RepoMapResult> {
  const budget: Budget = { count: MAX_FILES + 50 };
  const tree = await buildTree(cwd, 0, budget);
  const counts = { files: 0, dirs: 0 };
  countNodes(tree, counts);
  const acc = { lines: [] as string[], files: 0 };
  renderTree(tree, '', true, 0, acc);
  const keyFiles = await summarizeKeyFiles(cwd);
  const git = await runShell('git rev-parse --abbrev-ref HEAD 2>/dev/null', { cwd });
  const branch = git.ok ? git.text.trim().replace(/\n.*/, '') : '';

  const lines: string[] = [];
  lines.push('PROJECT MAP');
  lines.push(branch ? `git branch: ${branch}` : '(not a git repository)');
  lines.push(
    `${counts.files} files · ${counts.dirs} dirs${budget.count <= 0 ? ' · (pruned)' : ''}`,
  );
  lines.push('');
  lines.push('Structure:');
  lines.push(...acc.lines);
  if (keyFiles.length > 0) {
    lines.push('');
    lines.push('Key files:');
    for (const k of keyFiles) lines.push(`- ${k}`);
  }
  const result: RepoMapResult = {
    text: lines.join('\n'),
    fileCount: counts.files,
    dirCount: counts.dirs,
    pruned: budget.count <= 0,
  };
  cache = { cwd, map: result };
  return result;
}

/** Synchronously return the last-built repo map text (empty if not built). */
export function getRepoMap(): string {
  return cache?.map.text ?? '';
}
