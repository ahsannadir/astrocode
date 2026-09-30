/**
 * File undo stack for AstroCode.
 *
 * Before every destructive file op (write_file / edit_file) we snapshot the
 * original bytes so the user can revert the most recent change(s) with
 * /undo. The stack lives for the life of the process (module-level).
 */
import { promises as fs } from 'node:fs';

export interface Snapshot {
  path: string;
  hadFile: boolean;
  content: string | null; // null if the file did not exist before
}

const stack: Snapshot[] = [];
const MAX = 100;

/** Called by write/edit tools *before* mutating, to enable /undo. */
export async function snapshotFile(fp: string): Promise<void> {
  let content: string | null = null;
  let hadFile = false;
  try {
    content = await fs.readFile(fp, 'utf8');
    hadFile = true;
  } catch {
    hadFile = false;
  }
  stack.push({ path: fp, hadFile, content });
  if (stack.length > MAX) stack.shift();
}

export function undoCount(): number {
  return stack.length;
}

/** Revert the most recent change and return a human-readable result. */
export async function revertLast(): Promise<{ ok: boolean; text: string }> {
  const snap = stack.pop();
  if (!snap) {
    return { ok: false, text: 'Nothing to undo — no file changes were made.' };
  }
  try {
    if (snap.hadFile) {
      await fs.writeFile(snap.path, snap.content ?? '', 'utf8');
      return { ok: true, text: `Reverted ${snap.path} (restored previous content).` };
    }
    await fs.rm(snap.path, { force: true }).catch(() => {});
    return { ok: true, text: `Reverted ${snap.path} (file was created by the last change).` };
  } catch (e: any) {
    return { ok: false, text: `Undo failed: ${e?.message ?? e}` };
  }
}

// ── turn-level checkpoints ───────────────────────────────────────────────
// Before each agent turn we mark a boundary in the snapshot stack. /rewind
// then reverts EVERY snapshot taken since that boundary — restoring the whole
// working tree to its pre-turn state (including files created during the turn),
// which is broader than the single-file /undo.

const boundaries: number[] = [];

/** Mark the start of a new agent turn (called before runAgent). */
export function markTurnBoundary(): void {
  boundaries.push(stack.length);
}

/** Number of file changes recorded since the last turn boundary. */
export function changesSinceLastBoundary(): number {
  const last = boundaries.length > 0 ? boundaries[boundaries.length - 1] : 0;
  return Math.max(0, stack.length - last);
}

/**
 * Revert every change made since the most recent turn boundary (or since the
 * start of the session if none was marked). Returns a human-readable result.
 */
export async function rewindTurn(): Promise<{ ok: boolean; text: string; count: number }> {
  if (boundaries.length === 0) {
    if (stack.length === 0) {
      return { ok: false, text: 'No checkpoint to rewind to.', count: 0 };
    }
    let count = 0;
    while (stack.length > 0) {
      const r = await revertLast();
      if (!r.ok) return { ok: false, text: r.text, count };
      count++;
    }
    return { ok: true, text: `Rewound ${count} change(s) to the start of session.`, count };
  }
  const target = boundaries[boundaries.length - 1];
  if (stack.length === target) {
    boundaries.pop();
    return { ok: true, text: 'No changes were made in the last turn.', count: 0 };
  }
  let count = 0;
  while (stack.length > target) {
    const r = await revertLast();
    if (!r.ok) return { ok: false, text: `Rewind stopped: ${r.text}`, count };
    count++;
  }
  boundaries.pop();
  return { ok: true, text: `Rewound ${count} change(s) from the last turn.`, count };
}
