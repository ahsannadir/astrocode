import type { AIProvider } from '../types.js';
import { OpenaiProvider } from './openai.js';
import { LocalProvider } from './local.js';
import type { AppConfig } from '../types.js';

/**
 * Factory that returns the right provider. Falls back to the local
 * demo provider when no API key is configured (or --demo is passed),
 * so the TUI is fully usable out of the box.
 */
export function createProvider(config: AppConfig): AIProvider {
  // A keyless 'openai-compatible' endpoint with a saved base URL + model
  // (e.g. Ollama, LM Studio) is a real connection — not demo mode.
  const keylessCustom =
    config.provider === 'openai-compatible' &&
    !!config.baseUrl &&
    !!config.model;
  if (config.demo || (!config.apiKey && !keylessCustom)) {
    return new LocalProvider(config.model);
  }
  return new OpenaiProvider({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    provider: config.provider,
  });
}
