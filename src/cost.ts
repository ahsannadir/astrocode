/**
 * Cost & token accounting for AstroCode.
 *
 * Tracks estimated token usage and USD cost so the agent can stay within a
 * budget (see ASTROCODE_BUDGET) and surface live spend in the status bar.
 * Token counts are estimates (≈4 chars/token); pricing is per 1M tokens.
 */

export interface Pricing {
  inputPerM: number;
  outputPerM: number;
}

/** Approximate USD per 1M tokens for common model families. */
const PRICING: Record<string, Pricing> = {
  'gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6 },
  'gpt-4o': { inputPerM: 2.5, outputPerM: 10 },
  'gpt-4-turbo': { inputPerM: 10, outputPerM: 30 },
  'gpt-4': { inputPerM: 30, outputPerM: 60 },
  'gpt-3.5-turbo': { inputPerM: 0.5, outputPerM: 1.5 },
  'claude-opus': { inputPerM: 15, outputPerM: 75 },
  'claude-sonnet': { inputPerM: 3, outputPerM: 15 },
  'claude-haiku': { inputPerM: 0.8, outputPerM: 4 },
  'claude-3-5-sonnet': { inputPerM: 3, outputPerM: 15 },
  'claude-3-5-haiku': { inputPerM: 0.8, outputPerM: 4 },
};

const DEFAULT_PRICING: Pricing = { inputPerM: 1, outputPerM: 3 };

export function pricingFor(model: string): Pricing {
  const m = model.toLowerCase();
  for (const key of Object.keys(PRICING)) {
    if (m.includes(key)) return PRICING[key];
  }
  return DEFAULT_PRICING;
}

/** Rough token estimate: ≈4 characters per token. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Format a USD amount sensibly for display. */
export function formatCost(usd: number): string {
  if (usd <= 0) return '$0.0000';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

// ── context window accounting ─────────────────────────────────────────────
// Estimate how much of the model's context window the current conversation
// occupies, so we can show a live meter and warn before truncation.

/** Approximate context-window size (in tokens) for common model families. */
export function contextLimitFor(model: string): number {
  const m = model.toLowerCase();
  if (m.includes('gpt-4o')) return 128_000;
  if (m.includes('gpt-4-turbo')) return 128_000;
  if (m.includes('gpt-4')) return 8_192;
  if (m.includes('gpt-3.5')) return 16_385;
  if (m.includes('claude-3') || m.includes('claude-opus') || m.includes('claude-sonnet') || m.includes('claude-haiku')) {
    return 200_000;
  }
  if (m.includes('gemini-1.5')) return 1_000_000;
  if (m.includes('llama') || m.includes('mistral') || m.includes('qwen')) return 32_000;
  return 128_000;
}

/** Estimate tokens used by a full message array (system + user + assistant + tool). */
export function estimateContextTokens(messages: { content?: string | null; tool_calls?: unknown[] | null }[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return estimateTokens('x'.repeat(chars));
}

/** Color name for a context-usage percentage (for the status meter). */
export function contextColor(pct: number): string {
  if (pct >= 80) return 'red';
  if (pct >= 50) return 'yellow';
  return 'green';
}
