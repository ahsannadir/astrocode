/**
 * Key routing for the /models picker (ModelsModal), split out and pure so the
 * one rule that matters can be tested without a terminal:
 *
 *     Esc cancels, ALWAYS.
 *
 * The picker used to test `key.escape` *after* bailing out on an empty model
 * list. A provider with no registry models — 'OpenAI Compatible', whose list
 * is fetched live during /login — therefore rendered a popup that swallowed
 * every keystroke, Esc included, and offered no other way out. Cancelling must
 * never depend on the list being non-empty, on a scroll position, or on any
 * other state.
 */
import { isPrintableChar } from './inputEdit.js';

/** The subset of Ink's key flags this picker reacts to. */
export interface PickerKey {
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
  escape?: boolean;
}

/** What one keypress means to the picker; `null` means "ignore it". */
export type ModelPickerIntent =
  | { kind: 'cancel' }
  | { kind: 'move'; dir: 1 | -1 }
  | { kind: 'select' }
  | { kind: 'typeahead'; char: string }
  | null;

/**
 * Map a keypress to a picker action. `modelCount` is how many models the
 * active provider offers (0 → nothing to move through or select, but the
 * picker still closes on Esc).
 */
export function modelPickerIntent(
  modelCount: number,
  input: string,
  key: PickerKey,
): ModelPickerIntent {
  if (key.escape) return { kind: 'cancel' };
  if (modelCount === 0) return null;
  if (key.upArrow) return { kind: 'move', dir: -1 };
  if (key.downArrow) return { kind: 'move', dir: 1 };
  if (key.return) return { kind: 'select' };
  // Type-ahead: a single printable character only — multi-char input is a
  // paste or an escape-sequence fragment, and control bytes (including DEL,
  // which backspace sends) are never a navigation keystroke.
  if (isPrintableChar(input)) {
    return { kind: 'typeahead', char: input.toLowerCase() };
  }
  return null;
}
