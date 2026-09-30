import type { AppConfig } from './types.js';
import { loadAuth } from './auth.js';
import { providerById } from './providers.js';

export const DEFAULT_SYSTEM_PROMPT = `You are AstroCode, a brilliant AI terminal coding agent running in the user's terminal.
You help the user build, understand, and modify code in their workspace.

You have access to a set of tools (read/write/edit/multi-edit/list/search files, a repo map, web fetch, git, run shell commands, and a live todo list).

Rules you must follow:
1. Use tools when they help you. Prefer tools over guessing about file contents.
2. For multi-step work, create and update tasks with the \`todo\` tool so the user can follow your progress; mark tasks in_progress when you start them and completed when done.
3. Use \`apply_patch\` for file edits — it matches hunks with fuzzy tolerance and applies them transactionally (prefer it over \`edit_file\`/\`multi_edit\`). Use \`repomap\` to orient yourself in an unfamiliar project before editing, and \`worktree\` for risky or parallel experiments.
4. When you use tools, loop until you have everything you need, THEN give a concise final answer in plain text (no markdown fences around final answers unless showing code).
5. Be precise. Never fabricate file contents or command output.
6. Interpret the results of every tool call before responding.
7. When writing code, follow the existing conventions in the project (see the project memory and repo map in your context).
8. Keep prose concise and friendly — you are a terminal companion.
9. Delegate independent exploration to bounded sub-agents with the \`spawn_agent\` tool (roles: researcher, file-picker, code-searcher, reviewer). Sub-agents are read-only (reviewer may run commands), report back concisely, and are great for parallel or focused investigation instead of doing everything inline. For several independent questions at once, pass a \`workers\` array of { task, role? } specs to run them in parallel and get one combined report.
10. For large multi-part goals (independent features/docs/tests across DIFFERENT areas of the repo), use the \`swarm\` tool: it decomposes the goal and runs parallel full agents in isolated git worktrees, then merges finished branches. Keep swarms for genuinely independent subtasks.
11. If a \`use_skill\` tool is present, check the skills catalog in your context: when a task matches a skill, call use_skill BEFORE improvising.
12. Tools named \`mcp_*\` come from connected MCP servers (the Open Tool Bus) — prefer them over reimplementing what they already do.`;

export interface CliArgs {
  demo: boolean;
  model?: string;
  cwd?: string;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { demo: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--demo':
      case '-d':
        args.demo = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--version':
      case '-v':
        args.version = true;
        break;
      case '--model':
        args.model = argv[++i];
        break;
      case '-m':
        args.model = argv[++i];
        break;
      case '--cwd':
        args.cwd = argv[++i];
        break;
      default:
        if (a.startsWith('--model=')) args.model = a.slice('--model='.length);
        else if (a.startsWith('--cwd=')) args.cwd = a.slice('--cwd='.length);
        break;
    }
  }
  return args;
}

function flag(env: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((env ?? '').trim());
}

export function loadConfig(args: CliArgs): AppConfig {
  // Credentials may come from env vars, or from a provider connected earlier
  // via /login (stored in ~/.astrocode/config.json). Env wins over the file.
  const stored = loadAuth();
  const provider = providerById(stored?.provider);
  const apiKey =
    process.env.ASTROCODE_API_KEY ||
    process.env.OPENAI_API_KEY ||
    stored?.apiKey ||
    '';
  const baseUrl = (
    process.env.ASTROCODE_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    // The 'openai-compatible' provider stores the endpoint the user typed in
    // /login; built-in providers carry their own base URL.
    stored?.baseUrl ||
    provider.baseUrl ||
    'https://api.openai.com/v1'
  ).replace(/\/+$/, '');
  const model =
    args.model ||
    process.env.ASTROCODE_MODEL ||
    stored?.model ||
    provider.defaultModel;
  // A keyless 'openai-compatible' endpoint (e.g. Ollama, LM Studio) is a real
  // connection, not demo mode — but only when a base URL AND model were saved
  // by a completed /login flow. Anything else without a key stays in demo.
  const customReady =
    stored?.provider === 'openai-compatible' &&
    !!baseUrl &&
    !!model;
  const demo = args.demo || (!apiKey && !customReady);
  // Settings changed via /settings persist in the same config file. When an
  // env var is actually set it wins completely (including explicit "off"/0);
  // otherwise the saved value applies.
  const envTurns = process.env.ASTROCODE_MAX_TURNS;
  const maxToolTurns =
    envTurns !== undefined && envTurns.trim() !== ''
      ? Number(envTurns) || 20
      : stored?.maxToolTurns || 20;
  const envBudget = process.env.ASTROCODE_BUDGET;
  const budget =
    envBudget !== undefined && envBudget.trim() !== ''
      ? Number(envBudget) || 0
      : stored?.budget || 0;
  const envVerify = process.env.ASTROCODE_VERIFY;
  const verify =
    envVerify !== undefined ? flag(envVerify) : stored?.verify === true;
  const envAutocommit = process.env.ASTROCODE_AUTOCOMMIT;
  const autocommit =
    envAutocommit !== undefined
      ? flag(envAutocommit)
      : stored?.autocommit === true;
  const theme =
    process.env.ASTROCODE_THEME?.trim() || stored?.theme;

  return {
    apiKey,
    baseUrl,
    model,
    provider: stored?.provider,
    theme,
    demo,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    maxToolTurns,
    budget,
    verify,
    autocommit,
  };
}

export const VERSION = '1.3.0';
