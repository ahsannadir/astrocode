/**
 * Agent-loop sensors for AstroCode.
 *
 * A coding agent can fall into degenerate loops: re-calling the same tool
 * with the same arguments, or wobbling between two calls, burning budget
 * until the turn cap. "Backpressure engineering" — a well-known 2026 harness
 * pattern — says the loop should *sense* this and push back on the model
 * instead of silently letting it spin.
 *
 * The sensor keys calls by tool name + canonicalized arguments, so
 * whitespace differences in the JSON don't hide a repeat. On the 3rd
 * identical call it injects a nudge into the tool result (the model can
 * still force its way through if genuinely needed). On the 6th it BLOCKS
 * the call entirely and replays the cached result of the first identical
 * call, so no budget is wasted re-deriving the same output.
 *
 * State lives on an instance: one sensor per main-loop turn, one per
 * sub-agent run, both reset when their loop restarts.
 */

export const NUDGE_THRESHOLD = 3;
export const BLOCK_THRESHOLD = 6;

export interface LoopCall {
  name: string;
  args: string;
}

export interface SensorVerdict {
  /** Run the tool normally. */
  allow: boolean;
  /** When blocked: the cached result text to replay instead of executing. */
  cachedResult?: string;
  /** Sensory feedback appended to the tool result (empty when all is well). */
  nudge: string;
  /** Times this exact call has now been seen. */
  count: number;
}

/**
 * Canonicalize args JSON so `{ "a": 1, "b": 2 }`, `{"b":2,"a":1}` and
 * `{"a":1,  "b":2}` all collide as the same repeat.
 */
function canonicalize(args: string): string {
  try {
    return stableStringify(JSON.parse(args));
  } catch {
    // Not JSON — fall back to whitespace-normalized text so multi-line
    // shell commands with cosmetic diffs still collide.
    return (args ?? '').replace(/\s+/g, ' ').trim();
  }
}

/** JSON.stringify with object keys sorted (deep), arrays order-preserving. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function callKey(call: LoopCall): string {
  return `${call.name}::${canonicalize(call.args)}`;
}

export class LoopSensor {
  /** key → times seen. */
  private counts = new Map<string, number>();
  /** key → cached result text from a previous identical execution. */
  private cache = new Map<string, string>();

  reset(): void {
    this.counts.clear();
    this.cache.clear();
  }

  /**
   * Record the tool's result so a later blocked repeat can replay it.
   * Call after a successful (allowed) execution.
   */
  remember(call: LoopCall, resultText: string): void {
    const key = callKey(call);
    if (!this.cache.has(key)) this.cache.set(key, resultText);
  }

  /**
   * Record an imminent call and decide what to do with it.
   */
  observe(call: LoopCall): SensorVerdict {
    const key = callKey(call);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);

    if (count >= BLOCK_THRESHOLD) {
      const cached = this.cache.get(key);
      return {
        allow: false,
        cachedResult:
          cached ??
          '(no cached result — the earlier identical call(s) never produced one)',
        nudge:
          `⛔ blocked: this exact call (${call.name}) has now been attempted ` +
          `${count} times with identical arguments. The cached result is ` +
          `replayed above. You MUST change your approach — different ` +
          `arguments, a different tool, or finish with a final answer.`,
        count,
      };
    }

    if (count >= NUDGE_THRESHOLD) {
      return {
        allow: true,
        nudge:
          `⚠️ loop sensor: this exact call has now been made ${count} times ` +
          `with identical arguments. If you expected different output, ` +
          `change the arguments or use a different tool; otherwise proceed ` +
          `to your next step.`,
        count,
      };
    }

    return { allow: true, nudge: '', count };
  }
}
