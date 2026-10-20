/**
 * `@file` mentions for the prompt line.
 *
 * The prompt is a single string plus a caret, so everything here is pure text
 * arithmetic: which token the caret sits in, which files that token should
 * suggest, what the line becomes when a suggestion is accepted, and which
 * paths a submitted line meant. Keeping it free of React/Ink lets the rules be
 * tested without a terminal (same split as `modelPicker.ts` and `slash.ts`).
 *
 * Rules:
 * - A mention starts at an `@` that begins a token (start of line or after
 *   whitespace), so `you@example.com` never opens the picker.
 * - The token runs to the next whitespace, and the query is everything after
 *   the `@` — including text AFTER the caret, so a caret parked mid-path
 *   matches the whole path rather than only its left half.
 * - Accepting a suggestion replaces the whole token and leaves one trailing
 *   space, so the next word can be typed immediately.
 */

/** A mention token found around the caret. `end` is exclusive. */
export interface MentionToken {
  /** Index of the `@`. */
  start: number;
  /** Index just past the last character of the token. */
  end: number;
  /** Text after the `@` (may be empty: a bare `@` lists everything). */
  query: string;
}

const WHITESPACE = /\s/;

/**
 * The mention token containing (or ending at) `cursor`, or null when the
 * caret is not inside an `@…` token.
 *
 * The cursor may sit anywhere in the token: at the `@`, in the middle of the
 * path, or at the very end. Scanning to the token start (not to the nearest
 * `@` to the left) is what rejects `foo@bar` — the token there starts with
 * `f`, so there is no mention.
 */
export function mentionAt(value: string, cursor: number): MentionToken | null {
  const pos = Math.max(0, Math.min(cursor, value.length));
  let start = pos;
  while (start > 0 && !WHITESPACE.test(value[start - 1])) start--;
  if (value[start] !== '@') return null;
  // A token that merely CONTAINS an @ (an email, a decorator glued to a
  // word) is not a mention.
  if (start > 0 && !WHITESPACE.test(value[start - 1])) return null;
  let end = start + 1;
  while (end < value.length && !WHITESPACE.test(value[end])) end++;
  return { start, end, query: value.slice(start + 1, end) };
}

/**
 * Fuzzy score for `needle` as a subsequence of `hay`, or null when it does
 * not fit. Earlier first characters and tighter runs score higher.
 */
function subsequenceScore(hay: string, needle: string): number | null {
  if (!needle) return 0;
  let h = 0;
  let n = 0;
  let first = -1;
  let last = -1;
  let gaps = 0;
  while (h < hay.length && n < needle.length) {
    if (hay[h] === needle[n]) {
      if (first < 0) first = h;
      if (last >= 0) gaps += h - last - 1;
      last = h;
      n++;
    }
    h++;
  }
  if (n < needle.length) return null;
  return 300 - first * 3 - gaps * 4;
}

/**
 * Score one path against a query. Higher is better; negative means "no match".
 *
 * A basename hit always beats the same hit deep in a full path, so typing
 * `theme` offers `theme.ts` above `src/tui/markdown/theme-notes.ts`.
 */
export function scoreMentionPath(query: string, filePath: string): number {
  const q = query.toLowerCase().replace(/\\/g, '/');
  const full = filePath.toLowerCase().replace(/\\/g, '/');
  const base = full.slice(full.lastIndexOf('/') + 1);
  if (!q) {
    // Bare `@`: shallow, short, alphabetical-ish. All files are candidates.
    const depth = full.split('/').length;
    return 100 - depth * 5 - Math.min(40, full.length / 4);
  }
  if (full === q) return 1000;
  if (base === q) return 900;
  if (base.startsWith(q)) return 840 - Math.min(80, base.length - q.length);
  if (full.startsWith(q)) return 760 - Math.min(80, full.length - q.length) / 2;
  const inBase = base.indexOf(q);
  if (inBase >= 0) return 620 - inBase;
  const inFull = full.indexOf(q);
  if (inFull >= 0) return 540 - inFull / 2;
  const baseSub = subsequenceScore(base, q);
  if (baseSub !== null) return 420 + baseSub;
  const pathSub = subsequenceScore(full, q);
  if (pathSub !== null) return 260 + pathSub;
  return -1;
}

/** Default number of suggestions in the `@` picker. */
export const MENTION_SUGGESTIONS = 8;

/**
 * Rank the file index against a query and return the best `limit` paths.
 * Ties break toward the shorter path, then alphabetically, so the list never
 * shuffles between keystrokes that score identically.
 */
export function rankMentionFiles(
  query: string,
  files: readonly string[],
  limit: number = MENTION_SUGGESTIONS,
): string[] {
  const cap = Math.max(0, Math.min(50, Math.floor(limit)));
  if (cap === 0) return [];
  const scored: { path: string; score: number }[] = [];
  for (const file of files) {
    const score = scoreMentionPath(query, file);
    if (score >= 0) scored.push({ path: file, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path.localeCompare(b.path);
  });
  return scored.slice(0, cap).map((s) => s.path);
}

/**
 * Replace the mention token around the caret with `@file` plus a trailing
 * space (unless the line already has whitespace there). The caret lands after
 * the inserted space, ready for the next word.
 *
 * With no token under the caret (e.g. the picker was opened by a click or a
 * stale frame) it inserts at the caret rather than dropping the selection.
 */
export function applyMention(
  value: string,
  cursor: number,
  file: string,
): { value: string; cursor: number } {
  const token = mentionAt(value, cursor);
  const insertion = `@${file}`;
  if (!token) {
    const next = value.slice(0, cursor) + insertion + ' ' + value.slice(cursor);
    return { value: next, cursor: cursor + insertion.length + 1 };
  }
  const after = value.slice(token.end);
  const needsSpace = after.length === 0 || !WHITESPACE.test(after[0]);
  const next =
    value.slice(0, token.start) + insertion + (needsSpace ? ' ' : '') + after;
  return {
    value: next,
    cursor: token.start + insertion.length + (needsSpace ? 1 : 0),
  };
}

/** Trailing punctuation that is part of the sentence, not the path. */
const TRAILING_PUNCT = /[,.;:!?)\]}>"'`]+$/;

/**
 * Every file mentioned in a line, in order, deduplicated.
 *
 * Used at submit time to attach contents. Punctuation after a path
 * (`@src/a.ts,`) is dropped; a bare `@` with nothing after it is ignored.
 */
export function extractMentions(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(^|\s)@([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const path = m[2].replace(TRAILING_PUNCT, '');
    if (!path || path.includes('@')) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/** Marker that opens the attachment block appended to a submitted prompt. */
export const MENTION_BLOCK_OPEN = '<mentioned_files>';
const MENTION_BLOCK_CLOSE = '</mentioned_files>';

/**
 * Remove the attachment block from a stored user message so a reloaded
 * session shows the sentence the user typed, not thousands of lines of file
 * content. The model still receives the block in the live conversation.
 */
export function stripMentionBlock(text: string): string {
  const i = text.indexOf(MENTION_BLOCK_OPEN);
  return (i < 0 ? text : text.slice(0, i)).replace(/\s+$/, '');
}

/** Wrap attached file bodies in the delimiters the model reads. */
export function buildMentionBlock(
  entries: readonly { path: string; content: string; lines: number; truncated: boolean }[],
): string {
  if (entries.length === 0) return '';
  const parts: string[] = [MENTION_BLOCK_OPEN];
  for (const e of entries) {
    parts.push(
      `<file path="${e.path}" lines="${e.lines}"${e.truncated ? ' truncated="true"' : ''}>`,
      e.content,
      '</file>',
    );
  }
  parts.push(MENTION_BLOCK_CLOSE);
  return parts.join('\n');
}
