/**
 * Session persistence for AstroCode.
 *
 * Conversations can be saved to disk and resumed later — pick up exactly
 * where you left off, even across terminals or reboots. Sessions are stored
 * as JSON under ~/.astrocode/sessions/ keyed by a safe slugified name.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChatMessage } from './types.js';

export interface SessionMeta {
  name: string;
  cwd: string;
  model: string;
  mode: string;
  createdAt: string;
  updatedAt: string;
  messages: number;
}

export interface SessionData {
  name: string;
  cwd: string;
  model: string;
  mode: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export function sessionDir(): string {
  return process.env.ASTROCODE_SESSION_DIR ||
    path.join(os.homedir(), '.astrocode', 'sessions');
}

function sanitize(name: string): string {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, ''); // no leading/trailing dashes
  return clean || 'session';
}

function filePath(name: string): string {
  return path.join(sessionDir(), `${sanitize(name)}.json`);
}

async function readRawFile(file: string): Promise<SessionData | null> {
  try {
    const raw = await fs.readFile(path.join(sessionDir(), file), 'utf8');
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

export async function ensureSessionDir(): Promise<void> {
  await fs.mkdir(sessionDir(), { recursive: true });
}

export async function saveSession(name: string, data: Omit<SessionData, 'name' | 'updatedAt'>): Promise<SessionData> {
  await ensureSessionDir();
  const safe = sanitize(name);
  const existing = await loadSession(safe).catch(() => null);
  const now = new Date().toISOString();
  const session: SessionData = {
    ...data,
    name: safe,
    createdAt: data.createdAt ?? existing?.createdAt ?? now,
    updatedAt: now,
  };
  await fs.writeFile(filePath(safe), JSON.stringify(session, null, 2), 'utf8');
  return session;
}

export async function loadSession(name: string): Promise<SessionData | null> {
  // Try the sanitized file first, then the raw trimmed name — legacy sessions
  // saved before sanitize trimmed dashes may be filed under a trailing dash.
  const modern = await readRawFile(`${sanitize(name)}.json`);
  if (modern) return modern;
  return readRawFile(`${name.trim()}.json`);
}

export async function listSessions(): Promise<SessionMeta[]> {
  let files: string[];
  try {
    files = await fs.readdir(sessionDir());
  } catch {
    return [];
  }
  const metas: SessionMeta[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(sessionDir(), f), 'utf8');
      const s = JSON.parse(raw) as SessionData;
      metas.push({
        name: s.name,
        cwd: s.cwd,
        model: s.model,
        mode: s.mode,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messages: Array.isArray(s.messages) ? s.messages.length : 0,
      });
    } catch {
      /* skip corrupt session */
    }
  }
  metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return metas;
}

export async function deleteSession(name: string): Promise<boolean> {
  try {
    await fs.unlink(filePath(name));
    return true;
  } catch {
    return false;
  }
}
