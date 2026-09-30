import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  AIProvider,
  PlanMode,
  ToolFunctionSchema,
  ToolResult,
  ToolSchema,
} from '../types.js';
import { runShell } from './shell.js';
import { snapshotFile } from '../undo.js';
import { buildRepoMap } from '../repomap.js';
import { fetchUrl } from '../webfetch.js';
import { runSubAgent, SUBAGENT_ROLES, SUBAGENT_ROLE_NAMES } from '../subagent.js';
import type { SubAgentEvent } from '../subagent.js';
import { recordAgentSpawn } from '../agents.js';
import { applyPatch } from '../applypatch.js';
import {
  createWorktree,
  runInWorktree,
  mergeWorktree,
  listWorktrees,
  discardWorktree,
} from '../worktree.js';
import {
  addTodo,
  updateTodoStatus,
  updateTodoText,
  deleteTodo,
  todoBlock,
  type TodoStatus,
} from '../todos.js';
import { truncateToolText } from '../tooloutput.js';
import { LoopSensor } from '../loopsensor.js';
import type { ApprovalGate } from '../approval.js';
import { isDangerousCommand } from '../approval.js';
import { repairToolArgsJson, coerceArgsToSchema } from '../toolargs.js';
import { runSwarm, worktreeCwdFor, recordSwarmResult } from '../swarm.js';
import {
  allMcpToolSchemas,
  executeMcpTool,
  mcpServerNames,
} from '../mcp.js';
import { useSkill, useSkillToolSchema, getSkills } from '../skills.js';

/**
 * Live progress events from a spawn_agent call, for the TUI activity card.
 * `worker` is 1-based; worker 0 means a single (non-workers) spawn.
 */
export type ToolProgressEvent =
  | { type: 'worker_start'; worker: number; role: string; task: string }
  | { type: 'worker_tool'; worker: number; tool: string }
  | { type: 'worker_done'; worker: number; role: string; turns: number; actions: number }
  | { type: 'spawn_done' };

export interface ToolContext {
  cwd: string;
  /** Active interaction mode (used to keep sub-agents read-only in plan mode). */
  mode?: PlanMode;
  /** AI provider for spawning sub-agents. */
  provider?: AIProvider;
  /** Optional cost-accounting callback (input text, output text). */
  onCharge?: (input: string, output: string) => void;
  /** Optional live-progress callback for long-running tools (spawn_agent). */
  onProgress?: (e: ToolProgressEvent) => void;
  /** Optional live-progress callback for swarm runs (worker statuses, merges). */
  onSwarmEvent?: (e: import('../swarm.js').SwarmEvent) => void;
  /**
   * Loop sensor for this agent turn (main loop or one sub-agent run). When
   * omitted, executeTool uses a fresh sensor per call — i.e. no loop
   * detection. Callers that loop (App.tsx, spawnOne) create one per turn so
   * repeated identical calls are detected across iterations.
   */
  loopSensor?: LoopSensor;
  /**
   * Shell-approval gate (off by default). When present, run_command consults
   * it before executing; the TUI wires the decision prompt, headless mode
   * auto-denies.
   */
  approvalGate?: ApprovalGate;
}

type ToolHandler = (
  args: Record<string, any>,
  ctx: ToolContext,
) => Promise<ToolResult> | ToolResult;

interface ToolDefinition {
  schema: ToolFunctionSchema;
  handler: ToolHandler;
}

/**
 * Swarm mode: the `swarm` tool runs parallel worktree-isolated workers.
 * Always registered; requires a git repo (worktrees) and act mode.
 */

function safeResolve(p: string, cwd: string): string {
  return path.resolve(cwd, p || '.');
}

/**
 * Tool names that are safe in Plan mode (analysis only — no writes, edits,
 * or side-effecting shell commands).
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_dir',
  'search_files',
  'git_status',
  'git_diff',
  'repomap',
  'fetch_url',
]);

/**
 * Tools permitted in Plan mode. This is the read-only set PLUS planning aids
 * (the `todo` tool) that don't touch the user's repo. The agent controller
 * uses this to gate tool calls when in plan mode.
 */
export const PLAN_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  ...READ_ONLY_TOOLS,
  'todo',
  'spawn_agent', // delegation is safe in plan mode: sub-agents are forced read-only
]);

/**
 * @returns true when a command looks intentionally destructive. Canonical
 * implementation lives in approval.ts (shared with the approval gate);
 * re-exported here for compatibility with existing imports/tests.
 */
export { isDangerousCommand } from '../approval.js';


// ── sub-agent spawning helpers ─────────────────────────────────────────────

/** Max sub-agents that may run concurrently in a single spawn_agent call. */
const MAX_CONCURRENT_WORKERS = 5;
/** Cap on the combined report length (each worker is also individually capped). */
const COMBINED_REPORT_CAP = 30_000;

interface WorkerSpec {
  task: string;
  role?: string;
  max_turns?: number;
  tools?: string[];
}

interface SpawnOutcome {
  ok: boolean;
  text: string;
  turns: number;
  actions: number;
}

function normalizeWorker(raw: any): WorkerSpec {
  return {
    task: String(raw?.task ?? '').trim(),
    role: String(raw?.role ?? 'researcher').trim(),
    // Pass raw through: spawnOne coerces with Number(...) || 6, matching the
    // single-spawn path for both numeric and malformed input.
    max_turns: raw?.max_turns,
    tools: Array.isArray(raw?.tools) ? raw.tools : undefined,
  };
}

/**
 * Validate + run one sub-agent. Never throws — returns a structured outcome
 * so callers (single or concurrent) can fold failures into the report.
 */
async function spawnOne(spec: WorkerSpec, ctx: ToolContext, worker = 0): Promise<SpawnOutcome> {
  const task = spec.task;
  if (!task) {
    return {
      ok: false,
      text: 'spawn_agent requires a "task" argument describing what the sub-agent should do.',
      turns: 0,
      actions: 0,
    };
  }

  const roleName = String(spec.role ?? 'researcher');
  const roleDef = SUBAGENT_ROLES[roleName];
  if (!roleDef) {
    return {
      ok: false,
      text: `Unknown sub-agent role "${roleName}". Available roles: ${SUBAGENT_ROLE_NAMES.join(', ')}`,
      turns: 0,
      actions: 0,
    };
  }

  // Tool allowlist: role preset (or explicit override), minus hard exclusions.
  let allowed = new Set(roleDef.tools);
  if (Array.isArray(spec.tools)) {
    const override = new Set(spec.tools.map((t: any) => String(t ?? '').trim()).filter(Boolean));
    if (override.size > 0) allowed = override;
  }
  // Sub-agents can never edit files, touch the session task list, sandbox,
  // or nest further.
  for (const banned of ['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'worktree', 'todo', 'spawn_agent']) {
    allowed.delete(banned);
  }
  // Plan mode: sub-agents are strictly read-only.
  if (ctx.mode === 'plan') {
    allowed = new Set([...allowed].filter((t) => READ_ONLY_TOOLS.has(t)));
  }
  if (allowed.size === 0) {
    return { ok: false, text: 'spawn_agent: no tools available for this sub-agent here (role fully blocked).', turns: 0, actions: 0 };
  }
  if (!ctx.provider) {
    return { ok: false, text: 'spawn_agent: no AI provider available in this context (internal error).', turns: 0, actions: 0 };
  }

  const maxTurns = Math.max(1, Math.min(Number(spec.max_turns) || 6, 20));
  // One sensor per sub-agent run: repeated identical calls within this run
  // get nudged/blocked, but different sub-agents never interfere.
  const subSensor = new LoopSensor();
  const res = await runSubAgent({
    task,
    role: roleName,
    cwd: ctx.cwd,
    provider: ctx.provider,
    tools: getToolSchemas((n) => allowed.has(n)),
    runTool: (name, rawArgs) => executeTool(name, rawArgs, { cwd: ctx.cwd, loopSensor: subSensor }),
    maxTurns,
    onCharge: ctx.onCharge,
    onEvent: (e: SubAgentEvent) => {
      if (!ctx.onProgress) return;
      if (e.type === 'start') {
        ctx.onProgress({ type: 'worker_start', worker, role: roleName, task });
      } else if (e.type === 'tool') {
        ctx.onProgress({ type: 'worker_tool', worker, tool: e.tool });
      } else {
        ctx.onProgress({ type: 'worker_done', worker, role: roleName, turns: e.turns, actions: e.actions });
      }
    },
  });
  recordAgentSpawn({
    role: roleName,
    task: task.length > 100 ? task.slice(0, 100) + '…' : task,
    turns: res.turns,
    actions: res.actions,
    ok: res.ok,
  });
  return { ok: res.ok, text: res.text, turns: res.turns, actions: res.actions };
}

/**
 * Run several sub-agent specs concurrently and combine their reports.
 *
 * Note on budgets: each worker charges spend immediately via onCharge, but the
 * session budget (ASTROCODE_BUDGET) is only enforced between main-loop turns —
 * so a single multi-worker call can overshoot the ceiling (up to 5× the cost of
 * one spawn). Known tradeoff; worker counts are capped accordingly.
 */
async function runWorkers(rawWorkers: any[], ctx: ToolContext): Promise<ToolResult> {
  if (rawWorkers.length > MAX_CONCURRENT_WORKERS) {
    return {
      ok: false,
      text: `spawn_agent: too many workers (${rawWorkers.length}); max ${MAX_CONCURRENT_WORKERS} concurrent sub-agents per call. Split into multiple calls.`,
    };
  }
  const specs = rawWorkers.map(normalizeWorker);
  // Fail fast on invalid specs before spawning anything.
  for (let i = 0; i < specs.length; i++) {
    if (!specs[i].task) {
      return { ok: false, text: `spawn_agent: worker #${i + 1} is missing a "task".` };
    }
    const wRole = String(specs[i].role ?? 'researcher');
    if (!SUBAGENT_ROLES[wRole]) {
      return {
        ok: false,
        text: `spawn_agent: worker #${i + 1} has unknown role "${wRole}". Available roles: ${SUBAGENT_ROLE_NAMES.join(', ')}`,
      };
    }
  }

  // allSettled: one failing worker never cancels the others.
  const settled = await Promise.allSettled(specs.map((s, i) => spawnOne(s, ctx, i + 1)));

  let completed = 0;
  let totalTurns = 0;
  let totalActions = 0;
  const sections = settled.map((s, i) => {
    if (s.status === 'rejected') {
      const why = s.reason instanceof Error ? s.reason.message : String(s.reason);
      return `#${i + 1} ${specs[i].role} — FAILED\n  ${why}`;
    }
    const o = s.value;
    completed++;
    totalTurns += o.turns;
    totalActions += o.actions;
    // Strip the per-worker summary header; the section header carries it.
    const nl = o.text.indexOf('\n');
    const body = nl >= 0 ? o.text.slice(nl + 1) : o.text;
    return `#${i + 1} ${specs[i].role} — ${o.turns} turn(s) · ${o.actions} action(s)${o.ok ? '' : ' (failed)'}\n${body}`;
  });

  let combined =
    `Sub-agents report — ${specs.length} spawned, ${completed} completed · ${totalTurns} turn(s) · ${totalActions} action(s) overall\n\n` +
    sections.join('\n\n');
  if (combined.length > COMBINED_REPORT_CAP) {
    combined = combined.slice(0, COMBINED_REPORT_CAP) + `\n…[combined report truncated at ${COMBINED_REPORT_CAP} chars]`;
  }
  return { ok: true, text: combined };
}

const definitions: Record<string, ToolDefinition> = {
  swarm: {
    schema: {
      name: 'swarm',
      description:
        'Run a SWARM: decompose a goal into subtasks and run one full agent per subtask in PARALLEL, ' +
        'each in its own isolated git worktree; merge finished branches back into the current branch. ' +
        'Use for multi-part, independent work (e.g. feature + docs + tests). Workers are sandboxed: ' +
        'the main working tree is untouched until a merge succeeds.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The goal to decompose and execute in parallel.' },
          no_plan: {
            type: 'boolean',
            description: 'Skip the planner and run the whole goal as ONE worktree-isolated builder (for simple/single-area goals).',
          },
          max_workers: { type: 'number', description: 'Cap on planned workers (1-8, default 5).' },
          max_turns: { type: 'number', description: 'Per-worker turn cap (default 24).' },
        },
        required: ['goal'],
      },
    },
    async handler(args, ctx) {
      if (!ctx.provider) {
        return { ok: false, text: 'swarm: no AI provider available in this context (internal error).' };
      }
      if (ctx.mode === 'plan') {
        return {
          ok: false,
          text: 'Blocked in PLAN mode: swarm workers edit files (in worktrees). Switch to ACT mode (/act) to run a swarm.',
        };
      }
      // Worktrees need git — fail with a clean message instead of N worker failures.
      const gitCheck = await runShell('git rev-parse --git-dir', { cwd: ctx.cwd });
      if (!gitCheck.ok) {
        return { ok: false, text: 'swarm requires a git repository (workers get isolated worktrees). Initialize git first.' };
      }
      // Schemas for worker loops: read/recon/verify tools plus mutating tools.
      // (Mutating calls are only permitted because execution is redirected into
      // the worker's own worktree checkout via worktreeCwdFor.)
      const allowed = new Set([
        'read_file', 'list_dir', 'search_files', 'git_status', 'git_diff',
        'repomap', 'run_command', 'write_file', 'edit_file', 'multi_edit', 'apply_patch',
      ]);
      const workerSchemas = getToolSchemas((n) => allowed.has(n));
      const r = await runSwarm({
        goal: String(args.goal ?? ''),
        cwd: ctx.cwd,
        provider: ctx.provider,
        toolSchemas: workerSchemas,
        runTool: (name, rawArgs, wtCwd) =>
          executeTool(name, rawArgs, { cwd: wtCwd, mode: ctx.mode, loopSensor: new LoopSensor() }),
        noPlan: args.no_plan === true,
        maxWorkers: typeof args.max_workers === 'number' ? args.max_workers : undefined,
        workerMaxTurns: typeof args.max_turns === 'number' ? args.max_turns : undefined,
        onCharge: ctx.onCharge,
        onEvent: ctx.onSwarmEvent,
      });
      recordSwarmResult(r);
      return { ok: r.ok, text: r.text };
    },
  },

  read_file: {
    schema: {
      name: 'read_file',
      description:
        'Read a text file from disk. Use max_lines to limit very large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file (relative to cwd or absolute)' },
          max_lines: { type: 'number', description: 'Cap on number of lines to read (optional)' },
        },
        required: ['path'],
      },
    },
    async handler(args, ctx) {
      try {
        const fp = safeResolve(args.path, ctx.cwd);
        const stat = await fs.stat(fp);
        if (stat.isDirectory()) {
          return { ok: true, text: `"${args.path}" is a directory. Use list_dir instead.` };
        }
        const content = await fs.readFile(fp, 'utf8');
        const lineCount = content.split('\n').length;
        const maxLines = typeof args.max_lines === 'number' ? args.max_lines : Infinity;
        let lines = content.split('\n');
        let truncated = false;
        if (lines.length > maxLines) {
          lines = lines.slice(0, maxLines);
          truncated = true;
        }
        const slice = lines.join('\n');
        return {
          ok: true,
          text: `File: ${fp}\nLines: ${lineCount}\n${truncated ? `(truncated to ${maxLines} lines)\n` : ''}\n---\n${slice}\n---`,
        };
      } catch (e: any) {
        return { ok: false, text: `read_file failed: ${e?.message ?? e}` };
      }
    },
  },

  write_file: {
    schema: {
      name: 'write_file',
      description: 'Create or overwrite a file with the given content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path of the file to write' },
          content: { type: 'string', description: 'Full content to write' },
        },
        required: ['path', 'content'],
      },
    },
    async handler(args, ctx) {
      try {
        const fp = safeResolve(args.path, ctx.cwd);
        await snapshotFile(fp);
        await fs.mkdir(path.dirname(fp), { recursive: true });
        await fs.writeFile(fp, args.content ?? '', 'utf8');
        return { ok: true, text: `Wrote ${Buffer.byteLength(args.content ?? '', 'utf8')} bytes to ${fp}` };
      } catch (e: any) {
        return { ok: false, text: `write_file failed: ${e?.message ?? e}` };
      }
    },
  },

  list_dir: {
    schema: {
      name: 'list_dir',
      description: 'List the contents of a directory with file types and sizes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to list (default .)' },
        },
        required: ['path'],
      },
    },
    async handler(args, ctx) {
      try {
        const fp = safeResolve(args.path, ctx.cwd);
        const entries = await fs.readdir(fp, { withFileTypes: true });
        const rows = await Promise.all(
          entries.map(async (e) => {
            const full = path.join(fp, e.name);
            let size = '';
            let type = 'file';
            if (e.isDirectory()) type = 'dir';
            else if (e.isSymbolicLink()) type = 'link';
            else if (e.isFile()) {
              try {
                const s = await fs.stat(full);
                size = s.size >= 1024 ? `${(s.size / 1024).toFixed(1)}K` : `${s.size}B`;
              } catch {
                /* permission */
              }
            }
            return `${type.padEnd(5)} ${size.padStart(8)}  ${e.name}`;
          }),
        );
        rows.sort();
        return { ok: true, text: `${fp} (${entries.length} entries)\n${rows.join('\n')}` };
      } catch (e: any) {
        return { ok: false, text: `list_dir failed: ${e?.message ?? e}` };
      }
    },
  },

  edit_file: {
    schema: {
      name: 'edit_file',
      description:
        'Replace the first (or all) occurrence of a search string with a replacement in a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path of the file to edit' },
          search: { type: 'string', description: 'Exact text to find' },
          replace: { type: 'string', description: 'Replacement text' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence (optional)' },
        },
        required: ['path', 'search', 'replace'],
      },
    },
    async handler(args, ctx) {
      try {
        const fp = safeResolve(args.path, ctx.cwd);
        await snapshotFile(fp);
        const content = await fs.readFile(fp, 'utf8');
        const search = String(args.search ?? '');
        const replace = String(args.replace ?? '');
        if (!search) return { ok: false, text: 'search string cannot be empty' };
        let updated: string;
        let count = 0;
        if (args.replace_all) {
          updated = content.split(search).join(replace);
          count = content.split(search).length - 1;
        } else {
          const idx = content.indexOf(search);
          if (idx < 0) return { ok: false, text: 'search string not found in file' };
          updated = content.slice(0, idx) + replace + content.slice(idx + search.length);
          count = 1;
        }
        await fs.writeFile(fp, updated, 'utf8');
        return { ok: true, text: `Edited ${fp}: ${count} replacement(s) made` };
      } catch (e: any) {
        return { ok: false, text: `edit_file failed: ${e?.message ?? e}` };
      }
    },
  },

  search_files: {
    schema: {
      name: 'search_files',
      description:
        'Recursively search files for a regex pattern (like grep). Returns matching file:line results.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression to search for' },
          path: { type: 'string', description: 'Starting directory (default .)' },
          glob: { type: 'string', description: 'File extension filter, e.g. ".ts" (optional)' },
        },
        required: ['pattern'],
      },
    },
    async handler(args, ctx) {
      const root = safeResolve(args.path || '.', ctx.cwd);
      const pattern = String(args.pattern ?? '');
      const ext = args.glob ? String(args.glob).toLowerCase() : '';
      const results: string[] = [];
      const skipped = new Set(['node_modules', '.git', 'dist', 'build', '.astro', '.astrocode', 'coverage']);
      try {
        const re = new RegExp(pattern);
        const walk = async (dir: string) => {
          let entries;
          try {
            entries = await fs.readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            if (e.isDirectory()) {
              if (skipped.has(e.name)) continue;
              await walk(path.join(dir, e.name));
            } else if (e.isFile()) {
              if (ext && !e.name.toLowerCase().endsWith(ext)) continue;
              try {
                const content = await fs.readFile(path.join(dir, e.name), 'utf8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                  if (re.test(lines[i])) {
                    results.push(`${path.relative(ctx.cwd, path.join(dir, e.name))}:${i + 1}: ${lines[i].trim().slice(0, 140)}`);
                  }
                }
              } catch {
                /* binary / unreadable */
              }
            }
          }
        };
        await walk(root);
        if (results.length === 0) return { ok: true, text: `No matches for /${pattern}/ in ${root}` };
        return { ok: true, text: `${results.length} match(es) for /${pattern}/\n${results.join('\n')}` };
      } catch (e: any) {
        return { ok: false, text: `search_files failed: ${e?.message ?? e}` };
      }
    },
  },

  run_command: {
    schema: {
      name: 'run_command',
      description:
        'Run a shell command in the workspace and capture its output. Use for builds, tests, git, and any terminal work.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run' },
          cwd: { type: 'string', description: 'Working directory (optional)' },
          timeout_ms: { type: 'number', description: 'Timeout in ms (optional, default 30000)' },
        },
        required: ['command'],
      },
    },
    async handler(args, ctx) {
      const command = String(args.command ?? '');
      // Safety guard: refuse obviously destructive commands unless the model
      // explicitly passes force=true after showing awareness.
      if (isDangerousCommand(command) && !args.force) {
        return {
          ok: false,
          text:
            `⛔ Command looks dangerous and was NOT run:\n  ${command}\n` +
            `Edit the command to be more specific, or re-run with "force": true to confirm.`,
        };
      }
      // Approval gate (when wired): 'dangerous' prompts for risky commands,
      // 'all' prompts for everything, 'off' never prompts. Decisions are the
      // user's; the agent just sees the result.
      if (ctx.approvalGate && !args.force) {
        const verdict = await ctx.approvalGate.check({ command, cwd: ctx.cwd });
        if (!verdict.allow) return { ok: false, text: verdict.text ?? 'Command not approved.' };
      }
      return runShell(command, {
        cwd: args.cwd ? safeResolve(args.cwd, ctx.cwd) : ctx.cwd,
        timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : 30_000,
      });
    },
  },

  git_status: {
    schema: {
      name: 'git_status',
      description:
        'Show the git branch, dirty/untracked files, and ahead/behind status for the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to inspect (default .)' },
        },
        required: [],
      },
    },
    async handler(args, ctx) {
      const dir = args.path ? safeResolve(args.path, ctx.cwd) : ctx.cwd;
      const branch = await runShell('git rev-parse --abbrev-ref HEAD 2>/dev/null', { cwd: dir });
      if (!branch.ok) {
        return { ok: true, text: 'Not a git repository (or git not installed).' };
      }
      const status = await runShell('git status --porcelain', { cwd: dir });
      const log = await runShell('git log --oneline -5 2>/dev/null', { cwd: dir });
      const lines: string[] = [];
      lines.push(`🌿 branch: ${branch.text.trim()}`);
      if (status.text.trim()) {
        const entries = status.text
          .split('\n')
          .filter(Boolean)
          .map((l) => '  ' + l.trim())
          .slice(0, 60);
        lines.push(`${entries.length} changed/untracked entr${entries.length === 1 ? 'y' : 'ies'}:`);
        lines.push(...entries);
      } else {
        lines.push('Working tree clean.');
      }
      if (log.ok && log.text.trim()) {
        lines.push(`Recent commits:\n${log.text.trim().split('\n').map((l) => '  ' + l).join('\n')}`);
      }
      return { ok: true, text: lines.join('\n') };
    },
  },

  git_diff: {
    schema: {
      name: 'git_diff',
      description:
        'Show a unified diff of unstaged working-tree changes vs the last commit (git diff). Useful for reviewing work.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Limit the diff to a path (default all)' },
          staged: { type: 'boolean', description: 'Diff the staged index instead (optional)' },
          stat: { type: 'boolean', description: 'Only show a diffstat summary (optional)' },
        },
        required: [],
      },
    },
    async handler(args, ctx) {
      const dir = args.path ? safeResolve(args.path, ctx.cwd) : ctx.cwd;
      const staged = args.staged ? '--staged' : '';
      const statFlag = args.stat ? '--stat' : '';
      const pathArg = args.path ? ` -- "${String(args.path)}"` : '';
      const res = await runShell(`git diff ${staged} ${statFlag}${pathArg}`, { cwd: dir });
      if (!res.ok) return { ok: false, text: res.text };
      const body = res.text.trim() || '(no working-tree changes vs HEAD)';
      return { ok: true, text: `git diff ${staged}${statFlag ? ' --stat' : ''}:\n${body}` };
    },
  },

  multi_edit: {
    schema: {
      name: 'multi_edit',
      description:
        'Apply multiple search/replace edits to a single file in one call. Each edit replaces the first (or all) occurrence of `search` with `replace`. Edits apply in order. More efficient than repeated edit_file calls for multi-hunk changes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path of the file to edit' },
          edits: {
            type: 'array',
            description: 'Ordered list of { search, replace, replace_all? } edits',
            items: {
              type: 'object',
              properties: {
                search: { type: 'string' },
                replace: { type: 'string' },
                replace_all: { type: 'boolean' },
              },
            },
          },
        },
        required: ['path', 'edits'],
      },
    },
    async handler(args, ctx) {
      try {
        const fp = safeResolve(args.path, ctx.cwd);
        await snapshotFile(fp);
        let content = await fs.readFile(fp, 'utf8');
        const edits = Array.isArray(args.edits) ? args.edits : [];
        if (edits.length === 0) return { ok: false, text: 'No edits provided.' };
        const applied: string[] = [];
        for (let i = 0; i < edits.length; i++) {
          const e = edits[i];
          const search = String(e.search ?? '');
          const replace = String(e.replace ?? '');
          if (!search) return { ok: false, text: `Edit ${i + 1} had an empty search string.` };
          let count = 0;
          if (e.replace_all) {
            const partsArr = content.split(search);
            count = partsArr.length - 1;
            content = partsArr.join(replace);
          } else {
            const idx = content.indexOf(search);
            if (idx < 0) {
              return { ok: false, text: `Search string not found (edit ${i + 1}): "${search.slice(0, 80)}"` };
            }
            content = content.slice(0, idx) + replace + content.slice(idx + search.length);
            count = 1;
          }
          applied.push(`${count}× "${search.slice(0, 40)}"`);
        }
        await fs.writeFile(fp, content, 'utf8');
        return {
          ok: true,
          text: `Applied ${edits.length} edit(s) to ${fp}:\n${applied
            .map((a, i) => `  ${i + 1}. ${a}`)
            .join('\n')}`,
        };
      } catch (e: any) {
        return { ok: false, text: `multi_edit failed: ${e?.message ?? e}` };
      }
    },
  },

  repomap: {
    schema: {
      name: 'repomap',
      description:
        'Build (or refresh) and return a compact map of the workspace: directory tree, file/dir counts, and key-file summaries (package.json scripts, README, .gitignore). Use to orient yourself in a project before editing.',
      parameters: { type: 'object', properties: {} },
    },
    async handler(_args, ctx) {
      const r = await buildRepoMap(ctx.cwd);
      return { ok: true, text: r.text };
    },
  },

  fetch_url: {
    schema: {
      name: 'fetch_url',
      description:
        'Fetch a URL and return its text content (HTML stripped to readable text, bounded to ~12k chars). Use for documentation, API references, or any web content.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The URL to fetch' } },
        required: ['url'],
      },
    },
    async handler(args) {
      try {
        const r = await fetchUrl(String(args.url ?? ''));
        if (r.status >= 400) {
          return { ok: false, text: `Fetch failed: HTTP ${r.status} for ${r.url}` };
        }
        return { ok: true, text: `${r.url} (HTTP ${r.status}, ${r.bytes} chars):\n${r.text}` };
      } catch (e: any) {
        return { ok: false, text: `fetch_url failed: ${e?.message ?? e}` };
      }
    },
  },

  apply_patch: {
    schema: {
      name: 'apply_patch',
      description:
        'Apply fuzzy, context-tolerant search/replace patches to a file. Unlike edit_file/multi_edit ' +
        '(which require exact string matches and fail when the file drifted since you read it), hunks ' +
        'match by line similarity — tolerant of whitespace and small text drift. ALL hunks apply ' +
        'transactionally: nothing is written unless every hunk matches. Prefer this over edit_file and ' +
        'multi_edit for edits.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path of the file to patch' },
          hunks: {
            type: 'array',
            description: 'Ordered list of { search, replace, replace_all? } hunks',
            items: {
              type: 'object',
              properties: {
                search: { type: 'string', description: 'Text to find (exact-ish; matched with fuzzy tolerance)' },
                replace: { type: 'string', description: 'Replacement text' },
                replace_all: { type: 'boolean', description: 'Replace every fuzzy match (optional)' },
              },
              required: ['search', 'replace'],
            },
          },
        },
        required: ['path', 'hunks'],
      },
    },
    async handler(args, ctx) {
      try {
        const fp = safeResolve(args.path, ctx.cwd);
        const hunks = Array.isArray(args.hunks) ? args.hunks : [];
        if (hunks.length === 0) return { ok: false, text: 'No hunks provided.' };
        await snapshotFile(fp);
        const content = await fs.readFile(fp, 'utf8');
        const out = applyPatch(content, hunks);
        if (out.unmatched.length > 0) {
          return {
            ok: false,
            text:
              `apply_patch: ${out.unmatched.length} hunk(s) did not match (no changes written):\n` +
              out.unmatched
                .map((u) => `  - "${u.search.slice(0, 80)}" (${u.reason})`)
                .join('\n'),
          };
        }
        await fs.writeFile(fp, out.content, 'utf8');
        return { ok: true, text: `Applied ${out.applied} hunk(s) to ${fp}` };
      } catch (e: any) {
        return { ok: false, text: `apply_patch failed: ${e?.message ?? e}` };
      }
    },
  },

  worktree: {
    schema: {
      name: 'worktree',
      description:
        'Zero-risk git-worktree sandboxing. Actions: create (name) — make a new branch + checkout ' +
        '(stored in the system temp dir, tracked in .astrocode/worktrees.json); run (name, command) — ' +
        'run a shell command inside the worktree; merge (name) — commit the worktree branch and merge ' +
        'it back into the current branch; list — show sandbox worktrees; discard (name) — delete the ' +
        'worktree and its branch. Use for experiments and parallel tasks without touching the main ' +
        'working tree.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'run', 'merge', 'list', 'discard'],
            description: 'What to do',
          },
          name: { type: 'string', description: 'Worktree name' },
          command: { type: 'string', description: 'Shell command to run inside the worktree (for run)' },
          timeout_ms: { type: 'number', description: 'Timeout in ms for run (optional, default 30000)' },
        },
        required: ['action'],
      },
    },
    async handler(args, ctx) {
      const action = String(args.action ?? '');
      const name = String(args.name ?? '');
      const command = String(args.command ?? '');
      const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined;
      switch (action) {
        case 'create':
          return name ? createWorktree(ctx.cwd, name) : { ok: false, text: 'worktree create requires a name.' };
        case 'run':
          return name && command
            ? runInWorktree(ctx.cwd, name, command, timeoutMs)
            : { ok: false, text: 'worktree run requires name and command.' };
        case 'merge':
          return name ? mergeWorktree(ctx.cwd, name) : { ok: false, text: 'worktree merge requires a name.' };
        case 'list':
          return listWorktrees(ctx.cwd);
        case 'discard':
          return name ? discardWorktree(ctx.cwd, name) : { ok: false, text: 'worktree discard requires a name.' };
        default:
          return { ok: false, text: `Unknown worktree action: ${action}. Use create/run/merge/list/discard.` };
      }
    },
  },

  spawn_agent: {
    schema: {
      name: 'spawn_agent',
      description:
        'Launch one or more bounded sub-agents that each run their own mini tool loop and report a concise final answer. ' +
        'Pass a single "task" to spawn one sub-agent, or a "workers" array of { task, role?, max_turns?, tools? } specs to ' +
        'dispatch several sub-agents in PARALLEL (up to 5) and receive a combined report. ' +
        'Roles: researcher (general exploration), file-picker (find relevant files), code-searcher ' +
        '(grep + targeted reads), reviewer (inspect changes + run tests/lint). Use for independent ' +
        'exploration or parallel investigation instead of doing everything inline. Sub-agents cannot ' +
        'edit files; in plan mode they are strictly read-only.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description:
              'The precise task for a single sub-agent. Include workspace-relative paths and state exactly what the report should contain. Not used when "workers" is provided.',
          },
          role: {
            type: 'string',
            enum: SUBAGENT_ROLE_NAMES,
            description: 'Sub-agent role/persona — determines its tool set (default researcher)',
          },
          max_turns: {
            type: 'number',
            description: 'Hard cap on sub-agent tool-call turns (1-20, default 6)',
          },
          tools: {
            type: 'array',
            description: 'Optional explicit tool allowlist (tool names only) overriding the role default',
            items: { type: 'string' },
          },
          workers: {
            type: 'array',
            description:
              'Optional list of sub-agent specs to run CONCURRENTLY. Each spec: { task (required), role, max_turns, tools }. ' +
              'Spawns up to 5 sub-agents in parallel (allSettled — one failing worker does not cancel the others) and returns a combined per-worker report.',
            items: {
              type: 'object',
              properties: {
                task: { type: 'string', description: 'The precise task for this worker' },
                role: { type: 'string', enum: SUBAGENT_ROLE_NAMES, description: 'Role for this worker (default researcher)' },
                max_turns: { type: 'number', description: 'Turn cap for this worker (default 6)' },
                tools: { type: 'array', items: { type: 'string' }, description: 'Optional tool allowlist for this worker' },
              },
              required: ['task'],
            },
          },
        },
        required: [],
      },
    },
    async handler(args, ctx) {
      if (Array.isArray(args.workers)) {
        // Empty workers array with no task: guide the caller instead of
        // falling through to the confusing "requires a task" error.
        if (args.workers.length === 0 && !String(args.task ?? '').trim()) {
          ctx.onProgress?.({ type: 'spawn_done' });
          return {
            ok: false,
            text:
              'spawn_agent: provide either a "task" or a non-empty "workers" array of ' +
              '{ task, role?, max_turns?, tools? } specs to run concurrently.',
          };
        }
        if (args.workers.length > 0) {
          const res = await runWorkers(args.workers, ctx);
          ctx.onProgress?.({ type: 'spawn_done' });
          return res;
        }
      }
      const r = await spawnOne(normalizeWorker(args), ctx);
      ctx.onProgress?.({ type: 'spawn_done' });
      return { ok: r.ok, text: r.text };
    },
  },

  todo: {
    schema: {
      name: 'todo',
      description:
        'Manage the session task list for multi-step work. Keep a visible checklist so you and the user can track progress. action: "add" (text), "update" (id, status and/or text), "complete" (id), "delete" (id), "list".',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'update', 'complete', 'delete', 'list'],
            description: 'What to do',
          },
          id: { type: 'string', description: 'Task id (for update/complete/delete)' },
          text: { type: 'string', description: 'Task text (for add, or new text for update)' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed'],
            description: 'New status (for update)',
          },
        },
        required: ['action'],
      },
    },
    async handler(args) {
      const action = String(args.action ?? '');
      switch (action) {
        case 'add': {
          const t = addTodo(String(args.text ?? ''));
          return { ok: true, text: `Added task ${t.id}: ${t.text}\n\n${todoBlock()}` };
        }
        case 'list':
          return { ok: true, text: todoBlock() };
        case 'complete': {
          const ok = updateTodoStatus(String(args.id ?? ''), 'completed');
          return { ok, text: ok ? `Completed ${args.id}\n\n${todoBlock()}` : `No task ${args.id}` };
        }
        case 'delete': {
          const ok = deleteTodo(String(args.id ?? ''));
          return { ok, text: ok ? `Deleted ${args.id}\n\n${todoBlock()}` : `No task ${args.id}` };
        }
        case 'update': {
          const id = String(args.id ?? '');
          if (args.status) updateTodoStatus(id, args.status as TodoStatus);
          if (args.text) updateTodoText(id, String(args.text));
          return { ok: true, text: `Updated ${id}\n\n${todoBlock()}` };
        }
        default:
          return { ok: false, text: `Unknown todo action: ${action}` };
      }
    },
  },
};

export function getToolSchemas(only?: (name: string) => boolean): ToolSchema[] {
  const builtins: ToolSchema[] = Object.values(definitions)
    .filter((d) => !only || only(d.schema.name))
    .map((d) => ({
      type: 'function' as const,
      function: d.schema,
    }));
  if (only) return builtins;
  // Open Tool Bus: merge external MCP tools + the skills loader when present.
  // (Filtered callers — sub-agents, swarm workers — always get a fixed set.)
  return [
    ...builtins,
    ...allMcpToolSchemas(),
    ...(getSkills().length > 0 ? [useSkillToolSchema()] : []),
  ];
}

export function getToolNames(): string[] {
  return [
    ...Object.keys(definitions),
    ...mcpServerNames().flatMap((s) =>
      allMcpToolSchemas()
        .filter((t) => t.function.name.startsWith(`mcp_${s}_`))
        .map((t) => t.function.name),
    ),
    ...(getSkills().length > 0 ? ['use_skill'] : []),
  ];
}

export async function executeTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  // ── Open Tool Bus dispatch (before the builtin registry) ────────────────
  if (name === 'use_skill') {
    let a: Record<string, any> = {};
    try {
      a = repairToolArgsJson(rawArgs ?? '') ?? {};
    } catch {
      /* fall through to error below */
    }
    return useSkill(String(a.name ?? ''));
  }
  if (name.startsWith('mcp_')) {
    if (ctx.mode === 'plan') {
      return {
        ok: false,
        text: `Blocked in PLAN mode: "${name}" is an external MCP tool with unknown side effects. Switch to ACT mode (/act) to use it.`,
      };
    }
    let a: Record<string, any> = {};
    try {
      a = repairToolArgsJson(rawArgs ?? '') ?? {};
    } catch {
      a = { input: String(rawArgs ?? '') };
    }
    try {
      return await executeMcpTool(name, a);
    } catch (e: any) {
      return { ok: false, text: `MCP tool ${name} failed: ${e?.message ?? e}` };
    }
  }

  const def = definitions[name];
  if (!def) {
    return {
      ok: false,
      text: `Unknown tool: ${name}. Available tools: ${getToolNames().join(', ')}`,
    };
  }

  // Repair + parse the arguments. Models — especially smaller/local ones —
  // emit fenced, single-quoted, or trailing-comma JSON; repairing here is
  // free while failing costs a whole provider turn.
  let args: Record<string, any> | undefined;
  try {
    args = repairToolArgsJson(rawArgs ?? '');
  } catch {
    args = undefined;
  }
  if (args === undefined) {
    return {
      ok: false,
      text: `Invalid JSON arguments for tool ${name} (auto-repair failed): ${String(rawArgs ?? '').slice(0, 200)}`,
    };
  }
  // Fix type drift against the schema ("5" → 5, "true" → true, {…} → […]).
  args = coerceArgsToSchema(args, def.schema) as Record<string, any>;

  // Loop sensing: nudge at the 3rd identical call, block + replay the cached
  // result at the 6th (backpressure engineering — see loopsensor.ts).
  const sensor = ctx.loopSensor ?? new LoopSensor();
  const verdict = sensor.observe({ name, args: String(rawArgs ?? '') });
  if (!verdict.allow) {
    return {
      ok: false,
      text: `${verdict.cachedResult ?? '(no cached result)'}\n\n${verdict.nudge}`,
    };
  }

  try {
    const res = await def.handler(args, ctx);
    if (verdict.nudge) {
      res.text = `${res.text}\n\n${verdict.nudge}`;
    }
    sensor.remember({ name, args: String(rawArgs ?? '') }, res.text);
    // Central result bounding: no single tool result may flood the context
    // window (head+tail kept, middle elided with an explicit notice).
    const t = truncateToolText(res.text);
    return t.truncated ? { ok: res.ok, text: t.text } : res;
  } catch (e: any) {
    return { ok: false, text: `Tool ${name} threw: ${e?.message ?? e}` };
  }
}

