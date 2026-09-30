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
  /** USD per 1M cached input tokens (prompt-cache hits). Optional. */
  cachedInputPerM?: number;
}

/** Approximate USD per 1M tokens, updated Sept 2026. */
const PRICING: Record<string, Pricing> = {
  // OpenAI
  'gpt-5': { inputPerM: 1.25, outputPerM: 10, cachedInputPerM: 0.125 },
  'gpt-5-mini': { inputPerM: 0.25, outputPerM: 2, cachedInputPerM: 0.025 },
  'gpt-5-nano': { inputPerM: 0.05, outputPerM: 0.4, cachedInputPerM: 0.005 },
  'gpt-4.1': { inputPerM: 2, outputPerM: 8, cachedInputPerM: 0.5 },
  'gpt-4.1-mini': { inputPerM: 0.4, outputPerM: 1.6, cachedInputPerM: 0.1 },
  'gpt-4.1-nano': { inputPerM: 0.1, outputPerM: 0.4, cachedInputPerM: 0.025 },
  'o4-mini': { inputPerM: 1.1, outputPerM: 4.4, cachedInputPerM: 0.275 },
  'o3': { inputPerM: 2, outputPerM: 8, cachedInputPerM: 0.5 },
  'o3-mini': { inputPerM: 1.1, outputPerM: 4.4, cachedInputPerM: 0.55 },
  'o1': { inputPerM: 15, outputPerM: 60, cachedInputPerM: 7.5 },
  'gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6, cachedInputPerM: 0.075 },
  'gpt-4o': { inputPerM: 2.5, outputPerM: 10, cachedInputPerM: 1.25 },
  'gpt-4-turbo': { inputPerM: 10, outputPerM: 30 },
  'gpt-4': { inputPerM: 30, outputPerM: 60 },
  'gpt-3.5-turbo': { inputPerM: 0.5, outputPerM: 1.5 },
  // Anthropic (per 1M; opus/sonnet/haiku families incl. 3.5–4.5)
  'claude-opus': { inputPerM: 15, outputPerM: 75, cachedInputPerM: 1.5 },
  'claude-sonnet': { inputPerM: 3, outputPerM: 15, cachedInputPerM: 0.3 },
  'claude-haiku': { inputPerM: 0.8, outputPerM: 4, cachedInputPerM: 0.08 },
  'claude-3-5-sonnet': { inputPerM: 3, outputPerM: 15, cachedInputPerM: 0.3 },
  'claude-3-5-haiku': { inputPerM: 0.8, outputPerM: 4, cachedInputPerM: 0.08 },
  // Google
  'gemini-2.5-pro': { inputPerM: 1.25, outputPerM: 10 },
  'gemini-2.5-flash': { inputPerM: 0.3, outputPerM: 2.5 },
  'gemini': { inputPerM: 0.3, outputPerM: 2.5 },
  // Meta
  'llama': { inputPerM: 0.35, outputPerM: 0.4 },
  // DeepSeek (OpenRouter-style; distinct cache price honored when reported)
  'deepseek': { inputPerM: 0.27, outputPerM: 1.1, cachedInputPerM: 0.07 },
  'mistral': { inputPerM: 0.5, outputPerM: 1.5 },
  'qwen': { inputPerM: 0.4, outputPerM: 1.2 },
};

const DEFAULT_PRICING: Pricing = { inputPerM: 1, outputPerM: 3 };

export function pricingFor(model: string): Pricing {
  const m = model.toLowerCase();
  // Longest key wins so 'gpt-4o-mini' matches before 'gpt-4o'.
  const key = Object.keys(PRICING)
    .filter((k) => m.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? PRICING[key] : DEFAULT_PRICING;
}

/**
 * Cost of one completion from provider-reported usage. Falls back to a
 * chars÷4 estimate for either side that's missing. Cached input tokens are
 * billed at the model's cache rate when it has one (default: half price).
 */
export function costFromUsage(
  model: string,
  usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number } | undefined,
  inputChars: number,
  outputChars: number,
): number {
  const p = pricingFor(model);
  const inTok = usage?.inputTokens ?? estimateTokens('x'.repeat(Math.max(0, inputChars)));
  const outTok = usage?.outputTokens ?? estimateTokens('x'.repeat(Math.max(0, outputChars)));
  const cached = Math.min(usage?.cachedTokens ?? 0, inTok);
  const freshIn = inTok - cached;
  const cachedRate = p.cachedInputPerM ?? p.inputPerM / 2;
  return (
    (freshIn / 1_000_000) * p.inputPerM +
    (cached / 1_000_000) * cachedRate +
    (outTok / 1_000_000) * p.outputPerM
  );
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
  if (m.includes('gpt-5') || m.includes('gpt-4.1') || m.includes('o3') || m.includes('o4') || m.includes('o1')) return 200_000;
  if (m.includes('gpt-4o')) return 128_000;
  if (m.includes('gpt-4-turbo')) return 128_000;
  if (m.includes('gpt-4')) return 8_192;
  if (m.includes('gpt-3.5')) return 16_385;
  if (m.includes('claude-3') || m.includes('claude-opus') || m.includes('claude-sonnet') || m.includes('claude-haiku')) {
    return 200_000;
  }
  if (m.includes('gemini-2.5') || m.includes('gemini-1.5')) return 1_000_000;
  if (m.includes('llama') || m.includes('mistral') || m.includes('qwen')) return 32_000;
  if (m.includes('deepseek')) return 128_000;
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
