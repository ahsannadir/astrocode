/**
 * Pure text-editing primitives for every text field in the TUI (the main
 * prompt, the /login base-URL + key + custom-model fields).
 *
 * Kept free of React/Ink so they are unit-testable. They encode the rules
 * that previously lived (inconsistently) inside the components:
 *
 * - Backspace: Ink maps DEL (\x7f — what most terminals emit for Backspace)
 *   to `key.delete` and \b (0x08) to `key.backspace`. Treat both as
 *   "delete before cursor", plus Ctrl+W (delete word) and Ctrl+U (kill line)
 *   which readline users expect.
 * - Printable filter: incoming `input` from Ink can be a CONTROL CHARACTER
 *   or a CSI/mouse-report escape sequence fragment — inserting those corrupts
 *   the line (junk appears, then backspace seems to "delete nothing" while
 *   the caret walks backwards through invisible characters). Only accept
 *   real printable characters (>= 0x20, excluding 0x7f), with \r\n\t
 *   converted to spaces.
 * - Multi-char input = a PASTE. Bracketed-paste markers are stripped and the
 *   newlines become spaces (the prompt is single-line), with a size cap.
 */

/** Max characters accepted from a single paste (bounds memory + render). */
const MAX_PASTE_CHARS = 8_000;

/** True when `ch` is a single printable (non-control) character. */
export function isPrintableChar(ch: string): boolean {
  if (ch.length !== 1) return false;
  const code = ch.charCodeAt(0);
  // >= 0x20 excludes all C0 controls; 0x7f is DEL.
  return code >= 0x20 && code !== 0x7f;
}

/** Move a cursor one character left, counting surrogate pairs as one. */
export function moveCursorLeft(value: string, cursor: number): number {
  if (cursor <= 0) return 0;
  if (cursor > value.length) return value.length;
  let i = cursor - 1;
  // If the char before the cursor is a low surrogate, skip over the pair.
  if (i > 0 && value.charCodeAt(i) >= 0xdc00 && value.charCodeAt(i) <= 0xdfff) {
    i--;
  }
  return i;
}

/** Move a cursor one character right, counting surrogate pairs as one. */
export function moveCursorRight(value: string, cursor: number): number {
  if (cursor >= value.length) return value.length;
  let i = cursor + 1;
  if (
    i < value.length &&
    value.charCodeAt(i) >= 0xdc00 &&
    value.charCodeAt(i) <= 0xdfff
  ) {
    i++;
  }
  return i;
}

/**
 * Delete the character (or emoji/surrogate pair) before the cursor.
 * Returns null when there is nothing to delete.
 */
export function backspaceAt(
  value: string,
  cursor: number,
): { value: string; cursor: number } | null {
  if (cursor <= 0 || cursor > value.length) return null;
  const left = moveCursorLeft(value, cursor);
  if (left === cursor) return null;
  return { value: value.slice(0, left) + value.slice(cursor), cursor: left };
}

/** Delete the character after the cursor (forward-delete / Ctrl+D). */
export function deleteForwardAt(
  value: string,
  cursor: number,
): { value: string; cursor: number } | null {
  if (cursor >= value.length || cursor < 0) return null;
  const right = moveCursorRight(value, cursor);
  if (right === cursor) return null;
  return { value: value.slice(0, cursor) + value.slice(right), cursor };
}

/** Delete the word before the cursor (readline Ctrl+W / Ctrl+Backspace). */
export function deleteWordBefore(
  value: string,
  cursor: number,
): { value: string; cursor: number } | null {
  if (cursor <= 0 || cursor > value.length) return null;
  let i = cursor;
  while (i > 0 && value[i - 1] === ' ') i--; // eat trailing spaces
  while (i > 0 && value[i - 1] !== ' ') i--; // eat the word
  if (i === cursor) return null;
  return { value: value.slice(0, i) + value.slice(cursor), cursor: i };
}

/** Normalize multi-character (paste) input for a single-line field. */
export function normalizePaste(raw: string): string {
  const stripped = raw
    // Bracketed-paste markers — with or without their leading ESC, because
    // Ink strips the first \x1b of a chunk before we see the rest.
    .replace(/\x1b?\[200~/g, '')
    .replace(/\x1b?\[201~/g, '')
    .replace(/\x1b\[\?\d+c/g, ''); // device-attributes reply
  let out = '';
  for (const ch of stripped) {
    if (ch === '\r' || ch === '\n' || ch === '\t') {
      out += ' ';
    } else if (isPrintableChar(ch)) {
      out += ch;
    }
  }
  if (out.length > MAX_PASTE_CHARS) {
    out = out.slice(0, MAX_PASTE_CHARS);
  }
  return out;
}

/**
 * Count how many backspaces a chunk of input represents. Terminals (and PTY
 * batching) coalesce rapid keypresses into one read, so Backspace×3 can
 * arrive as '\x7f\x7f\x7f' — which must delete three characters, not be
 * dropped as garbage.
 */
export function countBackspaces(input: string): number {
  let n = 0;
  for (const ch of input) {
    if (ch === '\x7f' || ch === '\b') n++;
  }
  return n;
}

/** Count how many times an arrow appears in a coalesced input chunk. */
export function countArrow(input: string, dir: 'left' | 'right' | 'up' | 'down'): number {
  const seq =
    dir === 'left' ? '\x1b[D' : dir === 'right' ? '\x1b[C' : dir === 'up' ? '\x1b[A' : '\x1b[B';
  let n = 0;
  let i = input.indexOf(seq);
  while (i >= 0) {
    n++;
    i = input.indexOf(seq, i + seq.length);
  }
  return n;
}

/**
 * Insert printable text at the cursor. Handles both a single keypress and a
 * multi-character paste (which Ink delivers as one input event). Returns
 * null when nothing printable was present.
 */
export function insertAtCursor(
  value: string,
  cursor: number,
  input: string,
): { value: string; cursor: number } | null {
  if (!input || cursor < 0 || cursor > value.length) return null;
  if (input.length > 1) {
    const paste = normalizePaste(input);
    if (!paste) return null;
    return {
      value: value.slice(0, cursor) + paste + value.slice(cursor),
      cursor: cursor + paste.length,
    };
  }
  if (input === '\r' || input === '\n' || input === '\t') {
    return {
      value: value.slice(0, cursor) + ' ' + value.slice(cursor),
      cursor: cursor + 1,
    };
  }
  if (!isPrintableChar(input)) return null;
  return {
    value: value.slice(0, cursor) + input + value.slice(cursor),
    cursor: cursor + 1,
  };
}
