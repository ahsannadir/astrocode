/**
 * Terminal markdown renderer.
 *
 * Turns assistant text into the flat list of styled lines the MessageArea
 * paints. Everything here is pure and dependency-free (only `theme` plus the
 * highlighter), so it is unit-testable without a TTY.
 *
 * Supported: fenced code blocks (language label, framed gutter, syntax
 * highlighting, diff/patch coloring and a wrap indicator), headings (ATX and
 * setext), bullet/ordered/task lists with nesting and continuations,
 * blockquotes, horizontal rules, GitHub-style pipe tables with inline styling,
 * and inline spans — bold, italic, bold-italic, inline code, strikethrough,
 * links, images and autolinks, with backslash escapes.
 *
 * Two invariants make it pleasant at a terminal:
 *  - Layout is measured in display cells (`displayWidth`), not code units, so
 *    CJK text and emoji wrap where they should.
 *  - Inline spans are parsed *before* wrapping, so emphasis that crosses a line
 *    break keeps its styling instead of leaking raw `**` markers.
 *
 * `copy` carries the plain text a selection should paste: content lines copy
 * their visible text, chrome-only lines (code frames, table rules) copy ''.
 */

import { theme, themeRevision } from './theme.js';
import {
  detectLanguage,
  highlightCode,
  type Token,
  type TokenKind,
} from './syntax.js';

/** One styled span inside a line. */
export interface UISegment {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

export interface UILine {
  text: string;
  color?: string;
  dim?: boolean;
  inverse?: boolean;
  bold?: boolean;
  /** Styled spans to render instead of `text`. */
  segments?: UISegment[];
  /** Plain text to copy; '' for chrome-only lines. */
  copy?: string;
}

/* ------------------------------------------------------------------ *
 * Display width
 * ------------------------------------------------------------------ */

/** Cells a code point occupies: 0 for zero-width/combining, 2 for wide. */
function cpWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0; // control chars
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || cp === 0xfeff) {
    return 0;
  }
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining diacritics
  if (cp >= 0x1ab0 && cp <= 0x1aff) return 0;
  if (cp >= 0x1dc0 && cp <= 0x1dff) return 0;
  if (cp >= 0x20d0 && cp <= 0x20ff) return 0;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0; // variation selectors
  if (cp >= 0xfe20 && cp <= 0xfe2f) return 0;
  if (cp >= 0x1100 && cp <= 0x115f) return 2; // Hangul Jamo
  if (cp === 0x2329 || cp === 0x232a) return 2;
  if (cp >= 0x2e80 && cp <= 0xa4cf) return 2; // CJK radicals … Yi
  if (cp >= 0xa960 && cp <= 0xa97f) return 2;
  if (cp >= 0xac00 && cp <= 0xd7a3) return 2; // Hangul syllables
  if (cp >= 0xf900 && cp <= 0xfaff) return 2; // CJK compatibility
  if (cp >= 0xfe10 && cp <= 0xfe19) return 2;
  if (cp >= 0xfe30 && cp <= 0xfe6f) return 2;
  if (cp >= 0xff00 && cp <= 0xff60) return 2; // fullwidth forms
  if (cp >= 0xffe0 && cp <= 0xffe6) return 2;
  if (cp >= 0x1f000 && cp <= 0x1faff) return 2; // emoji, pictographs, flags
  if (cp >= 0x20000 && cp <= 0x3fffd) return 2; // CJK extensions
  return 1;
}

/** Visible cell width of a string (surrogate pairs count once). */
export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += cpWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/**
 * Longest prefix of `text` that fits in `max` cells. Always returns at least
 * one code point for non-empty input, so wrapping loops always make progress.
 */
export function sliceToWidth(text: string, max: number): string {
  let w = 0;
  let out = '';
  for (const ch of text) {
    const cw = cpWidth(ch.codePointAt(0) ?? 0);
    if (out !== '' && w + cw > max) break;
    out += ch;
    w += cw;
    if (w >= max) break;
  }
  return out;
}

/**
 * Wrap long text into lines of at most `width` cells (greedy).
 * Falls back to hard-cutting words longer than the width (e.g. URLs or
 * minified code) instead of letting them overflow the pane.
 */
export function wrapText(text: string, width: number): string[] {
  const W = Math.max(1, width);
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine === '') {
      out.push('');
      continue;
    }
    let line = rawLine;
    while (displayWidth(line) > W) {
      // Scan one cell past the limit so a break space sitting exactly on the
      // boundary can still be used.
      let acc = 0;
      let idx = 0;
      let spaceCut = -1;
      for (const ch of line) {
        if (acc > W) break;
        if (ch === ' ') spaceCut = idx;
        acc += cpWidth(ch.codePointAt(0) ?? 0);
        idx += ch.length;
      }
      const head = spaceCut > 0 ? line.slice(0, spaceCut) : sliceToWidth(line, W);
      out.push(head);
      line = line.slice(head.length).replace(/^ +/, '');
    }
    out.push(line);
  }
  return out;
}

/** Keep a single UI row within `width` cells (ellipsis for the overflow). */
export function fitLine(text: string, width: number): string {
  if (width <= 0 || displayWidth(text) <= width) return text;
  return width <= 1 ? '…' : sliceToWidth(text, width - 1) + '…';
}

/* ------------------------------------------------------------------ *
 * Inline spans
 * ------------------------------------------------------------------ */

interface Style {
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

function sameStyle(a: UISegment, b: UISegment): boolean {
  return (
    a.color === b.color &&
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strikethrough === !!b.strikethrough
  );
}

/** Copy a segment's style onto new text (merging adjacent same-style runs). */
function styled(text: string, from: UISegment): UISegment {
  const seg: UISegment = { text };
  if (from.color !== undefined) seg.color = from.color;
  if (from.bold) seg.bold = true;
  if (from.italic) seg.italic = true;
  if (from.underline) seg.underline = true;
  if (from.strikethrough) seg.strikethrough = true;
  return seg;
}

function pushStyled(out: UISegment[], text: string, st: Style): void {
  if (!text) return;
  const seg: UISegment = { text };
  if (st.color !== undefined) seg.color = st.color;
  if (st.bold) seg.bold = true;
  if (st.italic) seg.italic = true;
  if (st.underline) seg.underline = true;
  if (st.strikethrough) seg.strikethrough = true;
  const last = out[out.length - 1];
  if (last && sameStyle(last, seg)) last.text += text;
  else out.push(seg);
}

/** `extra` wins where it sets a property; existing styling is preserved. */
function mergeStyle(seg: UISegment, extra?: Partial<UISegment>): UISegment {
  if (!extra) return seg;
  const out: UISegment = { ...seg };
  if (extra.color !== undefined) out.color = extra.color;
  if (extra.bold) out.bold = true;
  if (extra.italic) out.italic = true;
  if (extra.underline) out.underline = true;
  if (extra.strikethrough) out.strikethrough = true;
  return out;
}

const URL_RE = /^(?:https?:\/\/|mailto:)[^\s<>()]+/;
const ESCAPABLE_RE = /[\\`*_{}[\]()#+\-.!~>|]/;

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9_]/.test(ch);
}

function runLength(text: string, at: number, ch: string): number {
  let n = 0;
  while (text[at + n] === ch) n++;
  return n;
}

/** First delimiter run of `delim` with at least `minLen` chars, closing-valid. */
function findCloser(text: string, from: number, delim: string, minLen: number): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === delim) {
      const len = runLength(text, i, delim);
      const before = text[i - 1];
      if (len >= minLen && before !== undefined && !/\s/.test(before)) return i;
      i += len;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * `*`/`_` emphasis. Longest runs win (3 = bold+italic, 2 = bold, 1 = italic)
 * and the closer must be at least as long as the opener, which is what makes
 * nesting like `**bold *nested* bold**` behave.
 * Returns the index to resume scanning from, or -1 when not emphasis.
 */
function tryEmphasis(
  text: string,
  at: number,
  st: Style,
  out: UISegment[],
  flush: () => void,
): number {
  const delim = text[at];
  const run = Math.min(3, runLength(text, at, delim));
  const after = text[at + run];
  if (after === undefined || /\s/.test(after)) return -1; // cannot open
  if (delim === '_' && isWordChar(text[at - 1])) return -1; // intraword `_`
  let from = at + run;
  let close = -1;
  while (true) {
    const cand = findCloser(text, from, delim, run);
    if (cand === -1) break;
    if (delim === '_' && isWordChar(text[cand + run])) {
      from = cand + run;
      continue;
    }
    close = cand;
    break;
  }
  if (close === -1) return -1;
  const inner = text.slice(at + run, close);
  if (!inner || /\n/.test(inner)) return -1;

  flush();
  const innerStyle: Style = { ...st };
  if (run >= 2) innerStyle.bold = true;
  if (run === 1 || run === 3) innerStyle.italic = true;
  parseInline(inner, innerStyle, out);
  return close + run;
}

interface LinkMatch {
  label: string;
  url: string;
  end: number;
}

/** `[label](url)` starting at `at` (the `[`). */
function matchLink(text: string, at: number): LinkMatch | null {
  const close = text.indexOf(']', at + 1);
  if (close === -1 || text[close + 1] !== '(') return null;
  const end = text.indexOf(')', close + 2);
  if (end === -1) return null;
  const label = text.slice(at + 1, close);
  const target = text.slice(close + 2, end).trim();
  const gap = target.search(/\s/);
  const url = gap === -1 ? target : target.slice(0, gap); // drop `"title"`
  if (!label || !url) return null;
  return { label, url, end: end + 1 };
}

/**
 * Recursive inline parser. Unknown markers pass through untouched so plain
 * text degrades gracefully.
 */
function parseInline(text: string, st: Style, out: UISegment[]): void {
  let buf = '';
  const flush = () => {
    if (buf) {
      pushStyled(out, buf, st);
      buf = '';
    }
  };
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    // Backslash escape: `\*` renders a literal `*`.
    if (ch === '\\' && i + 1 < text.length && ESCAPABLE_RE.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    // Code span, any backtick run (``a `b` ``).
    if (ch === '`') {
      const run = runLength(text, i, '`');
      const end = text.indexOf('`'.repeat(run), i + run);
      if (end !== -1) {
        let code = text.slice(i + run, end);
        if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) {
          code = code.slice(1, -1);
        }
        flush();
        pushStyled(out, code, { color: theme.code });
        i = end + run;
        continue;
      }
      buf += '`'.repeat(run);
      i += run;
      continue;
    }

    // Image: ![alt](url) → 🖼 alt (url)
    if (ch === '!' && text[i + 1] === '[') {
      const img = matchLink(text, i + 1);
      if (img) {
        flush();
        pushStyled(out, '🖼 ', { color: theme.muted });
        parseInline(img.label, { color: theme.code }, out);
        if (img.url !== img.label) pushStyled(out, ` (${img.url})`, { color: theme.muted });
        i = img.end;
        continue;
      }
    }

    // Link: [label](url)
    if (ch === '[') {
      const link = matchLink(text, i);
      if (link) {
        flush();
        parseInline(link.label, { color: theme.status, underline: true }, out);
        if (link.url !== link.label) pushStyled(out, ` (${link.url})`, { color: theme.muted });
        i = link.end;
        continue;
      }
    }

    // Angle autolink: <https://x>
    if (ch === '<') {
      const end = text.indexOf('>', i + 1);
      const inside = end === -1 ? '' : text.slice(i + 1, end);
      if (end !== -1 && /^(?:https?:\/\/|mailto:)\S+$/.test(inside)) {
        flush();
        pushStyled(out, inside, { color: theme.status, underline: true });
        i = end + 1;
        continue;
      }
    }

    if (ch === '*' || ch === '_') {
      const next = tryEmphasis(text, i, st, out, flush);
      if (next !== -1) {
        i = next;
        continue;
      }
    }

    if (ch === '~' && text[i + 1] === '~') {
      const end = text.indexOf('~~', i + 2);
      const inner = end === -1 ? '' : text.slice(i + 2, end);
      if (end !== -1 && inner && !/\s/.test(inner[0])) {
        flush();
        parseInline(inner, { ...st, strikethrough: true }, out);
        i = end + 2;
        continue;
      }
    }

    // Bare autolink, but not the tail of a word/email/url.
    if (ch === 'h' && !isWordChar(text[i - 1]) && text[i - 1] !== '/' && text[i - 1] !== '@') {
      const url = URL_RE.exec(text.slice(i));
      if (url) {
        const visible = url[0].replace(/[.,;:!?]+$/, '');
        flush();
        pushStyled(out, visible, { color: theme.status, underline: true });
        i += visible.length;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
}

/** Parse inline markdown from one line into styled segments. */
export function inlineSegments(line: string, base?: string): UISegment[] {
  const out: UISegment[] = [];
  parseInline(line, { color: base }, out);
  return out.length > 0 ? out : [{ text: line, color: base }];
}

/** Visible text of a cell once inline markers are stripped. */
function plainInline(text: string): string {
  return inlineSegments(text, undefined)
    .map((s) => s.text)
    .join('');
}

/* ------------------------------------------------------------------ *
 * Styled wrapping
 * ------------------------------------------------------------------ */

/**
 * Greedy-wrap styled segments to `width` cells, breaking on spaces and
 * hard-cutting overlong words. Styles survive the break, so a bold span split
 * across two rows stays bold on both.
 */
export function wrapSegments(segs: UISegment[], width: number): UISegment[][] {
  const W = Math.max(1, width);
  const rows: UISegment[][] = [];
  let cur: UISegment[] = [];
  let curW = 0;
  let pendingSpace = false;

  const lineBreak = () => {
    rows.push(cur);
    cur = [];
    curW = 0;
    pendingSpace = false;
  };

  const append = (from: UISegment, text: string) => {
    const seg = styled(text, from);
    const last = cur[cur.length - 1];
    if (last && sameStyle(last, seg)) last.text += text;
    else cur.push(seg);
    curW += displayWidth(text);
  };

  for (const seg of segs) {
    for (const part of seg.text.split(/(\s+)/)) {
      if (part === '') continue;
      if (/^\s+$/.test(part)) {
        if (curW > 0) pendingSpace = true;
        continue;
      }
      if (pendingSpace) {
        if (curW + 1 <= W) append(seg, ' ');
        pendingSpace = false;
      }
      let rest = part;
      while (rest !== '') {
        const restW = displayWidth(rest);
        const room = W - curW;
        // A word that fits on a fresh row moves there intact; only words
        // wider than the pane are hard-cut (URLs, minified code).
        if (curW > 0 && restW > room && restW <= W) {
          lineBreak();
          continue;
        }
        const take = curW > 0 ? sliceToWidth(rest, room) : sliceToWidth(rest, W);
        append(seg, take);
        rest = rest.slice(take.length);
        if (rest !== '') lineBreak();
      }
    }
  }
  if (cur.length > 0) rows.push(cur);
  if (rows.length === 0) rows.push([]);
  return rows;
}

/* ------------------------------------------------------------------ *
 * Code blocks
 * ------------------------------------------------------------------ */

/** Map a token kind to its themed color. */
export function tokenColor(kind: TokenKind): string {
  switch (kind) {
    case 'keyword':
      return theme.synKeyword;
    case 'string':
      return theme.synString;
    case 'number':
      return theme.synNumber;
    case 'comment':
      return theme.synComment;
    case 'function':
      return theme.synFunction;
    case 'type':
      return theme.synType;
    case 'punct':
      return theme.synPunct;
    case 'add':
      return theme.synAdd;
    case 'del':
      return theme.synDel;
    default:
      return theme.assistant;
  }
}

/** Split a token run into width-bounded rows, hard-wrapping where needed. */
function wrapTokens(tokens: Token[], width: number): Token[][] {
  const W = Math.max(1, width);
  const rows: Token[][] = [];
  let cur: Token[] = [];
  let len = 0;
  const flush = () => {
    rows.push(cur);
    cur = [];
    len = 0;
  };
  for (const t of tokens) {
    let text = t.text;
    while (text.length > 0) {
      const room = W - len;
      if (room <= 0) {
        flush();
        continue;
      }
      const take = sliceToWidth(text, room);
      cur.push({ text: take, kind: t.kind });
      len += displayWidth(take);
      text = text.slice(take.length);
      if (text.length > 0) flush();
    }
  }
  if (cur.length > 0) flush();
  if (rows.length === 0) rows.push([]);
  return rows;
}

const CODE_GUTTER = '  │ ';
const CODE_WRAP_GUTTER = '  ↪ ';

function renderCodeBlock(
  body: string[],
  info: string,
  width: number,
  out: UILine[],
  closed: boolean,
): void {
  const lang = detectLanguage(info);
  const label = info.trim();
  const frameWidth = Math.max(3, Math.min(width, 100));
  const head = `  ╭─${label ? ` ${label} ` : ' '}`;
  out.push({
    text: head + '─'.repeat(Math.max(0, frameWidth - displayWidth(head))),
    copy: '',
    segments: [
      { text: '  ╭─', color: theme.codeBorder },
      ...(label ? [{ text: ` ${label} `, color: theme.synFunction }] : []),
      { text: '─'.repeat(Math.max(0, frameWidth - displayWidth(head))), color: theme.codeBorder },
    ],
  });

  const codeWidth = Math.max(8, width - CODE_GUTTER.length);
  const source = body.join('\n');
  const highlighted = highlightCode(source, lang);
  highlighted.forEach((tokens, i) => {
    const rows = wrapTokens(tokens, codeWidth);
    rows.forEach((row, r) => {
      const gutter = r === 0 ? CODE_GUTTER : CODE_WRAP_GUTTER;
      const segs: UISegment[] = [{ text: gutter, color: theme.codeBorder }];
      for (const t of row) segs.push({ text: t.text, color: tokenColor(t.kind) });
      const visible = row.map((t) => t.text).join('');
      out.push({
        text: gutter + visible,
        // Copy the row a selection sees: no gutter, no duplicated source line.
        copy: visible,
        segments: segs,
      });
    });
  });

  if (closed) {
    out.push({
      text: `  ╰${'─'.repeat(Math.max(0, frameWidth - 3))}`,
      copy: '',
      segments: [
        { text: `  ╰${'─'.repeat(Math.max(0, frameWidth - 3))}`, color: theme.codeBorder },
      ],
    });
  }
  out.push({ text: '' });
}

/* ------------------------------------------------------------------ *
 * Tables
 * ------------------------------------------------------------------ */

const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function isSeparatorRow(line: string): boolean {
  return line.includes('-') && TABLE_SEP.test(line);
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

type Align = 'left' | 'center' | 'right';

function alignOf(sep: string): Align {
  const s = sep.trim();
  const left = s.startsWith(':');
  const right = s.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

/**
 * Render a pipe table starting at `start`, returning the index of the first
 * line after it. Falls back to nothing (returns -1) when the table is malformed
 * or too wide to lay out.
 */
function renderTable(
  raw: string[],
  start: number,
  width: number,
  out: UILine[],
): number {
  const header = splitRow(raw[start]);
  const sep = splitRow(raw[start + 1]);
  if (header.length === 0 || header.length !== sep.length) return -1;
  const aligns = sep.map(alignOf);

  let end = start + 2;
  const rows: string[][] = [];
  while (end < raw.length && raw[end].includes('|') && raw[end].trim() !== '') {
    rows.push(splitRow(raw[end]));
    end++;
  }

  const cols = header.length;
  const cells: string[][] = [header, ...rows];
  const widths: number[] = new Array(cols).fill(3);
  for (const row of cells) {
    for (let c = 0; c < cols; c++) {
      widths[c] = Math.max(widths[c], displayWidth(plainInline(row[c] ?? '')));
    }
  }
  const total = widths.reduce((a, b) => a + b, 0) + 3 * (cols - 1);
  if (total > width) return -1; // too wide — caller renders plain lines

  const emitRow = (row: string[], bold: boolean): void => {
    const segs: UISegment[] = [];
    let text = '';
    for (let c = 0; c < cols; c++) {
      if (c > 0) {
        segs.push({ text: ' │ ', color: theme.codeBorder });
        text += ' │ ';
      }
      const cell = inlineSegments(row[c] ?? '', theme.assistant).map((s) =>
        bold ? mergeStyle(s, { bold: true }) : s,
      );
      const cellW = cell.reduce((n, s) => n + displayWidth(s.text), 0);
      const gap = Math.max(0, widths[c] - cellW);
      const before = aligns[c] === 'right' ? gap : aligns[c] === 'center' ? Math.floor(gap / 2) : 0;
      const after = gap - before;
      if (before > 0) {
        segs.push({ text: ' '.repeat(before), color: theme.assistant, bold });
        text += ' '.repeat(before);
      }
      for (const s of cell) {
        segs.push(s);
        text += s.text;
      }
      if (after > 0) {
        segs.push({ text: ' '.repeat(after), color: theme.assistant, bold });
        text += ' '.repeat(after);
      }
    }
    out.push({ text, copy: text, segments: segs });
  };

  emitRow(header, true);
  const rule = widths.map((w) => '─'.repeat(w)).join('─┼─');
  out.push({
    text: rule,
    copy: '',
    segments: [{ text: rule, color: theme.codeBorder }],
  });
  for (const row of rows) emitRow(row, false);
  out.push({ text: '' });
  return end;
}

/* ------------------------------------------------------------------ *
 * Main renderer
 * ------------------------------------------------------------------ */

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET_RE = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE_RE = /^(\s*)>\s?(.*)$/;
const QUOTE_LEAD_RE = /^\s*(?:>\s*)+/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;

const BULLETS = ['•', '◦', '▪', '‣', '·'];

/**
 * Emit wrapped content under a marker prefix, hanging-indented. Used by list
 * items and blockquotes so continuation rows line up under the text.
 */
function emitWrapped(
  prefix: string,
  content: string,
  width: number,
  contentColor: string,
  prefixColor: string,
  out: UILine[],
  contentStyle?: Partial<UISegment>,
): void {
  const avail = Math.max(4, width - displayWidth(prefix));
  const hang = ' '.repeat(displayWidth(prefix));
  const inner = inlineSegments(content, contentColor).map((s) => mergeStyle(s, contentStyle));
  wrapSegments(inner, avail).forEach((row, idx) => {
    const lead = idx === 0 ? prefix : hang;
    const segs: UISegment[] = [{ text: lead, color: prefixColor }, ...row];
    const text = lead + row.map((s) => s.text).join('');
    out.push({ text, copy: text, segments: segs });
  });
}

function renderHeading(text: string, level: number, width: number, out: UILine[]): void {
  const color = level >= 4 ? theme.muted : theme.heading;
  const bold = level <= 2;
  const underline = level === 1;
  const inner = inlineSegments(text, color).map((s) => mergeStyle(s, { bold, underline }));
  for (const row of wrapSegments(inner, width)) {
    const visible = row.map((s) => s.text).join('');
    out.push({ text: visible, color, bold, copy: visible, segments: row });
  }
  out.push({ text: '' });
}

function renderList(
  raw: string[],
  start: number,
  width: number,
  out: UILine[],
): number {
  let i = start;
  while (i < raw.length) {
    const line = raw[i];
    if (line.trim() === '') break;
    const ordered = ORDERED_RE.exec(line);
    const bullet = BULLET_RE.exec(line);
    if (!ordered && !bullet) break;
    const indentRaw = (ordered ? ordered[1] : bullet![1]).replace(/\t/g, '  ');
    const depth = Math.min(5, Math.floor(indentRaw.length / 2));
    let content = ordered ? ordered[3] : bullet![3];
    let marker: string;
    if (ordered) {
      marker = `${ordered[2]}. `;
    } else {
      const task = TASK_RE.exec(content);
      if (task) {
        marker = task[1].toLowerCase() === 'x' ? '☑ ' : '☐ ';
        content = task[2];
      } else {
        marker = `${BULLETS[Math.min(depth, BULLETS.length - 1)]} `;
      }
    }

    // Continuation lines (indented past the marker, not a new item) join the
    // item's text instead of escaping as an unindented paragraph.
    let j = i + 1;
    while (j < raw.length) {
      const next = raw[j];
      if (next.trim() === '') break;
      if (BULLET_RE.test(next) || ORDERED_RE.test(next)) break;
      const lead = /^[ \t]*/.exec(next)![0].replace(/\t/g, '  ');
      if (lead.length < indentRaw.length + 2) break;
      content += ` ${next.trim()}`;
      j++;
    }

    emitWrapped('  '.repeat(depth) + marker, content, width, theme.assistant, theme.bullet, out);
    i = j;
  }
  out.push({ text: '' });
  return i;
}

/**
 * Render assistant markdown to UI lines. Memoized by width + source + theme
 * revision so a long transcript isn't re-parsed on every animation frame.
 */
export function richLines(text: string, width: number): UILine[] {
  const key = `${themeRevision}\u0000${width}\u0000${text}`;
  const hit = MD_CACHE.get(key);
  if (hit) return hit;

  const lines = renderMarkdown(text, width);

  if (MD_CACHE.size >= MD_CACHE_LIMIT) {
    const oldest = MD_CACHE.keys().next().value;
    if (oldest !== undefined) MD_CACHE.delete(oldest);
  }
  MD_CACHE.set(key, lines);
  return lines;
}

const MD_CACHE = new Map<string, UILine[]>();
const MD_CACHE_LIMIT = 120;

function renderMarkdown(text: string, width: number): UILine[] {
  const out: UILine[] = [];
  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;

  while (i < raw.length) {
    const line = raw[i];

    // Fenced code block.
    const fence = /^\s*(`{3,}|~{3,})\s*(.*)$/.exec(line);
    if (fence) {
      const ch = fence[1][0];
      const esc = ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const closeRe = new RegExp(`^\\s*${esc}{3,}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < raw.length && !closeRe.test(raw[i])) {
        body.push(raw[i]);
        i++;
      }
      const closed = i < raw.length;
      if (closed) i++; // consume the closing fence
      renderCodeBlock(body, fence[2] ?? '', width, out, closed);
      continue;
    }

    // Pipe table.
    if (
      line.includes('|') &&
      i + 1 < raw.length &&
      isSeparatorRow(raw[i + 1]) &&
      !isSeparatorRow(line)
    ) {
      const next = renderTable(raw, i, width, out);
      if (next > i) {
        i = next;
        continue;
      }
    }

    if (HR_RE.test(line)) {
      out.push({
        text: '─'.repeat(Math.max(1, Math.min(width, 60))),
        color: theme.codeBorder,
        copy: '',
      });
      out.push({ text: '' });
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      renderHeading(heading[2], heading[1].length, width, out);
      i++;
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      const lead = QUOTE_LEAD_RE.exec(line)?.[0] ?? '>';
      const depth = Math.min(4, Math.max(1, (lead.match(/>/g) ?? []).length));
      const prefix = '▍ '.repeat(depth);
      emitWrapped(prefix, line.slice(lead.length), width, theme.muted, theme.codeBorder, out, {
        italic: true,
      });
      i++;
      continue;
    }

    if (BULLET_RE.test(line) || ORDERED_RE.test(line)) {
      i = renderList(raw, i, width, out);
      continue;
    }

    if (line.trim() === '') {
      // Collapse runs of blank lines into a single separator.
      if (out.length > 0 && out[out.length - 1].text !== '') out.push({ text: '' });
      i++;
      continue;
    }

    // Setext heading: paragraph text underlined with `===` or `---`.
    if (i + 1 < raw.length) {
      const underline = /^\s*(=+|-+)\s*$/.exec(raw[i + 1]);
      if (underline) {
        renderHeading(line.trim(), underline[1][0] === '=' ? 1 : 2, width, out);
        i += 2;
        continue;
      }
    }

    // Paragraph: parse inline spans first, then wrap so styling survives.
    const inner = inlineSegments(line, theme.assistant);
    for (const row of wrapSegments(inner, width)) {
      const visible = row.map((s) => s.text).join('');
      out.push({ text: visible, color: theme.assistant, copy: visible, segments: row });
    }
    i++;
  }

  return out;
}

/** Test hook: drop the markdown memo table. */
export function clearMarkdownCache(): void {
  MD_CACHE.clear();
}
