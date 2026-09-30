/**
 * Context compaction for AstroCode.
 *
 * "Context is a finite resource" (Anthropic) and compaction is how a
 * long-running agent sustains progress across it. Previously /compact was a
 * stub that only printed a message; now it performs a real, deterministic
 * compaction of the conversation:
 *
 *   1. Always keep the system message, the user's task statements, and the
 *      most recent `keepRecent` messages untouched.
 *   2. Never break tool-call pairing: an assistant message with tool_calls
 *      and its tool results are kept or compacted as one unit — providers
 *      reject orphans.
 *   3. Old tool batches collapse to a one-line "[compacted] called X, Y"
 *      summary; the model knows what happened and can re-run a tool if it
 *      needs the full output again.
 *   4. Tool results in the kept tail get their bodies elided to a short head.
 *
 * This is deliberately a MECHANISM, not a prompt: it is applied
 * mechanically by the agent loop when the context-usage meter approaches
 * the model's window (see App.tsx), so the model never silently truncates.
 */
import type { ChatMessage } from './types.js';

export const COMPACT_NOTICE =
  '[context compacted — earlier tool results were elided; re-run a tool ' +
  'if you need its full output again]';

export interface CompactOptions {
  /** How many of the newest messages to always keep verbatim (default 12). */
  keepRecent?: number;
  /** How many chars of each kept-but-old tool result to retain (default 400). */
  oldToolResultChars?: number;
}

export interface CompactResult {
  messages: ChatMessage[];
  /** Number of messages removed outright (replaced by summaries). */
  dropped: number;
  /** Number of tool-result bodies elided to a head. */
  elided: number;
  charsBefore: number;
  charsAfter: number;
}

function msgChars(m: ChatMessage): number {
  let n = typeof m.content === 'string' ? m.content.length : 0;
  if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
  return n;
}

/**
 * Group the conversation into atomic units: a tool result always joins the
 * group before it (its assistant tool-call batch), so a group is never split
 * between "old" and "kept". Groups preserve original order.
 */
function groupMessages(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (const m of messages) {
    if (m.role === 'tool' && groups.length > 0) {
      groups[groups.length - 1].push(m);
      continue;
    }
    groups.push([m]);
  }
  return groups;
}

export function compactConversation(
  messages: ChatMessage[],
  options: CompactOptions = {},
): CompactResult {
  const keepRecent = Math.max(2, options.keepRecent ?? 12);
  const oldToolResultChars = Math.max(80, options.oldToolResultChars ?? 400);

  const totalChars = messages.reduce((s, m) => s + msgChars(m), 0);
  if (messages.length <= keepRecent) {
    return {
      messages,
      dropped: 0,
      elided: 0,
      charsBefore: totalChars,
      charsAfter: totalChars,
    };
  }

  const cut = messages.length - keepRecent; // first index of the kept tail
  const out: ChatMessage[] = [];
  let dropped = 0;
  let elided = 0;

  const groups = groupMessages(messages);
  let idx = 0;
  for (const group of groups) {
    const groupEnd = idx + group.length; // exclusive
    const first = group[0];

    if (groupEnd > cut || first.role === 'system' || first.role === 'user') {
      // Kept tail (whole groups), plus every system/user message: the task
      // statements and configuration must survive compaction.
      out.push(...group);
      // Elide old tool-result bodies that survived inside a kept group only
      // when the group lies fully in the OLD region (never touch the fresh
      // tail the model is actively using).
      if (groupEnd <= cut) {
        for (const m of group) {
          if (
            m.role === 'tool' &&
            typeof m.content === 'string' &&
            m.content.length > oldToolResultChars
          ) {
            m.content =
              m.content.slice(0, oldToolResultChars) +
              `…[elided ${m.content.length - oldToolResultChars} chars by /compact]`;
            elided++;
          }
        }
      }
    } else {
      // Fully-old group → summarize.
      const hadToolCalls = group.some((m) => m.tool_calls && m.tool_calls.length > 0);
      const hadToolResults = group.some((m) => m.role === 'tool');
      if (hadToolCalls || hadToolResults) {
        const names = new Set<string>();
        for (const m of group) {
          if (m.tool_calls) for (const tc of m.tool_calls) names.add(tc.name);
          if (m.role === 'tool') names.add(m.name ?? 'tool');
        }
        out.push({
          role: 'assistant',
          content:
            `[compacted] called ${[...names].join(', ') || 'tools'}; ${COMPACT_NOTICE}`,
        });
        dropped += group.length - 1;
        elided += group.filter((m) => m.role === 'tool').length;
      } else if (first.role === 'assistant') {
        // Old assistant prose: keep a bounded summary line.
        const text = (first.content ?? '').trim();
        out.push({
          role: 'assistant',
          content: text.length > 160 ? text.slice(0, 160) + '…' : text,
        });
        dropped += group.length - 1;
      } else {
        out.push(...group);
      }
    }
    idx = groupEnd;
  }

  const charsAfter = out.reduce((s, m) => s + msgChars(m), 0);
  return { messages: out, dropped, elided, charsBefore: totalChars, charsAfter };
}

/** Human-readable summary for the UI / slash command. */
export function describeCompaction(r: CompactResult): string {
  const saved = r.charsBefore - r.charsAfter;
  return (
    `Compacted context: ${r.dropped} message(s) dropped, ` +
    `${r.elided} old tool result(s) elided — ` +
    `${r.charsBefore.toLocaleString()} → ${r.charsAfter.toLocaleString()} chars ` +
    `(saved ${saved.toLocaleString()}).`
  );
}
