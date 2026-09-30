/**
 * Headless one-shot agent runs (`astrocode -p "task"`).
 *
 * Extracts the agent loop from the TUI into a reusable engine so `-p` mode
 * and the interactive app execute the SAME code: system-prompt building,
 * the turn loop with auto-compaction, plan-mode gating, loop sensing,
 * verification with error feedback, budget checks, and real provider usage
 * accounting. Headless adds: stdin passthrough, a compact text transcript,
 * optional JSON output (--json), and session resume (--continue/-c).
 *
 * Exit codes: 0 = the agent's final answer said nothing failed, 1 = the
 * provider/loop errored, 2 = verification ran and failed. Piping
 * (`astrocode -p 'explain' | head`) works because output is plain text.
 */
import type {
  AIProvider,
  AppConfig,
  ChatMessage,
  PlanMode,
} from './types.js';
import { executeTool, getToolSchemas, PLAN_ALLOWED_TOOLS } from './tools/registry.js';
import type { ToolProgressEvent } from './tools/registry.js';
import type { ApprovalGate } from './approval.js';
import { compactConversation } from './compact.js';
import { costFromUsage, contextLimitFor, formatCost, estimateContextTokens } from './cost.js';
import { LoopSensor } from './loopsensor.js';
import { runVerify } from './verify.js';

/** Where per-project memory + repo map come from (injected by callers). */
export interface HeadlessContextSources {
  memoryText?: string;
  repoMapText?: string;
}

export interface RunTurnOptions {
  config: AppConfig;
  cwd: string;
  provider: AIProvider;
  /** Conversation so far (mutated in place; caller owns persistence). */
  conversation: ChatMessage[];
  mode?: PlanMode;
  approvalGate?: ApprovalGate;
  sources?: HeadlessContextSources;
  /** Include the current todo list in the system prompt (TUI parity). */
  includeTodos?: boolean;
  /** Pre-rendered skills catalog block (from skillsPromptBlock()). */
  skillsBlock?: string;
  maxFixAttempts?: number;
  onEvent?: (e: { type: 'text' | 'tool_start' | 'tool_result'; text: string }) => void;
  onProgress?: (e: ToolProgressEvent) => void;
  /** Called with each completion's real (or estimated) cost delta. */
  onCharge?: (deltaUsd: number, usageIn: number, usageOut: number) => void;
}

export interface TurnResult {
  ok: boolean;
  text: string;
  turns: number;
  costUsd: number;
  /** Real provider usage summed across the turn's completions, when reported. */
  usage?: { inputTokens: number; outputTokens: number };
  verifyOk?: boolean;
}

/**
 * Build the mode-aware system prompt. Shared by the TUI and headless mode so
 * `-p` behaves identically (memory + repo map + skills catalog + task list).
 */
export function buildSystemPromptShared(
  opts: RunTurnOptions,
  mode: PlanMode,
  skillsBlock?: string,
  todosBlock?: string,
): string {
  const parts: string[] = [opts.config.systemPrompt];
  const mem = opts.sources?.memoryText;
  if (mem) parts.push(`\n\n## Project memory\n${mem}`);
  const rm = opts.sources?.repoMapText;
  if (rm) parts.push(`\n\n## Workspace map\n${rm}`);
  const skills = opts.skillsBlock;
  if (skills) parts.push(skills);
  const todos = todosBlock;
  if (todos) parts.push(`\n\n## Current task list\n${todos}`);
  if (mode === 'plan') {
    parts.push(
      `\n\nYou are currently in PLAN mode. Produce a clear, concise plan for the requested task before any implementation.`,
      `\nYou may ONLY use read-only tools (read_file, list_dir, search_files, git_status, git_diff, repomap, fetch_url) and the todo tool.`,
      `\nDo NOT attempt to write/edit files or run mutating commands — they are blocked.`,
      `\nEnd your reply with a numbered plan starting with "## Plan".`,
    );
  } else {
    parts.push(
      `\n\nYou are currently in ACT mode: you have full access to read, write, edit, and run commands. Implement the task.`,
      `\nIf the user earlier produced a plan, follow it.`,
    );
  }
  return parts.join('');
}

/**
 * Run ONE agent turn (user message already in `conversation`) to completion:
 * stream the model, execute tool batches, feed verify failures back, honor
 * budget + context limits. Returns the final assistant text.
 */
export async function runAgentTurn(opts: RunTurnOptions): Promise<TurnResult> {
  const {
    config,
    cwd,
    provider,
    conversation,
  } = opts;
  const mode = opts.mode ?? 'act';
  const maxTurns = config.maxToolTurns || 20;
  const maxFixAttempts = opts.maxFixAttempts ?? 2;
  let turns = 0;
  let fixAttempts = 0;
  let costUsd = 0;
  let usageIn = 0;
  let usageOut = 0;
  let sawUsage = false;
  let verifyOk: boolean | undefined;
  let finalText = '';

  // One loop sensor for the WHOLE turn (parity with the TUI loop): repeated
  // identical tool calls across iterations are nudged (3rd) then blocked
  // with a cached-result replay (6th).
  const sensor = new LoopSensor();

  const charge = (inputChars: number, outputChars: number, usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number }) => {
    const delta = costFromUsage(config.model, usage, inputChars, outputChars);
    costUsd += delta;
    if (usage) {
      sawUsage = true;
      usageIn += usage.inputTokens ?? 0;
      usageOut += usage.outputTokens ?? 0;
    }
    opts.onCharge?.(delta, usage?.inputTokens ?? 0, usage?.outputTokens ?? 0);
  };

  while (turns < maxTurns) {
    const messagesForAgent: ChatMessage[] = [
      { role: 'system', content: buildSystemPromptShared(opts, mode) },
      ...conversation,
    ];

    // Budget gate before each request.
    if (config.budget > 0 && costUsd >= config.budget) {
      return {
        ok: false,
        text: `Spend budget reached (${formatCost(costUsd)} ≥ ${formatCost(config.budget)}).`,
        turns,
        costUsd,
        ...(sawUsage ? { usage: { inputTokens: usageIn, outputTokens: usageOut } } : {}),
      };
    }

    // Auto-compaction near the context ceiling (same policy as the TUI).
    const ctxLimit = contextLimitFor(config.model);
    const ctxUsed = estimateContextTokens(messagesForAgent);
    if (ctxUsed >= ctxLimit * 0.85) {
      const r = compactConversation(conversation);
      if (r.messages.length < conversation.length || r.charsAfter < r.charsBefore) {
        conversation.length = 0;
        conversation.push(...r.messages);
      }
    }

    turns++;
    const inputSnapshot = messagesForAgent
      .map((m) => m.content ?? (m.tool_calls ? JSON.stringify(m.tool_calls) : ''))
      .join('\n');
    let outputText = '';

    const result = await provider.streamComplete({
      messages: messagesForAgent,
      tools: getToolSchemas(),
      onToken: (frag) => {
        if (frag.type === 'text' && frag.text) {
          outputText += frag.text;
          opts.onEvent?.({ type: 'text', text: frag.text });
        }
      },
    });
    charge(inputSnapshot.length, outputText.length, result.usage);

    if (result.tool_calls && result.tool_calls.length > 0) {
      conversation.push({ role: 'assistant', content: null, tool_calls: result.tool_calls });
      for (const call of result.tool_calls) {
        opts.onEvent?.({ type: 'tool_start', text: call.name });
        // Plan mode: block mutating tools exactly like the TUI does.
        if (mode === 'plan' && !PLAN_ALLOWED_TOOLS.has(call.name)) {
          const blocked = `Blocked in PLAN mode: "${call.name}" is not a read-only tool.\nSwitch to ACT mode to make changes.`;
          conversation.push({
            role: 'tool',
            tool_call_id: call.id || 'plan_block',
            name: call.name,
            content: blocked,
          });
          opts.onEvent?.({ type: 'tool_result', text: blocked });
          continue;
        }
        const res = await executeTool(call.name, call.arguments, {
          cwd,
          mode,
          provider,
          loopSensor: sensor,
          approvalGate: opts.approvalGate,
          onProgress: opts.onProgress,
        });
        conversation.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: res.text,
        });
        opts.onEvent?.({ type: 'tool_result', text: res.text });
      }
      continue;
    }

    if (result.content) {
      conversation.push({ role: 'assistant', content: result.content });
    }
    finalText = result.content ?? outputText;

    // Verification with bounded fix-feedback (parity with the TUI loop).
    if (config.verify) {
      const { changesSinceLastBoundary } = await import('./undo.js');
      const changed = changesSinceLastBoundary() > 0;
      if (changed) {
        const v = await runVerify(cwd);
        verifyOk = v.ok;
        if (!v.ok && fixAttempts < maxFixAttempts) {
          fixAttempts++;
          conversation.push({
            role: 'user',
            content:
              `Your changes did not pass verification. Fix ALL of the reported issues, ` +
              `then re-run the checks yourself until they pass.\n\n${v.text}`,
          });
          opts.onEvent?.({ type: 'tool_result', text: `⤾ verify failed — feeding errors back (attempt ${fixAttempts}/${maxFixAttempts})` });
          continue;
        }
        opts.onEvent?.({ type: 'tool_result', text: v.text });
      }
    }
    break;
  }

  // Post-loop budget check: the last completion can push us over the ceiling
  // even though every REQUEST was gated — the run still blew the budget.
  if (config.budget > 0 && costUsd >= config.budget) {
    return {
      ok: false,
      text: finalText || `Spend budget reached (${formatCost(costUsd)} ≥ ${formatCost(config.budget)}).`,
      turns,
      costUsd,
      ...(sawUsage ? { usage: { inputTokens: usageIn, outputTokens: usageOut } } : {}),
      ...(verifyOk !== undefined ? { verifyOk } : {}),
    };
  }

  return {
    ok: verifyOk === undefined ? true : verifyOk,
    text: finalText,
    turns,
    costUsd,
    ...(sawUsage ? { usage: { inputTokens: usageIn, outputTokens: usageOut } } : {}),
    ...(verifyOk !== undefined ? { verifyOk } : {}),
  };
}

/** ── stdin passthrough ─────────────────────────────────────────────── */
export function readStdinIfPiped(timeoutMs = 250): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const timer = setTimeout(() => {
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.pause();
      resolve(data);
    }, timeoutMs);
    process.stdin.on('data', (chunk) => {
      data += String(chunk);
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

export interface HeadlessOptions {
  config: AppConfig;
  cwd: string;
  prompt: string;
  mode?: PlanMode;
  resume?: ChatMessage[] | null;
  json?: boolean;
  quiet?: boolean;
  approvalGate?: ApprovalGate;
}

export interface HeadlessOutcome {
  exitCode: number;
  answer: string;
  costUsd: number;
}

/**
 * Execute one headless turn and print the transcript. Returns the process
 * exit code (see module docblock). Pure enough to unit-test with a fake
 * provider; the CLI wrapper in index.tsx just calls this and exits.
 */
export async function runHeadless(opts: HeadlessOptions): Promise<HeadlessOutcome> {
  const { createProvider } = await import('./ai/provider.js');
  const { loadMemory } = await import('./memory.js');
  const { buildRepoMap } = await import('./repomap.js');
  const { skillsPromptBlock, loadSkills } = await import('./skills.js');

  const provider = createProvider(opts.config);
  const [{ text: memoryText }, map, skillsCatalog] = await Promise.all([
    loadMemory(opts.cwd),
    buildRepoMap(opts.cwd),
    loadSkills(opts.cwd),
  ]);

  // In --json mode NOTHING but the JSON document may reach stdout (the
  // streamed transcript would corrupt it for `jq`); quiet suppresses all.
  const write = (s: string) => {
    if (!opts.quiet && !opts.json) process.stdout.write(s);
  };

  const conversation: ChatMessage[] = [...(opts.resume ?? [])];
  conversation.push({ role: 'user', content: opts.prompt });

  const result = await runAgentTurn({
    config: opts.config,
    cwd: opts.cwd,
    provider,
    conversation,
    mode: opts.mode ?? 'act',
    approvalGate: opts.approvalGate,
    sources: { memoryText, repoMapText: map.text },
    ...(skillsCatalog ? { skillsBlock: skillsPromptBlock() } : {}),
    onEvent: (e) => {
      if (e.type === 'text') write(e.text);
      else if (e.type === 'tool_start') write(`· ${e.text}\n`);
      // tool_result bodies stay out of stdout (noise); they're in --json.
    },
  });

  const answer = result.text || '(no final answer produced)';
  // Emit the JSON document LAST and ONLY when json mode is on.
  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: result.ok,
          answer: result.text,
          turns: result.turns,
          costUsd: result.costUsd,
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.verifyOk !== undefined ? { verifyOk: result.verifyOk } : {}),
          messages: conversation,
        },
        null,
        2,
      ) + '\n',
    );
  } else if (!opts.quiet && !opts.json) {
    write('\n');
    write(
      `\n─ ${result.turns} turn(s) · ${formatCost(result.costUsd)}` +
        (result.usage ? ` · ${result.usage.inputTokens}→${result.usage.outputTokens} tok` : '') +
        (result.verifyOk === false ? ' · verify FAILED' : '') +
        '\n',
    );
  }

  const exitCode = result.ok ? (result.verifyOk === false ? 2 : 0) : 1;
  return { exitCode, answer, costUsd: result.costUsd };
}
