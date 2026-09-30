/**
 * Tool-result truncation for AstroCode.
 *
 * A single unbounded tool result (a huge read_file, a verbose build log, a
 * 2 MB grep match list) can evict the useful part of the conversation from
 * the model's context window. Rather than trusting every tool to cap itself
 * ("mechanisms, not instructions"), executeTool() pipes every result through
 * truncateToolText() before it enters the conversation.
 *
 * Truncation is head+tail: the head carries the beginning of the output
 * (paths, errors, early matches) and the tail carries the end (summaries,
 * "[exit code: N]"). The middle is elided with an explicit notice so the
 * model knows the output was clipped and can re-query more narrowly.
 */

export const DEFAULT_MAX_TOOL_RESULT_CHARS = 16_000;

/** Fraction of the budget kept at the head; the rest guards the tail. */
const HEAD_RATIO = 0.7;

export interface TruncateOptions {
  maxChars?: number;
}

export interface TruncateOutcome {
  text: string;
  truncated: boolean;
  originalChars: number;
}

/**
 * Cap `text` to `maxChars` (default ~16k chars ≈ 4k tokens), keeping the
 * head and the tail and eliding the middle with an explicit notice.
 */
export function truncateToolText(
  text: string,
  options: TruncateOptions = {},
): TruncateOutcome {
  const maxChars = Math.max(1_000, options.maxChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS);
  const originalChars = text.length;
  if (originalChars <= maxChars) {
    return { text, truncated: false, originalChars };
  }

  const head = Math.floor(maxChars * HEAD_RATIO);
  const tail = maxChars - head;
  const dropped = originalChars - head - tail;
  const droppedLines = text
    .slice(head, originalChars - tail)
    .split('\n').length;
  const headText = text.slice(0, head);
  const tailText = text.slice(originalChars - tail);

  const notice =
    `\n\n…[${dropped.toLocaleString()} chars (~${droppedLines} lines) elided — ` +
    `output capped at ${maxChars.toLocaleString()} chars. ` +
    `Narrow the query (max_lines, a subpath, a glob, or a more specific ` +
    `command) to see the middle.]`;

  return { text: headText + notice + tailText, truncated: true, originalChars };
}
