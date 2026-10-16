/**
 * Human-readable rendering of a tool call's arguments.
 *
 * The agent speaks JSON: `write_file` arrives as
 *   {"path":"prime.py","content":"def foo():\n  ..."}
 * Dropping that raw string on one truncated line is unreadable — newlines show
 * up as the two characters `\n` and the interesting part scrolls off the edge.
 *
 * This module translates the common tools' arguments into the same flat
 * `UILine[]` the markdown renderer produces, so the tool-start line reads like
 * a compact preview: the tool name plus a path/diff/command, with the payload
 * shown as real, syntax-highlighted, wrapped lines underneath.
 *
 * It is pure and dependency-free (only `theme`, the markdown helpers and the
 * highlighter), so it is unit-testable without a TTY. Unknown tools fall back
 * to a single-line compact JSON snippet — same shape as before, just tidier.
 */

import { theme } from './theme.js';
import {
  displayWidth,
  fitLine,
  wrapSegments,
  type UILine,
  type UISegment,
} from './markdown.js';
import { detectLanguage, highlightCode } from './syntax.js';
import { tokenColor } from './markdown.js';

/** Cap on payload lines shown in a preview before an "N more lines" tail. */
const MAX_PREVIEW_LINES = 12;

/** Cap on the length of a one-line value (command, path) before ellipsis. */
const MAX_VALUE = 200;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** Parse the raw argument JSON, returning null when it isn't an object. */
function parseArgs(raw: string): Record<string, any> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** `\n`/`\t` inside a single-line value: collapse so it stays one row. */
function oneLine(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/\n/g, ' ⏎ ').replace(/\t/g, '  ');
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Truncate a single-line value to MAX_VALUE cells. */
function clip(s: string): string {
  const flat = oneLine(s);
  return displayWidth(flat) > MAX_VALUE ? fitLine(flat, MAX_VALUE) : flat;
}

/** The header row: `☄ name` in the tool color with a muted detail trailing. */
function header(name: string, detail: string, width: number): UILine {
  const label = `☄ ${name}`;
  const room = Math.max(0, width - displayWidth(label) - 1);
  const segs: UISegment[] = [{ text: label, color: theme.toolName }];
  let text = label;
  if (detail) {
    const shown = room <= 0 ? '' : fitLine(detail, room);
    if (shown) {
      segs.push({ text: ` ${shown}`, color: theme.muted });
      text += ` ${shown}`;
    }
  }
  return { text, copy: text, segments: segs };
}

/**
 * Render `label value` as a hanging-indented line, wrapping long values under
 * a 4-cell gutter so paths and commands stay aligned.
 */
function labeled(label: string, value: string, width: number, color: string): UILine[] {
  const prefix = `    ${label} `;
  const segs = wrapSegments(
    [
      { text: prefix, color: theme.muted },
      { text: value, color },
    ],
    Math.max(8, width),
  );
  return segs.map((row) => {
    const text = row.map((s) => s.text).join('');
    return { text, copy: text, color, segments: row };
  });
}

/**
 * Preview a payload as real lines: an optional code fence with syntax
 * highlighting, indented by a gutter and wrapped to the pane. When the payload
 * is longer than MAX_PREVIEW_LINES only the head is shown plus a count.
 */
function preview(
  body: string,
  langHint: string | null,
  width: number,
  out: UILine[],
): void {
  const all = body.replace(/\r\n?/g, '\n').split('\n');
  const shown = all.slice(0, MAX_PREVIEW_LINES);
  const hidden = all.length - shown.length;

  const lang = detectLanguage(langHint ?? 'plain');
  const highlighted = highlightCode(shown.join('\n'), lang);

  const gutter = '  │ ';
  const codeWidth = Math.max(8, width - gutter.length);
  highlighted.forEach((tokens, i) => {
    const segs: UISegment[] = [{ text: gutter, color: theme.codeBorder }];
    for (const t of tokens) segs.push({ text: t.text, color: tokenColor(t.kind) });
    const visible = tokens.map((t) => t.text).join('');
    out.push({
      text: gutter + visible,
      // Strip the gutter when copying so a paste is clean source.
      copy: visible,
      segments: segs,
    });
    void i;
  });

  if (hidden > 0) {
    const tail = `  … ${hidden} more line${hidden === 1 ? '' : 's'}`;
    out.push({ text: tail, color: theme.muted, dim: true, copy: '' });
  }
}

/* ------------------------------------------------------------------ *
 * Per-tool renderers
 * ------------------------------------------------------------------ */

/** `write_file` / `edit_file` style: path plus a content or search/replace preview. */
function renderWrite(
  name: string,
  a: Record<string, any>,
  width: number,
  out: UILine[],
): boolean {
  const path = str(a.path);
  const content = str(a.content);
  if (path === null && content === null) return false;
  out.push(header(name, path ? clip(path) : '', width));
  if (path) out.push(...labeled('path:', path, width, theme.assistant));
  if (content !== null && content !== '') {
    const lines = content.split('\n').length;
    out.push({
      text: `    content · ${lines} line${lines === 1 ? '' : 's'}, ${content.length} chars`,
      color: theme.muted,
      dim: true,
      copy: '',
    });
    preview(content, langFromPath(path), width, out);
  } else if (content === '') {
    out.push({ text: '    content · empty', color: theme.muted, dim: true, copy: '' });
  }
  return true;
}

/** `edit_file`: search/replace shown as a compact ± preview. */
function renderEdit(
  name: string,
  a: Record<string, any>,
  width: number,
  out: UILine[],
): boolean {
  const search = str(a.search);
  const replace = str(a.replace);
  if (search === null && replace === null && str(a.path) === null) return false;
  const path = str(a.path);
  out.push(header(name, path ? clip(path) : '', width));
  if (path) out.push(...labeled('path:', path, width, theme.assistant));
  emitDiffBlock(str(a.search) ?? '', str(a.replace) ?? '', width, out);
  if (a.replace_all === true) {
    out.push({ text: '    replace_all · yes', color: theme.muted, dim: true, copy: '' });
  }
  return true;
}

/** Emit a `-` / `+` block for a search→replace pair. */
function emitDiffBlock(search: string, replace: string, width: number, out: UILine[]): void {
  const emit = (mark: string, color: string, body: string) => {
    const rows = body.replace(/\r\n?/g, '\n').split('\n');
    const shown = rows.slice(0, MAX_PREVIEW_LINES);
    const hidden = rows.length - shown.length;
    for (const row of shown) {
      const text = fitLine(`    ${mark} ${row}`, Math.max(8, width));
      out.push({ text, color, copy: row });
    }
    if (hidden > 0) {
      out.push({
        text: `    … ${hidden} more line${hidden === 1 ? '' : 's'}`,
        color: theme.muted,
        dim: true,
        copy: '',
      });
    }
  };
  if (search) emit('-', theme.synDel, search);
  if (replace) emit('+', theme.synAdd, replace);
}

/** `multi_edit` / `apply_patch`: a list of hunks under the path. */
function renderMulti(
  name: string,
  a: Record<string, any>,
  width: number,
  out: UILine[],
): boolean {
  const path = str(a.path);
  const edits = Array.isArray(a.edits) ? a.edits : null;
  if (path === null && !edits) return false;
  const count = edits ? edits.length : 0;
  out.push(header(name, path ? clip(path) : '', width));
  if (path) out.push(...labeled('path:', path, width, theme.assistant));
  out.push({
    text: `    ${count} hunk${count === 1 ? '' : 's'}`,
    color: theme.muted,
    dim: true,
    copy: '',
  });
  if (edits) {
    let budget = MAX_PREVIEW_LINES;
    for (let i = 0; i < edits.length && budget > 0; i++) {
      const h = edits[i] ?? {};
      const head: UILine = {
        text: `    #${i + 1}`,
        color: theme.muted,
        dim: true,
        copy: '',
      };
      out.push(head);
      const before = out.length;
      emitDiffBlock(str(h.search) ?? '', str(h.replace) ?? '', width, out);
      budget -= out.length - before;
    }
  }
  return true;
}

/** `run_command`: the shell command, rendered verbatim. */
function renderCommand(
  name: string,
  a: Record<string, any>,
  width: number,
  out: UILine[],
): boolean {
  const cmd = str(a.command);
  if (cmd === null) return false;
  out.push(header(name, '', width));
  out.push(...labeled('$', oneLine(cmd), width, theme.assistant));
  const extra: string[] = [];
  if (str(a.cwd)) extra.push(`cwd ${str(a.cwd)}`);
  if (typeof a.timeout_ms === 'number') extra.push(`timeout ${a.timeout_ms}ms`);
  if (extra.length > 0) {
    out.push({
      text: `    ${extra.join(' · ')}`,
      color: theme.muted,
      dim: true,
      copy: '',
    });
  }
  return true;
}

/** Read-only tools whose single interesting argument is a path/pattern/url. */
const SIMPLE_ARGS: Record<string, { key: string; prefix: string }> = {
  read_file: { key: 'path', prefix: '' },
  list_dir: { key: 'path', prefix: '' },
  search_files: { key: 'pattern', prefix: '' },
  git_status: { key: 'path', prefix: '' },
  git_diff: { key: 'path', prefix: '' },
  fetch_url: { key: 'url', prefix: '' },
  worktree: { key: 'action', prefix: '' },
};

function renderSimple(
  name: string,
  a: Record<string, any>,
  width: number,
  out: UILine[],
): boolean {
  const spec = SIMPLE_ARGS[name];
  if (!spec) return false;
  const val = str(a[spec.key]);
  const extras = Object.entries(a)
    .filter(
      ([k, v]) =>
        k !== spec.key &&
        (v === true || (typeof v === 'string' && v !== '') || typeof v === 'number'),
    )
    .map(([k, v]) => `${k}=${v === true ? 'true' : clip(String(v))}`);

  const detail = val !== null ? clip(val) : extras.join(' ');
  out.push(header(name, detail, width));
  if (val !== null && extras.length > 0) {
    out.push({
      text: `    ${extras.join(' · ')}`,
      color: theme.muted,
      dim: true,
      copy: '',
    });
  }
  return true;
}

/** Tools with no meaningful arguments (e.g. `repomap`). */
function renderBare(name: string, width: number, out: UILine[]): void {
  out.push(header(name, '', width));
}

/* ------------------------------------------------------------------ *
 * Fallback
 * ------------------------------------------------------------------ */

/** Compact JSON one-liner for tools we don't special-case. */
function renderRaw(name: string, raw: string, width: number, out: UILine[]): void {
  const parsed = parseArgs(raw);
  let snippet = raw;
  if (parsed) {
    try {
      snippet = JSON.stringify(parsed);
    } catch {
      /* keep raw */
    }
  }
  out.push(header(name, '', width));
  if (snippet && snippet !== '{}') {
    // Wrap the compact JSON under the gutter rather than truncating it, so
    // nothing is silently lost.
    const rows = wrapSegments(
      [{ text: `    ${snippet}`, color: theme.muted }],
      Math.max(8, width),
    );
    for (const row of rows) {
      const text = row.map((s) => s.text).join('');
      out.push({ text, copy: text, color: theme.muted, segments: row });
    }
  }
}

function langFromPath(path: string | null): string | null {
  if (!path) return null;
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1];
  return ext ?? null;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Format one tool call as display lines. Always returns at least the header
 * line, so callers never have to guard against an empty result.
 *
 * @param name  Tool name, e.g. `write_file`.
 * @param rawArgs  The raw JSON argument string from the model.
 * @param width  Available display width in cells.
 */
export function formatToolCall(name: string, rawArgs: string, width: number): UILine[] {
  const out: UILine[] = [];
  const a = parseArgs(rawArgs);

  if (a) {
    let handled = false;
    switch (name) {
      case 'write_file':
        handled = renderWrite(name, a, width, out);
        break;
      case 'edit_file':
        handled = renderEdit(name, a, width, out);
        break;
      case 'multi_edit':
      case 'apply_patch':
        handled = renderMulti(name, a, width, out);
        break;
      case 'run_command':
        handled = renderCommand(name, a, width, out);
        break;
      case 'repomap':
        renderBare(name, width, out);
        handled = true;
        break;
      default:
        handled = renderSimple(name, a, width, out);
        break;
    }
    if (handled) return out;
  }

  if (out.length === 0) renderRaw(name, rawArgs, width, out);
  return out;
}

/** Test hook: the fallback used when a tool has no dedicated renderer. */
export const __test = { renderRaw, MAX_PREVIEW_LINES };
