/**
 * Provider registry for the /login + /models flows.
 *
 * Every provider here exposes an OpenAI-compatible `POST /chat/completions`
 * endpoint (Anthropic's OpenAI-compatibility layer maps to the Messages API),
 * so a single streaming client serves all of them.
 */

export interface ProviderInfo {
  id: string;
  name: string;
  tagline: string;
  baseUrl: string;
  defaultModel: string;
  models: string[];
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    tagline: 'GPT-4o, GPT-4.1 & o-series reasoning models',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    models: [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      'gpt-4-turbo',
      'o3-mini',
      'o4-mini',
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    tagline: 'Claude Opus, Sonnet & Haiku',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-20250514',
    models: [
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
      'claude-3-7-sonnet-20250219',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
    ],
  },
  {
    id: 'inferx',
    name: 'InferX',
    tagline: 'OpenAI-compatible inference API — DeepSeek & more',
    baseUrl: 'https://model.inferx.net/endpoints/v1',
    defaultModel: 'deepseek-v4-flash',
    models: ['deepseek-v4-flash'],
  },
  {
    id: 'agentrouter',
    name: 'AgentRouter',
    tagline: 'GPT-5.6 Sol, Claude Opus & more through one key',
    // OpenAI-compatible endpoint per https://agentrouter.org/docs (NOT the
    // co.agentrouter.org portal host, which is a different service).
    baseUrl: 'https://agentrouter.org/v1',
    defaultModel: 'gpt-5.6-sol',
    // Model IDs available on the user's AgentRouter account.
    models: ['gpt-5.6-sol', 'claude-opus-4-8', 'claude-opus-5'],
  },
  {
    id: 'zenmux',
    name: 'ZenMux',
    tagline: 'OpenAI-compatible gateway — DeepSeek, GLM, Qwen, Kimi…',
    baseUrl: 'https://zenmux.ai/api/v1',
    defaultModel: 'deepseek/deepseek-v4-flash-free',
    models: [
      // Free (0.00 $/1M tokens) — verified against https://zenmux.ai/api/v1/models.
      'deepseek/deepseek-v4-flash-free',
      'z-ai/glm-4.7-flash-free',
      'z-ai/glm-4.6v-flash-free',
      // Paid
      'deepseek/deepseek-v4-flash',
      'qwen/qwen3.8-max',
      'qwen/qwen3.7-flash',
      'anthropic/claude-opus-5',
      'anthropic/claude-sonnet-5',
      'moonshotai/kimi-k3',
      'z-ai/glm-4.7',
    ],
  },
  {
    id: 'tokenrouter',
    name: 'TokenRouter',
    tagline: 'One key that routes to OpenAI, Claude, Gemini, DeepSeek…',
    baseUrl: 'https://api.tokenrouter.io/v1',
    defaultModel: 'auto:balance',
    models: [
      // Routing modes — TokenRouter picks the best provider per request
      // (balance, cost, quality, or latency).
      'auto:balance',
      'auto:cost',
      'auto:quality',
      'auto:latency',
      // Direct model IDs — passed through to the routed provider.
      'moonshotai/kimi-k3-free',
      'gpt-4o',
      'claude-3.7-sonnet',
      'gemini-2.5-flash',
      'deepseek-chat',
      'mistral-large',
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    tagline: 'One key for every model — OpenAI, Claude, Gemini, Llama…',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o',
    models: [
      // Free (0.00 $/1M tokens) — great for trying things out.
      // Verified against https://openrouter.ai/api/v1/models (pricing 0/0).
      'openrouter/free', // auto-routes to the best available free model
      'google/gemma-4-31b-it:free',
      'google/gemma-4-26b-a4b-it:free',
      'openai/gpt-oss-20b:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      'nvidia/nemotron-3-nano-30b-a3b:free',
      'nvidia/nemotron-nano-12b-v2-vl:free',
      'nvidia/nemotron-nano-9b-v2:free',
      'cohere/north-mini-code:free',
      'poolside/laguna-s-2.1:free',
      'poolside/laguna-xs-2.1:free',
      'inclusionai/ling-3.0-tiny:free',
      // Paid
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'anthropic/claude-3.7-sonnet',
      'anthropic/claude-3.5-sonnet',
      'google/gemini-2.5-flash',
      'meta-llama/llama-3.3-70b-instruct',
      'deepseek/deepseek-chat',
      'mistralai/mistral-large',
    ],
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI Compatible',
    tagline: 'Any /chat/completions endpoint — vLLM, Ollama, LM Studio, LocalAI…',
    // Filled in by the /login flow: the user types the base URL, the model
    // list is fetched live from GET <baseUrl>/models (or typed manually).
    baseUrl: '',
    defaultModel: '',
    models: [],
  },
];

/** Look up a provider by id, falling back to OpenAI for unknown/missing ids. */
export function providerById(id?: string | null): ProviderInfo {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}
