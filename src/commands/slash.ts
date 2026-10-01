import type { AppConfig, ChatMessage, PlanMode } from '../types.js';
import { getToolNames, executeTool, PLAN_ALLOWED_TOOLS } from '../tools/registry.js';
import {
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  type SessionData,
} from '../sessions.js';
import { revertLast, undoCount, rewindTurn, changesSinceLastBoundary } from '../undo.js';
import { formatCost, pricingFor, contextLimitFor } from '../cost.js';
import { loadMemory, getMemoryText, getMemorySources, reloadMemory } from '../memory.js';
import { buildRepoMap, getRepoMap } from '../repomap.js';
import { listTodos, clearTodos, todoCounts, todoBlock } from '../todos.js';
import { SUBAGENT_ROLES, SUBAGENT_ROLE_NAMES } from '../subagent.js';
import { getAgentHistory } from '../agents.js';
import { recallSessions } from '../recall.js';
import { detectScripts, runVerify, autoCommit } from '../verify.js';
import { copyToClipboard } from '../clipboard.js';
import { lastSwarmSummary, swarmCleanup } from '../swarm.js';

export interface SlashCommandDef {
  name: string;
  description: string;
  usage: string;
}

export interface SlashResult {
  /** If true, the app should process the prompt normally after the command. */
  handled: boolean;
  /** Optional system message to display. */
  message?: string;
  /** If true, exit the app. */
  exit?: boolean;
  /** Optional new model to switch to. */
  model?: string;
  /** If true, clear the conversation history. */
  clear?: boolean;
  /** New interaction mode (plan/act). */
  mode?: PlanMode;
  /** If true, revert the most recent file change. */
  undo?: boolean;
  /** If true, rewind the whole last turn (checkpoint). */
  rewind?: boolean;
  /** If true, run post-edit verification (lint/test). */
  verify?: boolean;
  /** If true, auto-commit current changes. */
  autocommit?: boolean;
  /** A session to restore into the conversation (from /load). */
  load?: SessionData | null;
  /** Current session name (e.g. after /save or /new). */
  sessionName?: string;
  /** If true, open the interactive provider-login popup (from /login). */
  login?: boolean;
  /** If true, open the interactive model-picker popup (from /models). */
  models?: boolean;
  /** If true, open the interactive settings popup (from /settings). */
  settings?: boolean;
  /** If true, open the interactive theme picker popup (from /theme). */
  theme?: boolean;
  /** If true, compact the conversation now (the app owns the message store). */
  compact?: boolean;
  /** Launch a swarm run (the app owns the provider + event wiring). */
  swarm?: { goal: string; noPlan: boolean };
}

export interface SlashContext {
  config: AppConfig;
  conversationLength: number;
  messages: ChatMessage[];
  setModel: (m: string) => void;
  mode: PlanMode;
  sessionName: string;
  cwd: string;
  costUsd: number;
  tokens: number;
  /** Estimated tokens currently used in the context window. */
  contextTokens: number;
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: '/help', description: 'Show this help', usage: '/help' },
  { name: '/copy', description: 'Copy the last reply (or "all") to the clipboard', usage: '/copy [all]' },
  { name: '/login', description: 'Connect an AI provider (OpenAI · Anthropic · InferX · AgentRouter · ZenMux · TokenRouter · OpenRouter · OpenAI Compatible)', usage: '/login' },
  { name: '/models', description: 'Pick a model from the connected provider', usage: '/models' },
  { name: '/settings', description: 'Open the settings menu', usage: '/settings' },
  { name: '/theme', description: 'Pick a color theme', usage: '/theme' },
  { name: '/model', description: 'Switch AI model', usage: '/model <name>' },
  { name: '/plan', description: 'Switch to plan mode (read-only analysis)', usage: '/plan' },
  { name: '/act', description: 'Switch to act mode (full access)', usage: '/act' },
  { name: '/mode', description: 'Show current mode', usage: '/mode' },
  { name: '/clear', description: 'Clear the conversation', usage: '/clear' },
  { name: '/save', description: 'Save this conversation to disk', usage: '/save [name]' },
  { name: '/load', description: 'Resume a saved conversation', usage: '/load <name>' },
  { name: '/sessions', description: 'List saved sessions', usage: '/sessions' },
  { name: '/new', description: 'Start a fresh conversation', usage: '/new [name]' },
  { name: '/undo', description: 'Revert the last file change', usage: '/undo' },
  { name: '/review', description: 'Show git diff of your changes', usage: '/review' },
  { name: '/cost', description: 'Show token & spend for this session', usage: '/cost' },
  { name: '/tools', description: 'List available agent tools', usage: '/tools' },
  { name: '/agents', description: 'List sub-agent roles & recent spawns', usage: '/agents' },
  { name: '/swarm', description: 'Run parallel worktree-isolated agents on a decomposed goal', usage: '/swarm <goal> [--no-plan]' },
  { name: '/mcp', description: 'Show MCP servers (Open Tool Bus) & their tools; --connect to (re)connect', usage: '/mcp [--connect]' },
  { name: '/skills', description: 'List skills (progressive-disclosure packages); /skills add <name> scaffolds one', usage: '/skills [add <name>|reload]' },
  { name: '/recall', description: 'Search saved sessions for past work', usage: '/recall <query>' },
  {
    name: '/compact',
    description: 'Summarize context',
    usage: '/compact',
  },
  {
    name: '/status',
    description: 'Show environment / connection info',
    usage: '/status',
  },
  { name: '/stars', description: 'Deploy stardust', usage: '/stars' },
  { name: '/whoami', description: 'Introspect the agent', usage: '/whoami' },
  { name: '/delete', description: 'Delete a saved session', usage: '/delete <name>' },
  { name: '/memory', description: 'Show project memory (ASTROCODE.md)', usage: '/memory [reload]' },
  { name: '/map', description: 'Build & show the repo map', usage: '/map' },
  { name: '/todo', description: 'Show the live task list', usage: '/todo' },
  { name: '/rewind', description: 'Revert the whole last turn', usage: '/rewind' },
  { name: '/verify', description: 'Run lint/test on your changes', usage: '/verify' },
  { name: '/commit', description: 'Auto-commit current changes', usage: '/commit [msg]' },
  { name: '/context', description: 'Show context-window usage', usage: '/context' },
  { name: '/exit', description: 'Quit AstroCode', usage: '/exit or /quit' },
  { name: '/quit', description: 'Quit AstroCode', usage: '/quit' },
];

/**
 * Informational commands that only read state (no writes, no modals, no turn
 * mutation), so they stay usable while the agent is mid-turn. Every other
 * command must wait for the current turn to finish.
 */
export const SLASH_SAFE_WHILE_BUSY: ReadonlySet<string> = new Set([
  '/help',
  '/copy',
  '/cost',
  '/mode',
  '/status',
  '/tools',
  '/agents',
  '/todo',
  '/context',
  '/memory',
  '/whoami',
  '/stars',
]);

/**
 * Filter the command list for the "/" menu. Ranking is exact name first,
 * then commands that START with the needle, then commands that merely
 * contain it — stable by declaration order inside each group — so the top
 * row is always the most likely command as the user types. Any whitespace in
 * the needle means arguments are being typed, which closes the menu.
 */
export function filterSlashCommands(rawNeedle: string): SlashCommandDef[] {
  if (/\s/.test(rawNeedle)) return [];
  const needle = rawNeedle.toLowerCase();
  if (!needle) return [...SLASH_COMMANDS];
  const ranked: { cmd: SlashCommandDef; rank: number; idx: number }[] = [];
  SLASH_COMMANDS.forEach((cmd, idx) => {
    const name = cmd.name.slice(1).toLowerCase();
    const rank =
      name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : -1;
    if (rank >= 0) ranked.push({ cmd, rank, idx });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.idx - b.idx);
  return ranked.map((r) => r.cmd);
}

/**
 * Decide what Enter RUNS while the slash menu is open. A command typed in
 * full always wins (so "/model" is never morphed into "/models" just because
 * the latter is highlighted); otherwise the highlighted command runs with any
 * typed arguments preserved. Returns null when there is nothing to run.
 */
export function resolveSlashSubmission(
  typed: string,
  matches: SlashCommandDef[],
  sel: number,
): string | null {
  const value = typed.trim();
  if (!value) return null;
  const exact = matches.find((c) => c.name.toLowerCase() === value.toLowerCase());
  if (exact) return exact.name;
  const m = matches[sel];
  if (!m) return null;
  const sp = typed.indexOf(' ');
  const argPart = sp > 0 ? typed.slice(sp) : '';
  return m.name + argPart;
}

const HELP_TEXT = `AstroCode slash commands
────────────────────────────
${SLASH_COMMANDS.map((c) => `${c.name.padEnd(12)} ${c.description}`).join('\n')}

Modes
────────────────────────────
• plan — read-only; agent explores & proposes a plan (write/edit/run blocked).
• act  — full access; agent implements changes (default).

Tips
────────────────────────────
• Type "/" to open the command menu: ↑/↓ browse every command, Enter runs the
  highlighted one, Tab completes it into the line so you can add arguments.
• While the agent is working, menu navigation still works and informational
  commands (/help, /cost, /status, /context, /mode, …) run immediately.
• Type /login to connect OpenAI, Anthropic, InferX, AgentRouter, ZenMux, TokenRouter, or OpenRouter with an interactive popup.
• Type /models to pick a model from your connected provider.
• Type /settings to open the settings menu (mode, verify, auto-commit, turns, budget).
• Type /theme to pick a color theme (persists across launches; ASTROCODE_THEME env wins).
• Select & copy: your terminal's native mouse selection works here too (drag + Ctrl+Shift+C / Cmd+C).
• Ctrl+K selects & copies clean text (no prefixes/chrome); /copy copies the last reply (or "all").
• Type normally to chat with the agent; it streams responses live.
• The agent uses tools (read/write/edit/list/search/git, run commands) autonomously.
• While the agent runs: Enter QUEUES your prompt · Esc INTERRUPTS the turn.
• !<cmd> runs a shell command yourself (agent not involved), e.g. !git status.
• ↑/↓ in the prompt recall history · PgUp/PgDn scroll the transcript.
• Set ASTROCODE_API_KEY / ASTROCODE_MODEL / ASTROCODE_BASE_URL for a live model.
• ASTROCODE_BUDGET caps spending; /undo reverts the last file change.
• Headless: astrocode -p "task" runs one shot and exits (see --json, -c, --plan).`;

export async function runSlashCommand(
  raw: string,
  ctx: SlashContext,
): Promise<SlashResult> {
  const trimmed = raw.trim();
  const [cmd, ...rest] = trimmed.split(/\s+/);
  const arg = rest.join(' ').trim();

  switch (cmd.toLowerCase()) {
    case '/help':
      return { handled: true, message: HELP_TEXT };
    case '/copy': {
      const wantAll = arg.toLowerCase() === 'all';
      const assistants = ctx.messages.filter(
        (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content,
      );
      const last = assistants[assistants.length - 1];
      if (wantAll) {
        const body = ctx.messages
          .filter(
            (m) =>
              (m.role === 'user' || m.role === 'assistant') &&
              typeof m.content === 'string' &&
              m.content,
          )
          .map((m) => m.content)
          .join('\n\n');
        if (!body) {
          return { handled: true, message: 'Nothing to copy — the conversation is empty.' };
        }
        const res = copyToClipboard(body);
        return {
          handled: true,
          message:
            res === 'failed'
              ? 'Could not copy — no clipboard support available.'
              : `Copied the conversation (${body.length} chars) to the clipboard.`,
        };
      }
      if (!last?.content) {
        return { handled: true, message: 'No assistant reply to copy yet.' };
      }
      const res = copyToClipboard(last.content);
      return {
        handled: true,
        message:
          res === 'failed'
            ? 'Could not copy — no clipboard support available.'
            : `Copied the last reply (${last.content.length} chars) to the clipboard.`,
      };
    }
    case '/login':
      return { handled: true, login: true };
    case '/models':
      return { handled: true, models: true };
    case '/settings':
      return { handled: true, settings: true };
    case '/theme':
      return { handled: true, theme: true };
    case '/model': {
      if (!arg) {
        return {
          handled: true,
          message: `Current model: ${ctx.config.model}\nUsage: /model <name>`,
        };
      }
      ctx.setModel(arg);
      return { handled: true, message: `Model switched to ${arg}` };
    }
    case '/mode':
      return {
        handled: true,
        message: `Current mode: ${ctx.mode} (${ctx.mode === 'plan' ? 'read-only analysis' : 'full access implementation'})`,
      };
    case '/plan':
      return {
        handled: true,
        mode: 'plan',
        message: 'Switched to PLAN mode — I will analyze and propose a plan using read-only tools only.',
      };
    case '/act':
      return {
        handled: true,
        mode: 'act',
        message: 'Switched to ACT mode — I have full access to edit files and run commands.',
      };
    case '/clear':
      return { handled: true, message: 'Conversation cleared.', clear: true };
    case '/save': {
      const name = arg || ctx.sessionName || 'session';
      if (ctx.messages.length === 0) {
        return { handled: true, message: 'Nothing to save — the conversation is empty.' };
      }
      const saved = await saveSession(name, {
        cwd: ctx.cwd,
        model: ctx.config.model,
        mode: ctx.mode,
        createdAt: new Date().toISOString(),
        messages: ctx.messages,
      });
      return {
        handled: true,
        sessionName: saved.name,
        message: `Saved ${saved.messages.length} message(s) as "${saved.name}".\nUse /load ${saved.name} to resume later.`,
      };
    }

    case '/load': {
      if (!arg) {
        return { handled: true, message: 'Usage: /load <name>\nSee /sessions to list saved sessions.' };
      }
      const session = await loadSession(arg);
      if (!session) {
        return { handled: true, message: `No saved session named "${arg}".\nSee /sessions to list saved sessions.` };
      }
      return {
        handled: true,
        load: session,
        sessionName: session.name,
        message: `Resumed "${session.name}" (${session.messages.length} messages, model ${session.model}).`,
      };
    }
    case '/sessions': {
      const list = await listSessions();
      if (list.length === 0) {
        return { handled: true, message: 'No saved sessions yet. Use /save <name> to create one.' };
      }
      const body = list
        .map(
          (s) =>
            `  ${s.name.padEnd(24)} ${s.messages} msgs · ${s.model} · ${s.mode} · ${new Date(s.updatedAt).toLocaleString()}`,
        )
        .join('\n');
      return { handled: true, message: `Saved sessions (${list.length}):\n${body}` };
    }
    case '/new':
      return {
        handled: true,
        clear: true,
        sessionName: arg || 'session',
        message: 'Started a new conversation.',
      };
    case '/delete': {
      if (!arg) {
        return { handled: true, message: 'Usage: /delete <name>' };
      }
      const ok = await deleteSession(arg);
      return {
        handled: true,
        message: ok ? `Deleted session "${arg}".` : `No session named "${arg}" to delete.`,
      };
    }
    case '/undo': {
      if (undoCount() === 0) {
        return { handled: true, undo: true, message: 'Nothing to undo — no file changes were made.' };
      }
      return { handled: true, undo: true, message: `${undoCount()} change(s) available to undo.` };
    }
    case '/review': {
      const res = await executeTool('git_diff', JSON.stringify({}), { cwd: ctx.cwd });
      return { handled: true, message: res.text };
    }
    case '/cost': {
      const p = pricingFor(ctx.config.model);
      return {
        handled: true,
        message:
          `Tokens (est): ${ctx.tokens}\n` +
          `Spend (est)  : ${formatCost(ctx.costUsd)}\n` +
          `Model pricing: ${p.inputPerM}/1M in · ${p.outputPerM}/1M out\n` +
          `Budget       : ${ctx.config.budget > 0 ? '$' + ctx.config.budget.toFixed(2) : 'unlimited'}`,
      };
    }

    case '/tools':
      return {
        handled: true,
        message: `Available tools:\n${getToolNames()
          .map(
            (t) =>
              `  ${ctx.mode === 'plan' && !PLAN_ALLOWED_TOOLS.has(t) ? '(blocked in plan)' : '✦'} ${t}`,
          )
          .join('\n')}`,
      };
    case '/agents': {
      const roles = SUBAGENT_ROLE_NAMES.map((n) => {
        const r = SUBAGENT_ROLES[n];
        return `  ✦ ${n}\n    ${r.description}\n    tools: ${r.tools.join(', ')}`;
      }).join('\n');
      const history = getAgentHistory(8);
      const body =
        history.length === 0
          ? '  (no sub-agents spawned yet — ask the agent a task; it can delegate with spawn_agent)'
          : history
              .map(
                (h) =>
                  `  ${new Date(h.ts).toLocaleTimeString()} · ${h.role.padEnd(13)} ` +
                  `${String(h.turns).padStart(2)} turn(s) · ${h.actions} action(s) ` +
                  `${h.ok ? '✓' : '✗'} · ${h.task}`,
              )
              .join('\n');
      return {
        handled: true,
        message: `Sub-agent roles (${SUBAGENT_ROLE_NAMES.length}):\n${roles}\n\nRecent spawns (this session):\n${body}`,
      };
    }
    case '/recall': {
      if (!arg) {
        return {
          handled: true,
          message:
            'Usage: /recall <query>\n' +
            'Searches your saved sessions (/save) for past work.\n' +
            'Example: /recall how did we fix the build cache',
        };
      }
      const hits = await recallSessions(arg);
      if (hits.length === 0) {
        return {
          handled: true,
          message:
            `No matches for "${arg}" in your saved sessions.\n` +
            'Use /save <name> to preserve conversations so /recall can find them later.',
        };
      }
      const body = hits
        .map(
          (h, i) =>
            `  ${i + 1}. ${h.name.padEnd(20)} (${h.score.toFixed(1)}) · ${h.messages} msgs · ` +
            `${new Date(h.updatedAt).toLocaleString()}\n      ${h.snippet}`,
        )
        .join('\n');
      return {
        handled: true,
        message: `Top ${hits.length} matches for "${arg}":\n${body}\n\nUse /load <name> to open one.`,
      };
    }
    case '/compact':
      // The real compaction happens in App.tsx (it owns the conversation);
      // here we only signal it and short-circuit trivial cases.
      return ctx.conversationLength <= 4
        ? { handled: true, message: 'Context is already compact — nothing to summarize.' }
        : { handled: true, compact: true };
    case '/status':
      return {
        handled: true,
        message:
          `Mode        : ${ctx.mode} (${ctx.mode === 'plan' ? 'read-only' : 'full access'})\n` +
          `Connection  : ${ctx.config.demo ? 'demo (offline)' : 'live'}\n` +
          `Model       : ${ctx.config.model}\n` +
          `Base URL    : ${ctx.config.baseUrl}\n` +
          `API Key     : ${ctx.config.apiKey ? 'configured' : 'not set'}\n` +
          `Budget      : ${ctx.config.budget > 0 ? '$' + ctx.config.budget.toFixed(2) : 'unlimited'}\n` +
          `Workspace   : ${ctx.cwd}\n` +
          `Session     : ${ctx.sessionName}\n` +
          `History size: ${ctx.conversationLength} message(s)`,
      };
    case '/stars':
      return { handled: true, message: '✦ ✧ ★ ✦ Deploying stardust… ✦ ★ ✧ ✦' };
    case '/whoami':
      return {
        handled: true,
        message:
          'I am AstroCode — an AI terminal coding agent living in your shell, built to read, write, edit, explore, and run code alongside you. ✦',
      };
    case '/memory': {
      if (arg.toLowerCase() === 'reload') {
        const { text, sources } = await reloadMemory(ctx.cwd);
        const found = sources.filter((s) => s.exists);
        return {
          handled: true,
          message:
            found.length === 0
              ? 'No memory files found.'
              : `Reloaded ${found.length} memory file(s):\n${text}`,
        };
      }
      let text = getMemoryText();
      let sources = getMemorySources();
      // Lazy-load if the startup load hasn't primed the cache yet.
      if (!text) {
        const loaded = await loadMemory(ctx.cwd);
        text = loaded.text;
        sources = loaded.sources;
      }
      if (!text) {
        return {
          handled: true,
          message:
            'No memory files loaded. Create ./ASTROCODE.md (project) or\n' +
            '~/.astrocode/ASTROCODE.md (global) with your conventions, then run /memory reload.',
        };
      }
      return {
        handled: true,
        message: `Loaded memory:\n${sources
          .filter((s) => s.exists)
          .map((s) => `  - ${s.label}: ${s.path}`)
          .join('\n')}\n\n${text}`,
      };
    }
    case '/map': {
      const r = await buildRepoMap(ctx.cwd);
      return { handled: true, message: r.text };
    }
    case '/todo': {
      const todos = listTodos();
      if (todos.length === 0) {
        return { handled: true, message: 'No tasks. Ask the agent to break work into steps (it uses the todo tool).' };
      }
      const c = todoCounts();
      return {
        handled: true,
        message: `Tasks: ${c.done}/${c.total} done · ${c.inProgress} in progress · ${c.pending} pending\n${todoBlock()}`,
      };
    }
    case '/rewind': {
      const pending = changesSinceLastBoundary();
      if (pending === 0) {
        return { handled: true, rewind: true, message: 'No file changes were made in the last turn.' };
      }
      return { handled: true, rewind: true, message: `Rewinding ${pending} change(s) from the last turn…` };
    }
    case '/verify': {
      return { handled: true, verify: true };
    }
    case '/commit': {
      return { handled: true, autocommit: true, message: arg ? `Committing: ${arg}` : 'Committing current changes…' };
    }
    case '/context': {
      const limit = contextLimitFor(ctx.config.model);
      const used = ctx.contextTokens;
      const pct = limit > 0 ? (used / limit) * 100 : 0;
      const bar = (p: number) => {
        const filled = Math.round(p / 5);
        return '█'.repeat(Math.max(0, Math.min(20, filled))).padEnd(20, '░');
      };
      return {
        handled: true,
        message:
          `Context window: ${used.toLocaleString()} / ${limit.toLocaleString()} tokens (${pct.toFixed(1)}%)\n` +
          `${bar(pct)}\n` +
          `Model: ${ctx.config.model} · ${pct >= 80 ? '⚠ near capacity — consider /compact' : 'ok'}`,
      };
    }
    case '/swarm': {
      if (!arg) {
        const last = lastSwarmSummary();
        return {
          handled: true,
          message:
            'Usage: /swarm <goal> — decompose a goal and run parallel worktree-isolated agents.\n' +
            '  /swarm <goal> --no-plan   one worker, whole goal (still worktree-isolated)\n' +
            '  /swarm status             last swarm\'s worker statuses\n' +
            '  /swarm cleanup            discard all swarm worktrees/branches\n\n' +
            (last ? `Last swarm:\n${last}` : 'No swarm has run yet this session.'),
        };
      }
      if (arg.toLowerCase() === 'status') {
        const last = lastSwarmSummary();
        return { handled: true, message: last ?? 'No swarm has run yet. Start one with /swarm <goal>.' };
      }
      if (arg.toLowerCase() === 'cleanup') {
        const res = await swarmCleanup(ctx.cwd);
        return { handled: true, message: res };
      }
      const noPlan = /(^|\s)--no-plan(\s|$)/i.test(arg);
      const goal = arg.replace(/--no-plan/gi, '').trim();
      return {
        handled: true,
        message: ` Swarm launching: "${goal}"${noPlan ? ' (no planner)' : ''}…`,
        swarm: { goal, noPlan },
      };
    }
    case '/mcp': {
      if (arg.toLowerCase() === 'connect') {
        const { connectAllMcp } = await import('../mcp.js');
        const { connected, failed } = await connectAllMcp(ctx.cwd);
        const parts: string[] = [];
        if (connected.length > 0) parts.push(`Connected: ${connected.join(', ')}`);
        for (const f of failed) parts.push(`⚠ "${f.name}" failed: ${f.error}`);
        return {
          handled: true,
          message: parts.length > 0 ? parts.join('\n') : 'No MCP servers configured. Add them to .astrocode/mcp.json under "mcpServers".',
        };
      }
      const { mcpServerNames, allMcpToolSchemas } = await import('../mcp.js');
      const names = mcpServerNames();
      if (names.length === 0) {
        return {
          handled: true,
          message:
            'No MCP servers connected. Configure in .astrocode/mcp.json:\n\n```json\n{\n  "mcpServers": {\n    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }\n  }\n}\n```\n\nThen /mcp connect. Tools appear as mcp_<server>_<tool>.',
        };
      }
      const tools = allMcpToolSchemas().map((t) => `  ✦ ${t.function.name}`);
      return {
        handled: true,
        message: `MCP servers connected (${names.length}): ${names.join(', ')}\nExternal tools available to the agent:\n${tools.join('\n')}`,
      };
    }
    case '/skills': {
      const { getSkills, scaffoldSkill } = await import('../skills.js');
      const { loadSkills } = await import('../skills.js');
      if (arg.toLowerCase().startsWith('add ')) {
        const name = arg.slice(4).trim();
        if (!name) return { handled: true, message: 'Usage: /skills add <name>' };
        const msg = await scaffoldSkill(ctx.cwd, name);
        await loadSkills(ctx.cwd); // reload so the new skill is live
        return { handled: true, message: msg };
      }
      if (arg.toLowerCase() === 'reload') {
        const catalog = await loadSkills(ctx.cwd);
        return { handled: true, message: catalog || 'No skills found. Create one: /skills add <name>' };
      }
      const skills = getSkills();
      if (skills.length === 0) {
        return {
          handled: true,
          message:
            'No skills loaded. Scaffold one:\n  /skills add my-deploy-flow\n\nSkills live in .astrocode/skills/<name>/SKILL.md (project) or ~/.astrocode/skills/ (global).',
        };
      }
      const rows = skills
        .map((s) => `  ✦ ${s.name} — ${s.description}${s.scripts.length > 0 ? ` · ${s.scripts.length} script(s)` : ''}`)
        .join('\n');
      return {
        handled: true,
        message: `Skills (${skills.length}) — bodies load on first use via use_skill:\n${rows}`,
      };
    }
    case '/exit':
    case '/quit':
      return { handled: true, exit: true };
    default:
      return {
        handled: true,
        message: `Unknown slash command: ${cmd}\nType /help to list commands.`,
      };
  }
}

