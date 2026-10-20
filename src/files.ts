/**
 * Workspace file index + mention attachments.
 *
 * The `@` picker needs a flat list of the files a user would actually want to
 * mention. `git ls-files --cached --others --exclude-standard` is the right
 * source when the workspace is a repo: it is one cheap call, it respects
 * .gitignore, and it includes untracked-but-real files. Outside a repo (or
 * with git missing) a bounded directory walk with the same skip list as the
 * repo map takes over, so the picker still works in a plain folder.
 *
 * Attachments are deliberately bounded here rather than in the prompt layer:
 * every mention that reaches the model costs context, so the caps live next to
 * the reader that enforces them. Nothing is silently dropped — a truncated
 * file is marked in the block the model sees.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { SKIP } from './repomap.js';
import { buildMentionBlock } from './tui/mention.js';

/** Upper bound on the indexed file list (keeps the picker instant). */
export const MAX_INDEX_FILES = 4000;
/** Max files attached from one prompt. */
export const MAX_ATTACH_FILES = 5;
/** Max characters of a single attached file. */
export const MAX_ATTACH_FILE_CHARS = 24_000;
/** Max characters of all attachments on one prompt. */
export const MAX_ATTACH_CHARS = 48_000;
const MAX_DEPTH = 8;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface FileIndex {
  files: string[];
  /** The workspace had more files than MAX_INDEX_FILES. */
  truncated: boolean;
}

/**
 * Parse `git ls-files` output into a sorted, bounded index. Pure so the
 * parsing stays testable without a repo.
 */
export function parseGitFileList(
  stdout: string,
  limit: number = MAX_INDEX_FILES,
): FileIndex {
  const all = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return {
    files: all.slice(0, Math.max(0, limit)).sort(),
    truncated: all.length > limit,
  };
}

function gitWorkspaceFiles(cwd: string): Promise<FileIndex> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd, timeout: 5_000, maxBuffer: 20 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        // A missing git, a non-repo directory, or a timeout all mean "fall
        // back to the walker" — the picker must not go blank for that.
        if (error) reject(error);
        else resolve(parseGitFileList(stdout));
      },
    );
  });
}

/** Breadth-first walk with the repo map's skip list; used outside git repos. */
async function walkWorkspaceFiles(root: string): Promise<FileIndex> {
  const out: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  let truncated = false;
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= MAX_INDEX_FILES) {
        truncated = true;
        break;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        if (depth + 1 > MAX_DEPTH) continue;
        queue.push({ dir: abs, depth: depth + 1 });
      } else if (entry.isFile()) {
        out.push(path.relative(root, abs).split(path.sep).join('/'));
      }
    }
    if (truncated) break;
  }
  return { files: out.sort(), truncated };
}

const indexCache = new Map<string, FileIndex>();

/**
 * The workspace's file list, cached per directory for the life of the process.
 * Files created after boot appear after a restart (or a `/cd`, which does not
 * exist yet) — acceptable for a completion list, and it keeps every keystroke
 * free of filesystem work.
 */
export async function listWorkspaceFiles(cwd: string): Promise<FileIndex> {
  const key = path.resolve(cwd);
  const hit = indexCache.get(key);
  if (hit) return hit;
  let index: FileIndex;
  try {
    index = await gitWorkspaceFiles(key);
  } catch {
    index = await walkWorkspaceFiles(key);
  }
  // A repo whose index is momentarily empty (fresh `git init`) still deserves
  // the walker rather than an empty picker.
  if (index.files.length === 0) {
    try {
      index = await walkWorkspaceFiles(key);
    } catch {
      /* keep the empty index */
    }
  }
  indexCache.set(key, index);
  return index;
}

/** Drop the cache (tests, or a future workspace switch). */
export function clearFileIndexCache(): void {
  indexCache.clear();
}

export interface MentionAttachment {
  path: string;
  content: string;
  lines: number;
  truncated: boolean;
}

export interface MentionAttachments {
  /** Delimited block ready to append to the user message ('' when none). */
  text: string;
  /** Paths that were actually read, in mention order. */
  paths: string[];
}

/**
 * Read the mentioned files into a bounded attachment block.
 *
 * Paths that escape the workspace, are not regular files, look binary, or
 * cannot be read are skipped rather than failing the turn — a mention is a
 * hint, not a command.
 */
export async function readMentionAttachments(
  mentions: readonly string[],
  cwd: string,
): Promise<MentionAttachments> {
  const root = path.resolve(cwd);
  const entries: MentionAttachment[] = [];
  const paths: string[] = [];
  let budget = MAX_ATTACH_CHARS;
  for (const mention of mentions) {
    if (entries.length >= MAX_ATTACH_FILES || budget <= 0) break;
    const abs = path.resolve(root, mention);
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      const raw = await fs.readFile(abs, 'utf8');
      if (raw.includes('\u0000')) continue; // binary
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const lines = raw.split('\n').length;
      const room = Math.min(MAX_ATTACH_FILE_CHARS, budget);
      const truncated = raw.length > room;
      const content = truncated
        ? `${raw.slice(0, room)}\n… [truncated ${raw.length - room} characters]`
        : raw;
      entries.push({ path: rel, content, lines, truncated });
      paths.push(rel);
      budget -= content.length;
    } catch {
      // Missing or unreadable: skip it, keep the rest of the attachments.
    }
  }
  if (entries.length === 0) return { text: '', paths: [] };
  return { text: buildMentionBlock(entries), paths };
}
