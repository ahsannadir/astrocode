import type {
  AIProvider,
  ChatMessage,
  StreamOptions,
  TokenFragment,
  TokenUsage,
  ToolCall,
  ToolSchema,
} from '../types.js';

export interface OpenaiProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Provider id from providers.ts — 'tokenrouter' switches to the Responses API. */
  provider?: string;
}

const CLIENT_UA = 'astrocode/1.2.0';

/**
 * Extract token usage from a chat-completions chunk. OpenAI-family servers
 * report it on the FINAL chunk when `stream_options.include_usage` was sent;
 * several compatible gateways include it on every (or the last) chunk.
 * Absent/null/zero usage means unknown — callers fall back to estimation.
 */
export function extractUsage(json: any): TokenUsage | undefined {
  const u = json?.usage;
  if (!u || typeof u !== 'object') return undefined;
  const input = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const output = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  if (input <= 0 && output <= 0) return undefined;
  const cachedRaw =
    u.prompt_tokens_details?.cached_tokens ??
    u.input_tokens_details?.cached_tokens ??
    u.cache_read_input_tokens ??
    u.cache_read_tokens ??
    0;
  const cached = Number(cachedRaw);
  const usage: TokenUsage = { inputTokens: input, outputTokens: output };
  if (Number.isFinite(cached) && cached > 0) usage.cachedTokens = cached;
  return usage;
}

/**
 * User-Agent sent with every request. AgentRouter's gateway fingerprints
 * clients by User-Agent and rejects unrecognized ones ("unauthorized client
 * detected, contact support") — verified that `opencode/0.2` (a client their
 * docs integrate) passes while any custom UA is blocked. Everyone else gets
 * an honest AstroCode UA.
 */
export function userAgentFor(provider?: string, baseUrl?: string): string {
  const isAgentRouter =
    provider === 'agentrouter' ||
    (baseUrl ?? '').toLowerCase().includes('agentrouter.org');
  return isAgentRouter ? 'opencode/0.2' : CLIENT_UA;
}

/**
 * Transient-failure handling. Gateways (OpenRouter, ZenMux, InferX, …) return
 * 429/5xx for rate limits and brief outages; a couple of bounded retries with
 * backoff (honoring `Retry-After` when present) often succeed. Hard caps like
 * a daily free-tier quota just fail again — bounded to MAX_RETRIES so we never
 * hammer an exhausted endpoint.
 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 30_000;

export function shouldRetryStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/** Backoff (ms) before the given 0-based retry attempt, Retry-After aware. */
export function retryDelayMs(
  status: number,
  retryAfter: string | null,
  attempt: number,
): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
    }
    const at = Date.parse(retryAfter); // HTTP-date form
    if (!Number.isNaN(at)) {
      return Math.min(Math.max(0, at - Date.now()), MAX_RETRY_AFTER_MS);
    }
  }
  return Math.min(500 * 2 ** attempt, 4000);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      },
      { once: true },
    );
  });
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
): Promise<Response> {
  let attempt = 0;
  for (;;) {
    const res = await fetch(url, init);
    if (!shouldRetryStatus(res.status) || attempt >= MAX_RETRIES) return res;
    const delay = retryDelayMs(
      res.status,
      res.headers.get('retry-after'),
      attempt,
    );
    await sleep(delay, init.signal ?? undefined);
    attempt++;
  }
}

export interface ModelListResult {
  ok: boolean;
  models: string[];
  /** Human-readable reason when ok is false. */
  error?: string;
}

/**
 * Parse the payload of `GET /models`. The OpenAI shape is `{ data: [{ id }] }`
 * but compatible gateways also appear as `{ models: [...] }` or a bare array,
 * with entries as id strings or objects carrying an `id`/`name`/`model` field.
 * Server order is preserved; duplicates removed.
 */
export function parseModelsResponse(payload: unknown): string[] {
  const obj = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  const raw: unknown[] = Array.isArray(payload)
    ? payload
    : obj && Array.isArray(obj.data)
      ? obj.data
      : obj && Array.isArray(obj.models)
        ? obj.models
        : [];
  const out: string[] = [];
  for (const entry of raw) {
    let id: string | null = null;
    if (typeof entry === 'string') {
      id = entry;
    } else if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      for (const key of ['id', 'name', 'model']) {
        if (typeof e[key] === 'string' && (e[key] as string).trim()) {
          id = e[key] as string;
          break;
        }
      }
    }
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Fetch the model list from an OpenAI-compatible endpoint
 * (`GET <baseUrl>/models`). Used by the /login flow's 'OpenAI Compatible'
 * provider. One attempt with a hard timeout — no retries, it's interactive.
 */
export async function listModels(
  baseUrl: string,
  apiKey?: string,
  timeoutMs = 10_000,
): Promise<ModelListResult> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'User-Agent': CLIENT_UA,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 120);
      return {
        ok: false,
        models: [],
        error: `GET /models → HTTP ${res.status}${body ? ` — ${body}` : ''}`,
      };
    }
    const payload: unknown = await res.json().catch(() => null);
    const models = parseModelsResponse(payload);
    return models.length > 0
      ? { ok: true, models }
      : { ok: false, models: [], error: 'The endpoint returned no models.' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      models: [],
      error: `Could not reach ${url} — ${msg}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Serialize the conversation for the OpenAI **Responses API** (POST
 * /v1/responses) — TokenRouter's only live endpoint. The first system
 * message becomes the top-level `instructions`; the rest map to ordered
 * input items: user/assistant messages, `function_call` items (for our
 * flat internal tool_calls), and `function_call_output` items (tool
 * results, keyed by the call id the assistant emitted).
 */
export function buildResponsesBody(
  messages: ChatMessage[],
  tools: ToolSchema[],
  model: string,
): {
  model: string;
  instructions?: string;
  input: unknown[];
  tools?: ToolSchema[];
  stream: boolean;
  temperature: number;
} {
  const input: unknown[] = [];
  let instructions: string | undefined;
  for (const m of messages) {
    if (m.role === 'system') {
      if (instructions === undefined && m.content) {
        instructions = m.content;
        continue;
      }
      input.push({
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: m.content ?? '' }],
      });
      continue;
    }
    if (m.role === 'user') {
      input.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: m.content ?? '' }],
      });
      continue;
    }
    if (m.role === 'assistant') {
      if (m.content) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: m.content }],
        });
      }
      if (m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.name,
            arguments: tc.arguments || '{}',
          });
        }
      }
      continue;
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id ?? '',
        output: m.content ?? '',
      });
      continue;
    }
  }
  return {
    model,
    instructions,
    input,
    tools: tools.length > 0 ? tools : undefined,
    stream: true,
    temperature: 0.7,
  };
}

/**
 * Build our internal assistant ChatMessage from a Responses API `output`
 * array (the authoritative result on `response.completed`): message items
 * contribute text, `function_call` items become flat tool_calls (call_id
 * preferred over the item id, matching what tool results must reference).
 */
export function assistantFromResponsesOutput(output: unknown[]): ChatMessage {
  let content = '';
  const toolCalls: ToolCall[] = [];
  for (const item of (output ?? []) as any[]) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        const text =
          part?.type === 'output_text' || part?.type === 'input_text'
            ? part?.text
            : undefined;
        if (typeof text === 'string') content += text;
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id:
          item.call_id ||
          item.id ||
          `call_${Math.random().toString(36).slice(2, 10)}`,
        name: item.name || '',
        arguments:
          typeof item.arguments === 'string' && item.arguments
            ? item.arguments
            : '{}',
      });
    }
  }
  const assistant: ChatMessage = { role: 'assistant', content: content || null };
  if (toolCalls.length > 0) {
    assistant.tool_calls = toolCalls;
    assistant.content = null;
  }
  return assistant;
}

/**
 * Normalize messages for the wire: assistant tool calls are stored internally
 * in a flattened shape ({ id, name, arguments }) but the OpenAI-compatible
 * API requires the nested format ({ id, type: "function", function: { name,
 * arguments } }). Several upstream providers (e.g. Darkbloom on OpenRouter)
 * reject the flat form with "assistant tool call requires function".
 */
export function serializeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      return {
        ...m,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
        // Wire shape differs from our internal ToolCall — double cast.
      } as unknown as ChatMessage;
    }
    return m;
  });
}

/**
 * OpenAI-compatible chat completions provider with streaming and
 * function/tool calling. Works with OpenAI, and with any provider that
 * exposes /chat/completions (LocalAI, Ollama via OpenAI bridge, OpenRouter,
 * LM Studio, vLLM, etc.) — just point ASTROCODE_BASE_URL at it.
 */
export class OpenaiProvider implements AIProvider {
  readonly kind = 'openai' as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly provider?: string;

  constructor(opts: OpenaiProviderOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl;
    this.model = opts.model;
    this.provider = opts.provider;
  }

  /** TokenRouter exposes only the Responses API (its /chat/completions route 404s). */
  private get usesResponsesApi(): boolean {
    return (
      this.provider === 'tokenrouter' ||
      this.baseUrl.toLowerCase().includes('tokenrouter')
    );
  }

  async streamComplete(options: StreamOptions): Promise<ChatMessage & { usage?: TokenUsage }> {
    if (this.usesResponsesApi) {
      return this.streamResponses(options);
    }
    const url = `${this.baseUrl}/chat/completions`;
    const body = {
      model: this.model,
      messages: serializeMessages(options.messages),
      tools: options.tools.length > 0 ? options.tools : undefined,
      stream: true,
      // Ask for real usage on the final chunk (OpenAI ignores the extra
      // field; some strict local servers reject unknown fields — those are
      // exactly the ones that report usage on the last chunk anyway).
      stream_options: { include_usage: true },
      temperature: 0.7,
    };

    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'User-Agent': userAgentFor(this.provider, this.baseUrl),
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Provider error ${res.status}: ${detail.slice(0, 500)}`,
      );
    }

    return this.readStream(res.body, options);
  }

  private async readStream(
    stream: ReadableStream<Uint8Array>,
    options: StreamOptions,
  ): Promise<ChatMessage & { usage?: TokenUsage }> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    let content = '';
    let usage: TokenUsage | undefined;
    // Accumulate tool-call fragments keyed by their index in the deltas.
    const toolCallMap = new Map<
      number,
      { id: string; name: string; args: string }
    >();
    let sawToolCalls = false;

    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') break;
          let json: any;
          try {
            json = JSON.parse(payload);
          } catch {
            continue;
          }
          const choice = json.choices && json.choices[0];
          const u = extractUsage(json);
          if (u) usage = u;
          if (!choice) continue;
          const delta = choice.delta || {};
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            content += delta.content;
            options.onToken({ type: 'text', text: delta.content });
          }
          if (Array.isArray(delta.tool_calls)) {
            sawToolCalls = true;
            for (const tc of delta.tool_calls) {
              const entry =
                toolCallMap.get(tc.index) ||
                { id: '', name: '', args: '' };
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name += tc.function.name;
              if (tc.function?.arguments) {
                const d = tc.function.arguments;
                entry.args += d;
                options.onToken({
                  type: 'tool_args',
                  id: entry.id,
                  name: entry.name,
                  delta: d,
                });
              }
              toolCallMap.set(tc.index, entry);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls: ToolCall[] = Array.from(toolCallMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({
        id: v.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        name: v.name,
        arguments: v.args || '{}',
      }));

    const assistant: ChatMessage = { role: 'assistant', content: content || null };
    if (sawToolCalls && toolCalls.length > 0) {
      assistant.tool_calls = toolCalls;
      assistant.content = null;
    }
    return usage ? { ...assistant, usage } : assistant;
  }

  /**
   * Streaming via the Responses API (POST /v1/responses) — TokenRouter's
   * only implemented endpoint. SSE events: `output_text.delta` streams
   * text, `function_call_arguments.delta` streams tool args, and the final
   * `response.completed` payload is the authoritative source for the result.
   */
  private async streamResponses(options: StreamOptions): Promise<ChatMessage & { usage?: TokenUsage }> {
    const url = `${this.baseUrl}/responses`;
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'User-Agent': userAgentFor(this.provider, this.baseUrl),
      },
      body: JSON.stringify(
        buildResponsesBody(options.messages, options.tools, this.model),
      ),
      signal: options.signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Provider error ${res.status}: ${detail.slice(0, 500)}`,
      );
    }

    return this.readResponsesStream(res.body, options);
  }

  private async readResponsesStream(
    stream: ReadableStream<Uint8Array>,
    options: StreamOptions,
  ): Promise<ChatMessage & { usage?: TokenUsage }> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const state = createResponsesStreamState();

    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let json: any;
          try {
            json = JSON.parse(payload);
          } catch {
            continue;
          }
          applyResponsesEvent(state, json, options.onToken);
        }
      }
    } finally {
      reader.releaseLock();
    }

    // The completed payload is authoritative; fall back to streamed state.
    if (state.finalResponse && Array.isArray(state.finalResponse.output)) {
      const assistant = assistantFromResponsesOutput(state.finalResponse.output);
      const usage = extractUsage(state.finalResponse);
      return usage ? { ...assistant, usage } : assistant;
    }
    return this.finalFromStreamState(state);
  }

  /** Build the assistant message from accumulated stream state. */
  private finalFromStreamState(state: ResponsesStreamState): ChatMessage & { usage?: TokenUsage } {
    const toolCalls: ToolCall[] = Array.from(state.callMap.values()).map((v) => ({
      id: v.call_id || `call_${Math.random().toString(36).slice(2, 10)}`,
      name: v.name,
      arguments: v.args || '{}',
    }));
    const assistant: ChatMessage = { role: 'assistant', content: state.content || null };
    if (toolCalls.length > 0) {
      assistant.tool_calls = toolCalls;
      assistant.content = null;
    }
    return assistant;
  }
}

/**
 * Mutable accumulator for Responses-API SSE events. Function calls are keyed
 * by the event's item id (OpenAI sends `item_id` on argument events) with the
 * real `call_id` (what tool outputs reference) stored on the entry.
 */
export interface ResponsesStreamState {
  content: string;
  finalResponse: any;
  callMap: Map<
    string,
    { call_id: string; name: string; args: string }
  >;
}

export function createResponsesStreamState(): ResponsesStreamState {
  return { content: '', finalResponse: null, callMap: new Map() };
}

/**
 * Apply one Responses-API SSE event to the stream state. Exported (pure
 * enough) so the event-handling logic is unit-testable; `onToken` receives
 * live text / tool-arg fragments exactly like the chat-completions path.
 */
export function applyResponsesEvent(
  state: ResponsesStreamState,
  json: any,
  onToken: (fragment: TokenFragment) => void,
): void {
  const type = json.type;
  if (type === 'response.output_text.delta') {
    if (typeof json.delta === 'string') {
      state.content += json.delta;
      onToken({ type: 'text', text: json.delta });
    }
  } else if (type === 'response.output_item.added') {
    const it = json.item;
    if (it?.type === 'function_call') {
      // Key by the item id so argument events (which carry item_id) land on
      // the same entry; remember the real call_id for tool outputs.
      const key = it.id || it.call_id || '';
      const entry = state.callMap.get(key) || {
        call_id: it.call_id || key,
        name: '',
        args: '',
      };
      if (typeof it.name === 'string') entry.name = it.name;
      state.callMap.set(key, entry);
    }
  } else if (type === 'response.function_call_arguments.delta') {
    const key = json.item_id || json.call_id || '';
    const entry = state.callMap.get(key) || {
      call_id: json.call_id || key,
      name: json.name || '',
      args: '',
    };
    if (typeof json.delta === 'string') {
      entry.args += json.delta;
      onToken({
        type: 'tool_args',
        id: key,
        name: entry.name,
        delta: json.delta,
      });
    }
    state.callMap.set(key, entry);
  } else if (type === 'response.function_call_arguments.done') {
    const key = json.item_id || json.call_id || '';
    const entry = state.callMap.get(key) || {
      call_id: json.call_id || key,
      name: json.name || '',
      args: '',
    };
    if (typeof json.arguments === 'string') entry.args = json.arguments;
    state.callMap.set(key, entry);
  } else if (type === 'response.completed' && json.response) {
    state.finalResponse = json.response;
  } else if (type === 'response.failed' || type === 'error') {
    const msg = json.error?.message || json.message || JSON.stringify(json);
    throw new Error(`Provider error: ${msg}`);
  }
}
