/**
 * Bounded sub-agent runner for AstroCode.
 *
 * The main agent can delegate exploration to small, purpose-built child
 * agents (`researcher`, `file-picker`, `code-searcher`, `reviewer`) via the
 * `spawn_agent` tool. Each sub-agent gets a fresh, compact conversation, a
 * restricted tool set, and hard turn/time/report budgets — it runs its own
 * mini agentic loop and reports a single concise final answer back to the
 * main agent.
 *
 * Sub-agents are deliberately read-only: mutating tools (`write_file`,
 * `edit_file`, `multi_edit`, `todo`) and `spawn_agent` itself are excluded
 * by the caller, so delegation can never edit the repo or clobber the
 * session task list. In plan mode the caller additionally restricts every
 * sub-agent to the read-only tool set. (The `reviewer` role keeps
 * `run_command` so it can run tests; it is told to use it only for
 * non-destructive read/test/build commands.)
 *
 * Note: the wall-clock timeout aborts the sub-agent's provider stream.
 * Tool calls execute through the caller's `runTool` and are self-bounded
 * (each tool has its own timeout), so total runtime can exceed `timeoutMs`
 * by the longest in-flight tool call — acceptable, but by design.
 */
import type {
  AIProvider,
  ChatMessage,
  ToolSchema,
  ToolResult,
} from './types.js';

export interface SubAgentRole {
  /** Short human description (used in the tool schema). */
  description: string;
  /** Tool names this role may use (intersected with hard exclusions + plan mode). */
  tools: string[];
  /** Role-specific system-prompt guidance. */
  prompt: string;
}

export const SUBAGENT_ROLES: Record<string, SubAgentRole> = {
  researcher: {
    description: 'General exploration & documentation research (read-only)',
    tools: [
      'read_file',
      'list_dir',
      'search_files',
      'git_status',
      'git_diff',
      'repomap',
      'fetch_url',
    ],
    prompt:
      'You are a RESEARCH sub-agent. Explore the workspace and/or web to answer the task ' +
      'with evidence from real tool output. Prefer the repo map and targeted reads over ' +
      'guessing. Your final report should state concrete findings (file paths, symbols, ' +
      'relevant docs) and flag anything that could not be determined.',
  },
  'file-picker': {
    description: 'Find files relevant to a task (read-only)',
    tools: ['read_file', 'list_dir', 'search_files', 'repomap'],
    prompt:
      'You are a FILE-FINDING sub-agent. Locate the files most relevant to the task and ' +
      'report a short ranked list of paths (relative to the workspace) with a one-line ' +
      'reason for each. Prefer the repo map to orient, then list/search to confirm. Do ' +
      'not dump file contents unless asked.',
  },
  'code-searcher': {
    description: 'Grep-style code search & targeted reads (read-only)',
    tools: ['search_files', 'read_file', 'list_dir'],
    prompt:
      'You are a CODE-SEARCH sub-agent. Use search_files to find matching lines and ' +
      'read_file to pull surrounding context. Report exact file:line references with ' +
      'short quoted snippets, grouped by concern. Note when a search yields no matches.',
  },
  reviewer: {
    description: 'Review code & run tests/lint (read-only + run_command)',
    tools: [
      'read_file',
      'list_dir',
      'search_files',
      'git_status',
      'git_diff',
      'repomap',
      'run_command',
    ],
    prompt:
      'You are a REVIEW sub-agent. Inspect the changes (git diff/status) and relevant ' +
      'code, and run the project’s tests/lint/typecheck via a run_command call when appropriate ' +
      '(detect from package.json, Makefile, Cargo.toml, or go.mod). Report concrete ' +
      'problems (bugs, style, tests) with file:line references, plus anything verified OK. ' +
      'You have run_command, but use it ONLY for non-destructive read/test/build commands ' +
      '— never commit, never write or install anything. Your report is what the main ' +
      'agent acts on.',
  },
};

export const SUBAGENT_ROLE_NAMES: string[] = Object.keys(SUBAGENT_ROLES);

/**
 * Live progress events emitted by a running sub-agent, so the TUI can show
 * the role, a spinner, and tool actions as they happen.
 */
export type SubAgentEvent =
  | { type: 'start'; role: string; task: string }
  | { type: 'tool'; tool: string }
  | { type: 'done'; turns: number; actions: number };

export interface SubAgentOptions {
  /** The precise task for the sub-agent. */
  task: string;
  /** Role name — must be a key of SUBAGENT_ROLES. */
  role: string;
  /** Workspace the sub-agent operates in. */
  cwd: string;
  /** Provider used for the sub-agent\u2019s own completions. */
  provider: AIProvider;
  /** Tool schemas the sub-agent may call (pre-filtered by the caller). */
  tools: ToolSchema[];
  /** Executes one tool call; returns its result text. */
  runTool: (name: string, args: string) => Promise<ToolResult>;
  /** Hard cap on loop iterations (default 6). */
  maxTurns?: number;
  /** Cap on the final report length in chars (default 12_000). */
  maxReportChars?: number;
  /** Wall-clock timeout in ms (default 90_000). */
  timeoutMs?: number;
  /** Optional cost accounting callback (input text, output text). */
  onCharge?: (input: string, output: string) => void;
  /** Optional live-progress callback (start/tool/done). */
  onEvent?: (e: SubAgentEvent) => void;
}

export interface SubAgentResult {
  ok: boolean;
  /** The labeled, bounded report returned to the main agent. */
  text: string;
  turns: number;
  actions: number;
}

const DEFAULTS = {
  maxTurns: 6,
  maxReportChars: 12_000,
  timeoutMs: 90_000,
} as const;

/**
 * Run one bounded sub-agent. The sub-agent gets a fresh system+user
 * conversation, loops on tool calls against its restricted tool set, and
 * returns a single labeled report. Never throws — failures are folded into
 * the report text so the main agent loop keeps going.
 */
export async function runSubAgent(opts: SubAgentOptions): Promise<SubAgentResult> {
  const maxTurns = Math.max(1, Math.min(opts.maxTurns ?? DEFAULTS.maxTurns, 20));
  const maxReportChars = opts.maxReportChars ?? DEFAULTS.maxReportChars;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const role = SUBAGENT_ROLES[opts.role] ?? SUBAGENT_ROLES.researcher;
  const toolNames = opts.tools.map((t) => t.function.name);

  const systemPrompt =
    `You are a ${opts.role} sub-agent of AstroCode, dispatched by the main agent to help with a task. ` +
    `You operate in the workspace at: ${opts.cwd}\n\n` +
    `${role.prompt}\n\n` +
    `Tools available to you (ONLY these): ${toolNames.join(', ') || '(none)'}\n` +
    `Rules:\n` +
    `1. Use your tools to gather facts, then produce ONE concise final report in plain text — ` +
    `no preamble such as "here is my report".\n` +
    `2. Never fabricate file contents or command output.\n` +
    `3. You cannot edit files; if the task needs edits, say so in the report.\n` +
    `4. Stay focused and efficient — if you hit your turn budget, report what you have so far.\n` +
    `Your report is returned verbatim to the main agent, so end with the key findings and any recommended next steps.`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: opts.task },
  ];

  opts.onEvent?.({ type: 'start', role: opts.role, task: opts.task });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let turns = 0;
  let actions = 0;
  let interrupted = false;
  let completed = false;
  let failed: string | null = null;
  const actionLog: string[] = [];
  let finalText = '';

  try {
    while (turns < maxTurns) {
      turns++;
      const inputSnapshot = messages
        .map((m) => m.content ?? (m.tool_calls ? JSON.stringify(m.tool_calls) : ''))
        .join('\n');
      let outputText = '';

      let result: ChatMessage;
      try {
        result = await opts.provider.streamComplete({
          messages,
          tools: opts.tools,
          signal: controller.signal,
          onToken: (frag) => {
            if (frag.type === 'text' && frag.text) outputText += frag.text;
          },
        });
      } catch (e: any) {
        if (controller.signal.aborted || e?.name === 'AbortError') {
          interrupted = true;
          finalText = outputText;
          break;
        }
        // Provider/network failure: fold into the report, don't crash the loop.
        failed = String(e?.message ?? e);
        finalText = outputText;
        break;
      }

      opts.onCharge?.(inputSnapshot, outputText);

      if (result.tool_calls && result.tool_calls.length > 0) {
        messages.push({ role: 'assistant', content: null, tool_calls: result.tool_calls });
        for (const call of result.tool_calls) {
          actions++;
          actionLog.push(call.name);
          opts.onEvent?.({ type: 'tool', tool: call.name });
          const res = await opts.runTool(call.name, call.arguments);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: res.text,
          });
        }
        continue;
      }

      completed = true;
      finalText = result.content ?? outputText;
      break;
    }
  } finally {
    clearTimeout(timer);
  }

  // Resolve the report body from how the loop ended.
  if (interrupted) {
    finalText =
      (finalText || '(no output produced)') +
      '\n\n(sub-agent was interrupted by the timeout)';
  } else if (failed) {
    finalText = `(sub-agent failed: ${failed})` + (finalText ? `\n${finalText}` : '');
  } else if (!completed && turns >= maxTurns) {
    // Salvage: the sub-agent burned its budget on tool calls without ever
    // emitting a final report. Give it ONE more provider call with no tools
    // so it must answer in plain text — a report grounded in everything it
    // just did beats "(no final report)" ("make agents prove the work is
    // done" — Cheesecake Labs). Never throws: falls back to the placeholder.
    // The main timeout timer was already cleared in the finally block above,
    // so arm a fresh, shorter one — a salvage call must never hang.
    const salvageController = new AbortController();
    const salvageTimer = setTimeout(() => salvageController.abort(), 20_000);
    try {
      messages.push({
        role: 'user',
        content:
          `Your turn budget is exhausted. Do not call any more tools. ` +
          `Write your final report NOW based on everything you gathered above.`,
      });
      const salvage = await opts.provider.streamComplete({
        messages,
        tools: [],
        signal: salvageController.signal,
        onToken: (frag) => {
          if (frag.type === 'text' && frag.text) finalText += frag.text;
        },
      });
      finalText = (salvage.content ?? finalText) || finalText;
      finalText += `\n\n(sub-agent reached its ${maxTurns}-turn budget; report salvaged from tool activity)`;
    } catch {
      if (!finalText) {
        finalText = `(sub-agent exhausted its ${maxTurns}-turn budget without producing a final report)`;
      } else {
        finalText += `\n\n(sub-agent reached its ${maxTurns}-turn budget)`;
      }
    }
    clearTimeout(salvageTimer);
  }

  if (finalText.length > maxReportChars) {
    finalText =
      finalText.slice(0, maxReportChars) + `\n…[report truncated at ${maxReportChars} chars]`;
  }

  const summary =
    `Sub-agent "${opts.role}" report — ${turns} turn(s), ${actions} action(s)` +
    `${actionLog.length > 0 ? `: ${actionLog.join(', ')}` : ''}\n`;

  opts.onEvent?.({ type: 'done', turns, actions });
  return { ok: true, text: summary + finalText, turns, actions };
}
