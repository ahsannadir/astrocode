/**
 * Pure helpers behind the /history picker.
 *
 * A saved session is a `ChatMessage[]` — the same wire format the provider
 * sees — while the transcript is a list of `UIItem`s. Rebuilding one from the
 * other is pure text work, so it lives here (next to `mention.ts` and
 * `modelPicker.ts`) rather than inside App, and can be tested without a
 * terminal or a provider.
 */
import type { ChatMessage } from '../types.js';
import type { UIItem } from './MessageArea.js';
import { stripMentionBlock } from './mention.js';

/** Human-friendly age for a session row ("just now", "3h ago", "12m ago"). */
export function relativeAge(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const seconds = Math.max(0, Math.floor((now - t) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}

/**
 * Best-effort success badge for a replayed tool result.
 *
 * Sessions persist the model-facing `ChatMessage` (role/content), which has no
 * `ok` flag — the live app knows the real value, but it is not part of the
 * wire format. Tool failures from the registry start with a recognizable
 * marker (`⛔`, "Blocked in PLAN mode", "Unknown tool", "… failed"), so the
 * badge is inferred from those rather than pretending every old result
 * succeeded. Cosmetic only: it colours the line, it never changes content.
 */
export function toolResultLooksOk(text: string): boolean {
  const head = text.trimStart().slice(0, 200);
  return !/^(?:⛔|Blocked in PLAN mode|Unknown tool|Tool \w+ threw|.*\bfailed\b)/i.test(head);
}

/**
 * Rebuild the transcript for a resumed session.
 *
 * - `user` messages lose their `@file` attachment block, so the pane shows the
 *   sentence that was typed instead of thousands of lines of file content
 *   (the block is still in the conversation the model will see).
 * - assistant tool calls become `tool_start` rows; the matching `tool`
 *   messages become `tool_result` rows, in their original order.
 * - a compacted conversation's system summary is kept as a system note.
 */
export function itemsFromMessages(messages: readonly ChatMessage[]): UIItem[] {
  const items: UIItem[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const text = stripMentionBlock(String(m.content ?? '')).trim();
      if (text) items.push({ kind: 'user', text });
      continue;
    }
    if (m.role === 'assistant') {
      const text = String(m.content ?? '').trim();
      if (text) items.push({ kind: 'assistant', text });
      for (const call of m.tool_calls ?? []) {
        items.push({
          kind: 'tool_start',
          name: call.name,
          args: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
        });
      }
      continue;
    }
    if (m.role === 'tool') {
      const text = String(m.content ?? '');
      items.push({
        kind: 'tool_result',
        name: m.name ?? 'tool',
        ok: toolResultLooksOk(text),
        text,
      });
      continue;
    }
    // role === 'system' (e.g. a compaction summary)
    const text = String(m.content ?? '').trim();
    if (text) items.push({ kind: 'system', text });
  }
  return items;
}
