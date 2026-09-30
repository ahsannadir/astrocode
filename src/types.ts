/**
 * Shared types for AstroCode.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** Interaction mode: plan (read-only) or act (full access). */
export type PlanMode = 'plan' | 'act';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // raw JSON string
}

export interface ChatMessage {
  role: Role;
  content?: string | null;
  tool_calls?: ToolCall[] | null;
  tool_call_id?: string | null;
  name?: string | null;
}

export interface ToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: Record<string, unknown>;
}

export interface ToolFunctionSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameterProperty>;
    required?: string[];
  };
}

export interface ToolSchema {
  type: 'function';
  function: ToolFunctionSchema;
}

export interface ToolResult {
  ok: boolean;
  text: string;
}

export interface TokenFragment {
  type: 'text' | 'tool_args';
  text?: string; // for text
  id?: string; // for tool_args
  name?: string; // for tool_args
  delta?: string; // for tool_args
}

/**
 * Token usage reported by the provider for one completion. Real numbers beat
 * the chars÷4 estimate: cost math, the context meter, and budget enforcement
 * all use this when present (falling back to estimation otherwise).
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the provider's prompt cache (billed at a discount). */
  cachedTokens?: number;
}

export interface StreamOptions {
  messages: ChatMessage[];
  tools: ToolSchema[];
  onToken: (fragment: TokenFragment) => void;
  signal?: AbortSignal;
}

export interface AIProvider {
  readonly kind: 'openai' | 'local';
  readonly model: string;
  /**
   * Stream one assistant completion. Returns the full assistant message
   * (including any tool_calls). Text deltas are emitted via onToken.
   * `usage` carries the provider's real token counts when it reports them
   * (undefined for providers that don't, e.g. the offline demo provider).
   */
  streamComplete(options: StreamOptions): Promise<ChatMessage & { usage?: TokenUsage }>;
}

export interface AppConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Provider id from providers.ts ('tokenrouter' switches to the Responses API). */
  provider?: string;
  demo: boolean;
  systemPrompt: string;
  maxToolTurns: number;
  /** USD budget ceiling for the session (0 = unlimited). */
  budget: number;
  /** Run detected lint/test/typecheck after the agent edits files (Aider-style). */
  verify: boolean;
  /** Auto-commit the agent's changes after a turn. */
  autocommit: boolean;
  /**
   * Shell approval mode for run_command: 'off' runs everything guarded only
   * by the danger list; 'dangerous' prompts before risky commands; 'all'
   * prompts before every command.
   */
  approvalMode?: 'off' | 'dangerous' | 'all';
  /** Color theme name from tui/theme.ts (applied at startup, /theme changes it). */
  theme?: string;
}
