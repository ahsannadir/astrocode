/**
 * Pure routing helpers for the /login popup (LoginModal).
 *
 * The rule these encode: a user who already connected an 'OpenAI Compatible'
 * endpoint should not be marched through the base URL → key → model wizard
 * again. Picking that provider offers "Use existing configuration" first,
 * with "Configure again" one row below it. Split out — and pure — so both the
 * branch and the row set are testable without a terminal
 * (tests/loginFlow.test.ts).
 */

/** The saved custom endpoint the /login flow can offer to reuse. */
export interface ExistingCustomConfig {
  baseUrl: string;
  model: string;
}

/** The provider id whose configuration is stored in the auth file, not the registry. */
export const CUSTOM_PROVIDER_ID = 'openai-compatible';

/** The whole row set of the reuse prompt, in render order. */
export const REUSE_ROWS = ['use-existing', 'configure-again'] as const;
export type ReuseRow = (typeof REUSE_ROWS)[number];

/** The reuse row at `index`, or null when the index is out of range. */
export function reuseRowAt(index: number): ReuseRow | null {
  return REUSE_ROWS[index] ?? null;
}

/** Move the reuse-prompt highlight with wrap-around. */
export function moveReuseSel(sel: number, dir: 1 | -1): number {
  return (sel + dir + REUSE_ROWS.length) % REUSE_ROWS.length;
}

/** Where this kind of provider row leads. */
export type ProviderEntryStage = 'existing' | 'baseurl' | 'key';

/**
 * Where Enter on the highlighted provider row goes: straight to the reuse
 * prompt when a custom endpoint is already saved, otherwise the usual wizard
 * (API key for the hosted providers, base URL for the custom one).
 */
export function providerEntryStage(providerId: string, hasExisting: boolean): ProviderEntryStage {
  if (providerId !== CUSTOM_PROVIDER_ID) return 'key';
  return hasExisting ? 'existing' : 'baseurl';
}

/**
 * The saved custom endpoint worth offering for reuse, or null when there is
 * nothing to reuse. Deliberately reads the auth file's own fields rather than
 * the resolved runtime config: loadConfig() falls back to
 * 'https://api.openai.com/v1' when the custom provider saved no base URL, and
 * offering that as "your existing configuration" would be a lie.
 */
export function existingCustomConfig(
  stored: { provider?: string; baseUrl?: string; model?: string } | null | undefined,
): ExistingCustomConfig | null {
  if (!stored || stored.provider !== CUSTOM_PROVIDER_ID) return null;
  const baseUrl = (stored.baseUrl ?? '').trim();
  if (!baseUrl) return null;
  return { baseUrl, model: (stored.model ?? '').trim() };
}
