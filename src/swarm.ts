/**
 * Swarm Mode for AstroCode — parallel, worktree-isolated workers.
 *
 * /swarm <goal> → plan → spawn one full agent per subtask in an ephemeral git
 * worktree → merge winners back, report failures. Each worker is a bounded
 * mini agent loop (runSubAgent's engine) but UNLIKE sub-agents, swarm workers
 * ARE allowed to edit — inside their own isolated worktree checkout, so the
 * main working tree is never touched until an explicit, reviewed merge.
 *
 * Safety model (mechanical, not prompt-based):
 * - every worker is confined to `worktrees/swarm/<name>` (createWorktree);
 * - merges go through mergeWorktree which commits + merges the branch;
 * - worker branches are prefixed `astrocode/` and never force-pushed;
 * - the swarm registry lives in `.astrocode/swarm.json` (worker bookkeeping).
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AIProvider, ToolSchema, ToolResult } from './types.js';
import { runSubAgent, type SubAgentEvent } from './subagent.js';
import {
  createWorktree,
  runInWorktree,
  mergeWorktree,
  discardWorktree,
} from './worktree.js';

// ── types ───────────────────────────────────────────────────────────────────

export type SwarmWorkerStatus = 'planned' | 'starting' | 'working' | 'merging' | 'merged' | 'failed' | 'skipped';

export interface SwarmWorker {
  /** Short unique slug (used for the worktree + branch name). */
  name: string;
  task: string;
  role: string;
  status: SwarmWorkerStatus;
  /** Worktree branch, once created (astrocode/<name>). */
  branch?: string;
  /** 1-based index in spawn order (display order). */
  index: number;
  turns?: number;
  actions?: number;
  /** Planner-provided files this worker owns (informational). */
  files?: string[];
  error?: string;
}

export interface SwarmPlan {
  goal: string;
  workers: Array<Pick<SwarmWorker, 'name' | 'task' | 'role' | 'files'>>;
}

export type SwarmEvent =
  | { type: 'plan'; plan: SwarmPlan }
  | { type: 'worker_status'; worker: string; status: SwarmWorkerStatus }
  | { type: 'worker_tool'; worker: string; tool: string }
  | { type: 'worker_done'; worker: string; ok: boolean; turns: number; actions: number }
  | { type: 'merge_result'; worker: string; ok: boolean; text: string }
  | { type: 'swarm_done'; merged: number; failed: number };

export interface SwarmOptions {
  goal: string;
  cwd: string;
  provider: AIProvider;
  /** Read-only tool schemas workers may call inside their worktree. */
  toolSchemas: ToolSchema[];
  /** Executes a tool INSIDE a worker's worktree. Provided by the registry. */
  runTool: (name: string, args: string, worktreeCwd: string) => Promise<ToolResult>;
  /** Skip the model planner and derive tasks from the goal alone. */
  noPlan?: boolean;
  /** Planner turn cap (default 4). */
  planMaxTurns?: number;
  /** Per-worker turn cap (default 24 — swarms get real budgets). */
  workerMaxTurns?: number;
  /** Wall-clock cap per worker in ms (default 240_000). */
  workerTimeoutMs?: number;
  /** Hard cap on planned workers (default 5, matches spawn_agent). */
  maxWorkers?: number;
  onEvent?: (e: SwarmEvent) => void;
  onCharge?: (input: string, output: string) => void;
}

export interface SwarmResult {
  ok: boolean;
  goal: string;
  workers: SwarmWorker[];
  merged: string[];
  failed: string[];
  /** Combined human-readable report (per-worker + merge outcomes). */
  text: string;
}

// ── planner ─────────────────────────────────────────────────────────────────

const PLANNER_SYSTEM = `You are the SWARM PLANNER of AstroCode. The user gives you a goal for a team of parallel coding agents. Decompose it into AT MOST {MAX} independent, non-overlapping subtasks, each small enough for one agent with a {TURNS}-turn budget.

Each subtask must be:
- implementable in ISOLATION (workers get separate git worktrees; they cannot see each other's changes)
- in DIFFERENT areas of the codebase (overlapping files = guaranteed merge conflicts)

Respond with ONLY a JSON object (no prose, no fences):
{"workers":[{"name":"short-kebab-slug","task":"imperative one-sentence task with file paths","role":"builder","files":["src/foo.ts"]}]}

Roles: builder (writes code), researcher (read-only recon that reports files-to-touch instead of editing). Use researcher ONLY for tasks that need no edits; at most one researcher per swarm.`;

const ROLE_GUIDANCE: Record<string, string> = {
  builder:
    'You are a SWARM BUILDER. You may edit files with apply_patch/write_file/edit_file and run non-destructive commands (typecheck/tests) INSIDE your worktree. When done, report exactly what you changed and why.',
  researcher:
    'You are a SWARM RESEARCHER. Read-only recon: do not edit files. Your report should list concrete findings AND recommended file changes another agent can implement.',
};

function slugify(s: string, fallback: string): string {
  const slug = s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug || fallback;
}

/** One cheap tool-less call: decompose the goal into a JSON worker plan. */
async function planSwarm(opts: SwarmOptions, maxWorkers: number): Promise<SwarmPlan> {
  const system = PLANNER_SYSTEM.replace('{MAX}', String(maxWorkers)).replace('{TURNS}', String(opts.workerMaxTurns ?? 24));
  const messages = [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: `Swarm goal: ${opts.goal}\nWorkspace: ${opts.cwd}` },
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await opts.provider.streamComplete({
      messages,
      tools: [],
      signal: controller.signal,
      onToken: () => {},
    });
    opts.onCharge?.(system + opts.goal, res.content ?? '');
    // Salvage JSON from prose/fences (models love to decorate).
    const raw = res.content ?? '';
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`planner returned no JSON: ${raw.slice(0, 200)}`);
    const parsed = JSON.parse(m[0]) as { workers?: unknown };
    const workers = Array.isArray(parsed.workers) ? parsed.workers : [];
    if (workers.length === 0) throw new Error('planner returned an empty workers array');
    const usedNames = new Set<string>();
    const out: SwarmPlan['workers'] = [];
    let researcherCount = 0;
    for (const w of workers.slice(0, maxWorkers)) {
      const anyW = w as Record<string, unknown>;
      const task = String(anyW.task ?? '').trim();
      if (!task) continue;
      let role = String(anyW.role ?? 'builder').trim();
      if (role !== 'researcher') role = 'builder';
      if (role === 'researcher') researcherCount++;
      if (researcherCount > 1) role = 'builder';
      let name = slugify(String(anyW.name ?? task), `worker-${out.length + 1}`);
      while (usedNames.has(name)) name = `${name}-${out.length + 1}`;
      usedNames.add(name);
      const files = Array.isArray(anyW.files)
        ? anyW.files.map((f) => String(f)).filter(Boolean).slice(0, 12)
        : undefined;
      out.push({ name, task, role, files });
    }
    if (out.length === 0) throw new Error('planner produced no usable workers');
    return { goal: opts.goal, workers: out };
  } finally {
    clearTimeout(timer);
  }
}

/** Fallback plan: one builder for the whole goal (still worktree-isolated). */
function fallbackPlan(goal: string): SwarmPlan {
  return {
    goal,
    workers: [{ name: 'solo', task: goal, role: 'builder', files: undefined }],
  };
}

// ── registry (bookkeeping only) ─────────────────────────────────────────────

function registryPath(cwd: string): string {
  return path.join(cwd, '.astrocode', 'swarm.json');
}

interface SwarmRegistryFile {
  goal: string;
  updatedAt: string;
  workers: SwarmWorker[];
}

async function readRegistry(cwd: string): Promise<SwarmRegistryFile> {
  try {
    const raw = await fs.readFile(registryPath(cwd), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SwarmRegistryFile>;
    return {
      goal: String(parsed.goal ?? ''),
      updatedAt: String(parsed.updatedAt ?? ''),
      workers: Array.isArray(parsed.workers) ? parsed.workers : [],
    };
  } catch {
    return { goal: '', updatedAt: '', workers: [] };
  }
}

async function writeRegistry(cwd: string, workers: SwarmWorker[], goal: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(registryPath(cwd)), { recursive: true });
    await fs.writeFile(
      registryPath(cwd),
      JSON.stringify({ goal, updatedAt: new Date().toISOString(), workers }, null, 2),
      'utf8',
    );
  } catch {
    /* best effort */
  }
}

// ── runner ──────────────────────────────────────────────────────────────────

export async function runSwarm(opts: SwarmOptions): Promise<SwarmResult> {
  const maxWorkers = Math.max(1, Math.min(opts.maxWorkers ?? 5, 8));
  const emit = opts.onEvent ?? (() => {});
  const workers: SwarmWorker[] = [];

  // 1) Plan.
  let plan: SwarmPlan;
  if (opts.noPlan) {
    plan = fallbackPlan(opts.goal);
  } else {
    try {
      plan = await planSwarm(opts, maxWorkers);
    } catch {
      plan = fallbackPlan(opts.goal);
    }
  }
  plan.workers.forEach((w, i) =>
    workers.push({ ...w, status: 'planned', index: i + 1 }),
  );
  emit({ type: 'plan', plan });
  await writeRegistry(opts.cwd, workers, plan.goal);

  // 2) Run all workers concurrently (allSettled: one failure never cancels others).
  const limits = {
    maxTurns: opts.workerMaxTurns ?? 24,
    timeoutMs: opts.workerTimeoutMs ?? 240_000,
  };

  const settled = await Promise.allSettled(
    plan.workers.map(async (spec, i) => {
      const w = workers[i];
      const emitStatus = (status: SwarmWorkerStatus) => {
        w.status = status;
        emit({ type: 'worker_status', worker: w.name, status });
      };

      // 2a) Isolate: ephemeral worktree + branch per worker.
      emitStatus('starting');
      const created = await createWorktree(opts.cwd, `swarm-${w.name}`);
      if (!created.ok) throw new Error(`worktree create failed: ${created.text}`);
      w.branch = `astrocode/swarm-${w.name}`;

      // 2b) Work: a full agent loop INSIDE the worktree checkout.
      emitStatus('working');
      const isResearcher = spec.role === 'researcher';
      const workerSystem =
        `You are swarm worker #${w.index} (${spec.role}) of AstroCode, part of a parallel team ` +
        `working from ISOLATED git worktrees. Your branch: ${w.branch}. ` +
        `Stay strictly within your task; another worker handles everything else. ` +
        (isResearcher ? ROLE_GUIDANCE.researcher : ROLE_GUIDANCE.builder) +
        `\n\nRules:\n` +
        `1. Work only on your task; do not modify unrelated files.\n` +
        `2. If blocked (merge risk, missing info), STOP and report instead of forcing it.\n` +
        `3. Final report: what changed (paths) and how it was verified (commands + results), or why you stopped.`;

      const sub = await runSubAgent({
        task: `${workerSystem}\n\nTASK: ${spec.task}`,
        role: isResearcher ? 'researcher' : 'reviewer',
        // Note: cwd is display-only here; all tool calls are redirected below.
        cwd: opts.cwd,
        provider: opts.provider,
        tools: opts.toolSchemas,
        maxTurns: limits.maxTurns,
        timeoutMs: limits.timeoutMs,
        onCharge: opts.onCharge,
        onEvent: (e: SubAgentEvent) => {
          if (e.type === 'tool') emit({ type: 'worker_tool', worker: w.name, tool: e.tool });
        },
        runTool: (name, rawArgs) => opts.runTool(name, rawArgs, worktreeCwdFor(opts.cwd, w.name)),
      });
      w.turns = sub.turns;
      w.actions = sub.actions;

      // 2c) Arbiter: researchers never merge; failed/empty workers don't either.
      const report = sub.text;
      const emptyRun = sub.actions === 0 && sub.turns <= 2 && !isResearcher;
      if (isResearcher || emptyRun) {
        emitStatus(isResearcher ? 'skipped' : 'failed');
        if (!isResearcher) w.error = 'no work done (skipped merge)';
        return;
      }
      emitStatus('merging');
      const merged = await mergeWorktree(opts.cwd, `swarm-${w.name}`);
      emit({ type: 'merge_result', worker: w.name, ok: merged.ok, text: merged.text });
      if (merged.ok) {
        emitStatus('merged');
      } else {
        // Leave the branch in place — nothing is lost; the user can retry the
        // merge manually. Mark failed so the summary says so.
        w.error = 'merge failed (branch kept for manual retry)';
        emitStatus('failed');
      }
    }),
  );

  const merged: string[] = [];
  const failed: string[] = [];
  settled.forEach((s, i) => {
    const w = workers[i];
    if (s.status === 'rejected') {
      w.status = 'failed';
      w.error = s.reason instanceof Error ? s.reason.message : String(s.reason);
      failed.push(w.name);
    } else if (w.status === 'merged') {
      merged.push(w.name);
    } else if (w.status === 'failed' || w.status === 'skipped') {
      failed.push(w.name);
    }
  });

  emit({ type: 'swarm_done', merged: merged.length, failed: failed.length });
  await writeRegistry(opts.cwd, workers, plan.goal);

  // 3) Report.
  const sections = workers.map((w) => {
    const statusLine =
      w.status === 'merged'
        ? '✓ merged'
        : w.status === 'skipped'
          ? '→ research only (no merge)'
          : w.status === 'failed'
            ? `✗ failed${w.error ? ` — ${w.error}` : ''}`
            : w.status;
    return (
      `#${w.index} ${w.name} [${w.role}] — ${statusLine}\n` +
      `  task: ${w.task}\n` +
      `  ${w.turns ?? 0} turn(s) · ${w.actions ?? 0} action(s) · branch: ${w.branch ?? '(none)'}`
    );
  });
  const mergedCount = merged.length;
  const ok = mergedCount > 0 && failed.length === 0;
  const text =
    `Swarm "${plan.goal}" — ${mergedCount}/${workers.length} worker(s) merged · ${failed.length} failed/skipped\n\n` +
    sections.join('\n\n') +
    `\n\nInspect with: git log --oneline astrocode/swarm-* · clean up with: /swarm cleanup`;

  return { ok, goal: plan.goal, workers, merged, failed, text };
}// ── worktree path helper (kept in sync with worktree.ts) ─────────────────── 

/**
 * Recompute a swarm worker's worktree path without touching git — used to
 * redirect tool execution into the worker's checkout. Mirrors dirFor() in
 * worktree.ts (slug + sanitize logic kept identical).
 */
export function worktreeCwdFor(cwd: string, workerName: string): string {
  const slug = cwd.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').slice(0, 80);
  const sanitize = (name: string): string => {
    const clean = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return clean || 'sandbox';
  };
  return path.join(os.tmpdir(), 'astrocode-worktrees', slug, sanitize(`swarm-${workerName}`));
}

// ── session-level swarm bookkeeping (for /swarm status) ───────────────────

let lastSwarm: SwarmResult | null = null;

/** Record a finished swarm so /swarm status can show it. Called by the TUI. */
export function recordSwarmResult(r: SwarmResult): void {
  lastSwarm = r;
}

/** One-paragraph-per-worker summary of the most recent swarm (or null). */
export function lastSwarmSummary(): string | null {
  if (!lastSwarm) return null;
  const rows = lastSwarm.workers.map(
    (w) =>
      `  #${w.index} ${w.name} [${w.role}] — ${w.status}${w.error ? ` (${w.error})` : ''}`,
  );
  return `Goal: ${lastSwarm.goal}\n  merged: ${lastSwarm.merged.join(', ') || '(none)'} · failed: ${lastSwarm.failed.join(', ') || '(none)'}\n${rows.join('\n')}`;
}

/** Discard every tracked swarm worktree + branch. Returns a report string. */
export async function swarmCleanup(cwd: string): Promise<string> {
  const reg = await readRegistry(cwd);
  if (reg.workers.length === 0) {
    return 'No swarm worktrees to clean up (no swarm has run in this repo).';
  }
  const results: string[] = [];
  for (const w of reg.workers) {
    if (!w.branch) continue;
    const name = w.branch.replace(/^astrocode\//, '');
    const r = await discardWorktree(cwd, name);
    results.push(`  ${w.branch}: ${r.ok ? 'discarded' : r.text.split('\n')[0]}`);
  }
  await writeRegistry(cwd, [], reg.goal);
  return `Swarm cleanup (${reg.workers.length} worker(s)):\n${results.join('\n')}`;
}
