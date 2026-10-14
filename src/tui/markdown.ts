/**
 * Terminal markdown renderer.
 *
 * Turns assistant text into the flat list of styled lines the MessageArea
 * paints. Everything here is pure and dependency-free (only `theme`), so it is
 * unit-testable without a TTY.
 *
 * Supported: fenced code blocks (with language label, gutter and syntax
 * highlighting), headings, bullet/ordered/task lists with nesting, blockquotes,
 * horizontal rules, GitHub-style pipe tables, and inline spans — bold, italic,
 * inline code, strikethrough, links and autolinks.
 *
 * `copy` carries the plain text a selection should paste: content lines copy
 * their visible text, chrome-only lines (code gutters, table rules) copy ''.
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
 * Width helpers
 * ------------------------------------------------------------------ */

/**
 * Wrap long text into lines of at most `width` characters (greedy).
 * Falls back to hard-cutting words longer than the width (e.g. URLs or
 * minified code) instead of letting them overflow the pane.
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 1) return [text];
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine === '') {
      out.push('');
      continue;
    }
    let line = rawLine;
    while (line.length > width) {
      let cut = line.lastIndexOf(' ', width);
      if (cut <= 0) cut = width; // hard-cut overlong unbroken tokens
      out.push(line.slice(0, cut));
      line = line.slice(cut).replace(/^ /, '');
    }
    out.push(line);
  }
  return out;
}

/** Keep a single UI row within `width` cells (ellipsis for the overflow). */
export function fitLine(text: string, width: number): string {
  if (width <= 0 || text.length <= width) return text;
  return width <= 1 ? '…' : text.slice(0, width - 1) + '…';
}

/** Sum of the visible characters across a segment run. */
function segLength(segs: UISegment[]): number {
  let n = 0;
  for (const s of segs) n += s.text.length;
  return n;
}

/* ------------------------------------------------------------------ *
 * Inline spans
 * ------------------------------------------------------------------ */

const INLINE_RE = new RegExp(
  [
    '(`[^`]+`)',
    '(\\*\\*[^*]+\\*\\*)',
    '(?<![\\w])(__[^_]+__)(?![\\w])',
    '(~~[^~]+~~)',
    '(\\*[^*\\n]+\\*)',
    '(?<![\\w])(_[^_\\n]+_)(?![\\w])',
    '(\\[[^\\]]+\\]\\([^)\\s]+\\))',
    '(https?://[^\\s)]+)',
  ].join('|'),
  'g',
);

/**
 * Parse inline markdown from one already-wrapped line into styled segments.
 * Unknown markers pass through untouched so plain text degrades gracefully.
 */
export function inlineSegments(line: string, base?: string): UISegment[] {
  const segs: UISegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(line)) !== null) {
    if (m.index > last) segs.push({ text: line.slice(last, m.index), color: base });
    const tok = m[0];
    if (tok.startsWith('`')) {
      segs.push({ text: tok.slice(1, -1), color: theme.code });
    } else if (tok.startsWith('**')) {
      segs.push({ text: tok.slice(2, -2), color: base, bold: true });
    } else if (tok.startsWith('__')) {
      segs.push({ text: tok.slice(2, -2), color: base, bold: true });
    } else if (tok.startsWith('~~')) {
      segs.push({ text: tok.slice(2, -2), color: base, strikethrough: true });
    } else if (tok.startsWith('*')) {
      segs.push({ text: tok.slice(1, -1), color: base, italic: true });
    } else if (tok.startsWith('_')) {
      segs.push({ text: tok.slice(1, -1), color: base, italic: true });
    } else if (tok.startsWith('[')) {
      const label = tok.slice(1, tok.indexOf(']'));
      const url = tok.slice(tok.indexOf('](') + 2, -1);
      segs.push({ text: label, color: theme.status, underline: true });
      if (url !== label) segs.push({ text: ` (${url})`, color: theme.muted });
    } else {
      segs.push({ text: tok, color: theme.status, underline: true });
    }
    last = m.index + tok.length;
  }
  if (last < line.length) segs.push({ text: line.slice(last), color: base });
  return segs.length > 0 ? segs : [{ text: line, color: base }];
}

/** Visible text of a cell once inline markers are stripped. */
function plainInline(text: string): string {
  return inlineSegments(text, undefined)
    .map((s) => s.text)
    .join('');
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
    default:
      return theme.assistant;
  }
}

/** Split a token run into width-bounded rows, hard-wrapping where needed. */
function wrapTokens(tokens: Token[], width: number): Token[][] {
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
      const room = width - len;
      if (room <= 0) {
        flush();
        continue;
      }
      if (text.length <= room) {
        cur.push({ text, kind: t.kind });
        len += text.length;
        text = '';
      } else {
        cur.push({ text: text.slice(0, room), kind: t.kind });
        text = text.slice(room);
        flush();
      }
    }
  }
  if (cur.length > 0) flush();
  if (rows.length === 0) rows.push([]);
  return rows;
}

const CODE_GUTTER = '  │ ';

function renderCodeBlock(
  body: string[],
  info: string,
  width: number,
  out: UILine[],
  closed: boolean,
): void {
  const lang = detectLanguage(info);
  const label = info.trim();
  out.push({
    text: `  ╭─${label ? ` ${label}` : ''}`,
    copy: '',
    segments: [
      { text: '  ╭─', color: theme.codeBorder },
      ...(label ? [{ text: ` ${label}`, color: theme.synFunction }] : []),
    ],
  });

  const codeWidth = Math.max(8, width - CODE_GUTTER.length);
  const source = body.join('\n');
  const highlighted = highlightCode(source, lang);
  highlighted.forEach((tokens, i) => {
    const raw = body[i] ?? '';
    const rows = wrapTokens(tokens, codeWidth);
    rows.forEach((row, r) => {
      const segs: UISegment[] = [{ text: CODE_GUTTER, color: theme.codeBorder }];
      for (const t of row) segs.push({ text: t.text, color: tokenColor(t.kind) });
      out.push({
        text: CODE_GUTTER + row.map((t) => t.text).join(''),
        copy: r === 0 ? raw : row.map((t) => t.text).join(''),
        segments: segs,
      });
    });
  });

  if (closed) {
    out.push({
      text: '  ╰─',
      copy: '',
      segments: [{ text: '  ╰─', color: theme.codeBorder }],
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

function pad(text: string, width: number, align: Align): string {
  const gap = Math.max(0, width - text.length);
  if (align === 'right') return ' '.repeat(gap) + text;
  if (align === 'center') {
    const l = Math.floor(gap / 2);
    return ' '.repeat(l) + text + ' '.repeat(gap - l);
  }
  return text + ' '.repeat(gap);
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
      widths[c] = Math.max(widths[c], plainInline(row[c] ?? '').length);
    }
  }
  const total = widths.reduce((a, b) => a + b, 0) + 3 * (cols - 1);
  if (total > width) return -1; // too wide — caller renders plain lines

  const emitRow = (row: string[], bold: boolean): void => {
    const segs: UISegment[] = [];
    let text = '';
    for (let c = 0; c < cols; c++) {
      const cell = row[c] ?? '';
      const visible = plainInline(cell);
      const padded = pad(visible, widths[c], aligns[c]);
      if (c > 0) {
        segs.push({ text: ' │ ', color: theme.codeBorder });
        text += ' │ ';
      }
      segs.push({ text: padded, color: theme.assistant, bold });
      text += padded;
    }
    out.push({ text, copy: text, segments: segs });
  };

  emitRow(header, true);
  out.push({
    text: widths.map((w) => '─'.repeat(w)).join('─┼─'),
    copy: '',
    segments: [
      { text: widths.map((w) => '─'.repeat(w)).join('─┼─'), color: theme.codeBorder },
    ],
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
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;

const BULLETS = ['•', '◦', '▪', '‣', '·'];

/** Emit wrapped content under a marker prefix, hanging-indented. */
function emitWrapped(
  prefix: string,
  content: string,
  width: number,
  contentColor: string,
  prefixColor: string,
  out: UILine[],
  contentStyle?: Partial<UISegment>,
): void {
  const avail = Math.max(4, width - prefix.length);
  const pieces = wrapText(content, avail);
  pieces.forEach((piece, i) => {
    const lead = i === 0 ? prefix : ' '.repeat(prefix.length);
    const segs: UISegment[] = [{ text: lead, color: prefixColor }];
    const inline = inlineSegments(piece, contentColor);
    for (const s of inline) segs.push({ ...s, ...contentStyle });
    out.push({
      text: lead + piece,
      // Copy the rendered text (markers stripped) so selections paste clean.
      copy: segs.map((s) => s.text).join(''),
      segments: segs,
    });
  });
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
    const prefix = '  '.repeat(depth) + marker;
    emitWrapped(prefix, content, width, theme.assistant, theme.bullet, out);
    i++;
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
      const level = heading[1].length;
      const color = level >= 4 ? theme.muted : theme.heading;
      const bold = level <= 2;
      const underline = level === 1;
      for (const piece of wrapText(heading[2], width)) {
        out.push({
          text: piece,
          color,
          bold,
          copy: piece,
          segments: [{ text: piece, color, bold, underline }],
        });
      }
      out.push({ text: '' });
      i++;
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      const depth = Math.min(4, Math.max(1, (line.match(/>/g) ?? []).length));
      const prefix = '▍ '.repeat(depth);
      emitWrapped(prefix, quote[2], width, theme.muted, theme.codeBorder, out, {
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

    // Paragraph.
    for (const piece of wrapText(line, width)) {
      const inline = inlineSegments(piece, theme.assistant);
      out.push({
        text: piece,
        color: theme.assistant,
        copy: inline.map((s) => s.text).join(''),
        segments: inline,
      });
    }
    i++;
  }

  return out;
}

/** Test hook: drop the markdown memo table. */
export function clearMarkdownCache(): void {
  MD_CACHE.clear();
}
