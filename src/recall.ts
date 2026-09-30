/**
 * Dependency-free "recall" for AstroCode: BM25-lite retrieval over saved
 * sessions. Lets the agent (and user) ask questions grounded in its own
 * past work — "how did we fix the build cache last month?" — by searching
 * the JSON sessions that /save already persists.
 *
 * Zero dependencies: tokenization + a small BM25 variant with stopword-ish
 * length filtering, plus contextual snippets around the best match.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { sessionDir } from './sessions.js';

export interface RecallHit {
  name: string;
  updatedAt: string;
  score: number;
  snippet: string;
  messages: number;
}

/** Analysis cap: only the most recent N sessions are indexed per query. */
const MAX_SESSIONS = 60;
/** Long session bodies are truncated to keep retrieval fast. */
const MAX_CHARS_PER_SESSION = 200_000;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t) => t.length > 1);
}

/** Extract a readable snippet around the first query-token hit. */
function snippet(text: string, tokens: string[], width = 220): string {
  const lower = text.toLowerCase();
  let best = -1;
  for (const t of tokens) {
    const idx = lower.indexOf(t);
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  if (best < 0) return text.slice(0, width);
  const start = Math.max(0, best - 60);
  const out = text.slice(start, start + width).replace(/\s+/g, ' ');
  return (start > 0 ? '…' : '') + out + '…';
}

interface Doc {
  name: string;
  updatedAt: string;
  messages: number;
  tokens: string[];
  text: string;
}

export async function recallSessions(query: string, limit = 4): Promise<RecallHit[]> {
  const q = tokenize(query);
  if (q.length === 0) return [];

  const dir = sessionDir();
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  // Load the most recent sessions first, cap total.
  const docs: Doc[] = [];
  for (const f of files) {
    try {
      const raw = await fs.readFile(path.join(dir, f), 'utf8');
      const s = JSON.parse(raw);
      const text = (Array.isArray(s.messages) ? s.messages : [])
        .map((m: any) => (typeof m.content === 'string' ? m.content : ''))
        .join('\n')
        .slice(0, MAX_CHARS_PER_SESSION);
      if (!text) continue;
      docs.push({
        name: s.name ?? f.replace(/\.json$/, ''),
        updatedAt: s.updatedAt ?? s.createdAt ?? '',
        messages: Array.isArray(s.messages) ? s.messages.length : 0,
        tokens: tokenize(text),
        text,
      });
    } catch {
      /* skip corrupt session */
    }
  }
  docs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const pool = docs.slice(0, MAX_SESSIONS);
  if (pool.length === 0) return [];

  // BM25 statistics across the pool.
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const d of pool) {
    const seen = new Set<string>();
    for (const t of d.tokens) {
      totalLen++;
      if (!seen.has(t)) {
        seen.add(t);
        df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
  }
  const N = pool.length;
  const avgLen = totalLen / Math.max(1, N);
  const k1 = 1.2;
  const b = 0.75;

  const scored: RecallHit[] = [];
  for (const d of pool) {
    let score = 0;
    for (const qt of q) {
      const tf = d.tokens.filter((t) => t === qt).length;
      if (tf === 0) continue;
      const idf = Math.log(1 + (N - (df.get(qt) ?? 0) + 0.5) / ((df.get(qt) ?? 0) + 0.5));
      const len = Math.max(1, d.tokens.length);
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / avgLen)));
    }
    if (score > 0) {
      scored.push({
        name: d.name,
        updatedAt: d.updatedAt,
        score,
        snippet: snippet(d.text, q),
        messages: d.messages,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, limit));
}
