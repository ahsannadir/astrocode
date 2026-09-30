/**
 * Fuzzy, context-tolerant patch application for AstroCode.
 *
 * Unlike `edit_file` / `multi_edit` — which require exact string matches and
 * fail when the file drifted since the model read it — `apply_patch` matches
 * each hunk by *line similarity*: it finds the best-anchored location,
 * tolerates whitespace and small text drift, applies ALL hunks in memory
 * first, and only writes to disk if every hunk matched (transactional, so a
 * partial edit can never land).
 */
export interface PatchHunk {
  search: string;
  replace: string;
  replace_all?: boolean;
}

export interface UnmatchedHunk {
  search: string;
  reason: string;
}

export interface PatchOutcome {
  content: string;
  applied: number;
  unmatched: UnmatchedHunk[];
}

/** Plain Levenshtein edit distance between two strings. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  for (let i = 0; i <= b.length; i++) prev[i] = i;
  for (let i = 1; i <= a.length; i++) {
    const curr = new Array(b.length + 1);
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

/** Normalize a line for tolerant matching: trim + collapse whitespace runs. */
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 0..1 similarity between two lines (1 = identical after normalization). */
export function lineSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.length === 0 || nb.length === 0) return 0;
  // Substring containment is a strong signal for searches of meaningful
  // length (e.g. "greet" matching "function greet(name: string) {"). Tiny
  // fragments fall through to the Levenshtein path to avoid false matches.
  if (nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return 0.95;
  // Fast reject: wildly different lengths can't be close.
  const maxLen = Math.max(na.length, nb.length);
  if (Math.abs(na.length - nb.length) / maxLen > 0.6) return 0;
  // Cap line length so Levenshtein stays cheap on very long lines.
  const ca = na.length > 200 ? na.slice(0, 200) : na;
  const cb = nb.length > 200 ? nb.slice(0, 200) : nb;
  return 1 - levenshtein(ca, cb) / Math.max(ca.length, cb.length);
}

const BLOCK_THRESHOLD = 0.85;
const MAX_REPLACE_ALL = 1000;

/** Best offset + average line score for `searchLines` within `fileLines`. */
function findBestMatch(
  fileLines: string[],
  searchLines: string[],
): { offset: number; score: number } | null {
  const m = searchLines.length;
  const n = fileLines.length;
  if (m === 0 || n < m) return null;
  let best: { offset: number; score: number } | null = null;
  for (let i = 0; i + m <= n; i++) {
    let total = 0;
    for (let j = 0; j < m; j++) {
      total += lineSimilarity(fileLines[i + j], searchLines[j]);
    }
    const score = total / m;
    if (score >= BLOCK_THRESHOLD && (!best || score > best.score)) {
      best = { offset: i, score };
      if (score > 0.999) break; // perfect match — can't do better
    }
  }
  return best;
}

/** Replace `lineCount` lines at `offset` with `replace`, preserving the file's trailing newline. */
function applyAt(
  content: string,
  offset: number,
  lineCount: number,
  replace: string,
): string {
  const hadEnd = content.endsWith('\n');
  let lines = content.split('\n');
  if (hadEnd && lines[lines.length - 1] === '') lines.pop();
  const head = lines.slice(0, offset);
  const tail = lines.slice(offset + lineCount);
  const replaced = replace.split('\n');
  if (replace.endsWith('\n') && replaced[replaced.length - 1] === '') replaced.pop();
  return [...head, ...replaced, ...tail].join('\n') + (hadEnd ? '\n' : '');
}

function leadingIndent(line: string): string {
  const m = line.match(/^[ \t]*/);
  return m ? m[0] : '';
}

/**
 * Apply all hunks to `content` in memory. Returns the new content plus a
 * report. Nothing is written by this function — the caller decides.
 *
 * Semantics:
 * - Single-line hunks: exact substring replacement first (like edit_file);
 *   if the raw search drifted (e.g. indentation), fall back to a fuzzy
 *   whole-line replacement that preserves the line's leading indent.
 * - Multi-line hunks: fuzzy block matching, whole block replaced.
 * - `replace_all` applies to every (fuzzy) match, capped defensively.
 */
export function applyPatch(content: string, hunks: PatchHunk[]): PatchOutcome {
  let working = content;
  let applied = 0;
  const unmatched: UnmatchedHunk[] = [];
  for (const hunk of hunks) {
    const search = hunk.search ?? '';
    const replace = hunk.replace ?? '';
    if (!search.trim()) {
      unmatched.push({ search, reason: 'empty search' });
      continue;
    }
    const searchLines = search.split('\n');
    const singleLine = searchLines.length === 1;

    // Single-line, non-replace_all: exact substring first, fuzzy line fallback.
    if (singleLine && !hunk.replace_all) {
      const idx = working.indexOf(search);
      if (idx >= 0) {
        working = working.slice(0, idx) + replace + working.slice(idx + search.length);
        applied++;
        continue;
      }
      const m = findBestMatch(working.split('\n'), searchLines);
      if (!m) {
        unmatched.push({ search, reason: 'no fuzzy match found' });
        continue;
      }
      const lines = working.split('\n');
      lines[m.offset] = leadingIndent(lines[m.offset]) + replace.trimStart();
      working = lines.join('\n');
      applied++;
      continue;
    }

    // Exact replace_all fast path for single-line hunks.
    if (singleLine && hunk.replace_all && working.includes(search)) {
      const parts = working.split(search);
      working = parts.join(replace);
      applied += parts.length - 1;
      continue;
    }

    // Multi-line hunk or fuzzy replace_all: repeated block matching.
    let count = 0;
    let guard = 0;
    while (guard++ < MAX_REPLACE_ALL) {
      const m = findBestMatch(working.split('\n'), searchLines);
      if (!m) break;
      working = applyAt(working, m.offset, searchLines.length, replace);
      count++;
      if (!hunk.replace_all) break;
    }
    if (count > 0) applied += count;
    else unmatched.push({ search, reason: 'no fuzzy match found' });
  }
  return { content: working, applied, unmatched };
}


