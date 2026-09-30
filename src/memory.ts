/**
 * Project memory for AstroCode.
 *
 * Loads persistent project/user instructions from memory files and exposes
 * them so the system prompt can carry project conventions, build commands,
 * and domain context — like CLAUDE.md, but for AstroCode.
 *
 * Lookup (all found files are concatenated, in order):
 *   1. Global : ~/.astrocode/ASTROCODE.md   (cross-project personal rules)
 *   2. Project: ./ASTROCODE.md | ./AGENTS.md | ./.astrocode/ASTROCODE.md
 *
 * The text is cached after first load; call reloadMemory(cwd) to refresh
 * (e.g. /memory reload).
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface MemorySource {
  label: string;
  path: string;
  exists: boolean;
}

interface MemoryCache {
  cwd: string;
  text: string;
  sources: MemorySource[];
}

let cache: MemoryCache | null = null;

function globalMemoryPath(): string {
  return path.join(os.homedir(), '.astrocode', 'ASTROCODE.md');
}

async function projectMemoryPath(cwd: string): Promise<string | null> {
  const candidates = [
    path.join(cwd, 'ASTROCODE.md'),
    path.join(cwd, 'AGENTS.md'),
    path.join(cwd, '.astrocode', 'ASTROCODE.md'),
  ];
  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

export async function loadMemory(cwd: string): Promise<{ text: string; sources: MemorySource[] }> {
  const sources: MemorySource[] = [];
  const parts: string[] = [];

  const gPath = globalMemoryPath();
  try {
    const txt = await fs.readFile(gPath, 'utf8');
    parts.push(`# Global memory (~/.astrocode/ASTROCODE.md)\n${txt.trim()}`);
    sources.push({ label: 'global', path: gPath, exists: true });
  } catch {
    sources.push({ label: 'global', path: gPath, exists: false });
  }

  const pPath = await projectMemoryPath(cwd);
  if (pPath) {
    try {
      const txt = await fs.readFile(pPath, 'utf8');
      parts.push(`# Project memory (${path.relative(cwd, pPath)})\n${txt.trim()}`);
      sources.push({ label: 'project', path: pPath, exists: true });
    } catch {
      sources.push({ label: 'project', path: pPath ?? '', exists: false });
    }
  } else {
    sources.push({ label: 'project', path: '', exists: false });
  }

  const text = parts.length > 0 ? parts.join('\n\n') : '';
  cache = { cwd, text, sources };
  return { text, sources };
}

/** Synchronously return the last-loaded memory text (empty if not loaded). */
export function getMemoryText(): string {
  return cache?.text ?? '';
}

/** Synchronously return the last-loaded memory sources. */
export function getMemorySources(): MemorySource[] {
  return cache?.sources ?? [];
}

export async function reloadMemory(cwd: string): Promise<{ text: string; sources: MemorySource[] }> {
  return loadMemory(cwd);
}
