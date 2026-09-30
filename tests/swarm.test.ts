/**
 * Tests for Swarm Mode (src/swarm.ts) + the swarm tool plumbing — fake
 * providers, real temp git repos, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runSwarm, worktreeCwdFor, swarmCleanup, lastSwarmSummary } from '../src/swarm.js';
import type { AIProvider, ChatMessage, StreamOptions, ToolSchema } from '../src/types.js';

class ScriptedProvider implements AIProvider {
  readonly kind = 'openai' as const;
  readonly model = 'fake';
  constructor(private script: ChatMessage[]) {}
  async streamComplete(options: StreamOptions): Promise<ChatMessage> {
    const msg = this.script.shift();
    if (!msg) throw new Error('fake provider script exhausted');
    if (typeof msg.content === 'string') options.onToken({ type: 'text', text: msg.content });
    return msg;
  }
}

/** Simple in-memory tool executor simulating edits inside a cwd. */
function makeTools() {
  const writes = new Map<string, string[]>();
  const schemas: ToolSchema[] = [
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'write',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
    },
  ];
  const runTool = async (name: string, rawArgs: string, cwd: string) => {
    const args = JSON.parse(rawArgs);
    if (name !== 'write_file') return { ok: false, text: 'unknown tool' };
    const list = writes.get(cwd) ?? [];
    list.push(args.path);
    writes.set(cwd, list);
    return { ok: true, text: `wrote ${args.path}` };
  };
  return { writes, schemas, runTool };
}

async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astro-swarm-'));
  const { runShell } = await import('../src/tools/shell.js');
  await runShell('git init -q', { cwd: dir });
  await runShell('git config user.email t@t', { cwd: dir });
  await runShell('git config user.name t', { cwd: dir });
  await fs.writeFile(path.join(dir, 'README.md'), '# t\n', 'utf8');
  await runShell('git add -A && git commit -qm init', { cwd: dir });
  return dir;
}

test('planner JSON is salvaged from fences/prose and workers are normalized', async () => {
  const planText =
    'Sure! Here is the plan:\n```json\n{"workers":[{"name":"Docs Writer","task":"rewrite docs","role":"researcher","files":["README.md"]},{"task":"add rate limiting","role":"builder"},{"task":"add rate limiting again","role":"builder"}]}\n```';
  // Workers run CONCURRENTLY, so a single scripted sequence would be racy.
  // Route deterministically: the planner call has no "swarm worker" in the
  // user task; each worker's task names its role/slug in the system prompt.
  const researcherMsg: ChatMessage = { role: 'assistant', content: 'README should say X. Recommend: rewrite intro.' };
  const builderMsgs: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', name: 'write_file', arguments: '{"path":"src/rl.ts","content":"export {}"}' }],
    },
    { role: 'assistant', content: 'done, wrote the file' },
  ];
  const idleMsgs: ChatMessage[] = [{ role: 'assistant', content: 'nothing to do' }];
  const provider = new (class implements AIProvider {
    readonly kind = 'openai' as const;
    readonly model = 'fake';
    async streamComplete(options: StreamOptions): Promise<ChatMessage> {
      const userMsg = String(options.messages.find((m) => m.role === 'user')?.content ?? '');
      if (!userMsg.includes('swarm worker')) {
        return { role: 'assistant', content: planText }; // planner call
      }
      if (userMsg.includes('research')) return researcherMsg;
      if (userMsg.includes('again')) return idleMsgs[0]; // idle builder
      // Writing builder: tool call on its first turn, wrap-up after results.
      if (options.messages.some((m) => m.role === 'tool')) return builderMsgs[1];
      return builderMsgs[0];
    }
  })();
  const repo = await makeTempRepo();
  try {
    const t = makeTools();
    const events: string[] = [];
    const r = await runSwarm({
      goal: 'improve docs and add rate limiting',
      cwd: repo,
      provider,
      toolSchemas: t.schemas,
      runTool: t.runTool,
      workerMaxTurns: 4,
      onEvent: (e) => events.push(e.type),
    });
    assert.equal(r.workers.length, 3);
    assert.equal(r.workers[0].name, 'docs-writer'); // slugified
    assert.equal(r.workers[0].role, 'researcher');
    // Second researcher demoted to builder by the ≤1 researcher rule.
    assert.equal(r.workers[2].role, 'builder');
    assert.ok(events.includes('plan'));
    assert.ok(events.includes('swarm_done'));
    // One builder merged its branch; researcher was skipped (no merge);
    // the idle builder did no work → failed (and not merged).
    assert.equal(r.merged.length, 1);
    assert.ok(r.workers[0].status === 'skipped');
    const builderStatuses = [r.workers[1].status, r.workers[2].status].sort();
    assert.deepEqual(builderStatuses, ['failed', 'merged']);
    // The write happened in the worker's ISOLATED worktree, not the repo.
    const repoFiles = await fs.readdir(repo, { recursive: true });
    assert.ok(!repoFiles.includes('src/rl.ts'), 'worker edit must not leak into main tree pre-merge');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('fallback plan runs one solo builder when the planner fails', async () => {
  const provider = new ScriptedProvider([
    { role: 'assistant', content: 'no json here at all' }, // planner fails → fallback
    { role: 'assistant', content: 'I looked around.' }, // worker never calls tools → skipped
  ]);
  const repo = await makeTempRepo();
  try {
    const t = makeTools();
    const r = await runSwarm({
      goal: 'single task',
      cwd: repo,
      provider,
      toolSchemas: t.schemas,
      runTool: t.runTool,
    });
    assert.equal(r.workers.length, 1);
    assert.equal(r.workers[0].name, 'solo');
    assert.equal(r.merged.length, 0); // no work → skipped, nothing merged
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('worktreeCwdFor mirrors worktree paths and swarmCleanup discards branches', async () => {
  const repo = await makeTempRepo();
  try {
    const provider = new ScriptedProvider([
      { role: 'assistant', content: '{"workers":[{"name":"alpha","task":"write a file","role":"builder"}]}' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', name: 'write_file', arguments: '{"path":"alpha.txt","content":"hi"}' }],
      },
      { role: 'assistant', content: 'done' },
    ]);
    const t = makeTools();
    const r = await runSwarm({
      goal: 'one writer',
      cwd: repo,
      provider,
      toolSchemas: t.schemas,
      runTool: t.runTool,
    });
    assert.equal(r.merged.length, 1);
    // The tool actually executed inside the mirrored worktree path.
    assert.equal(t.writes.size, 1);
    const [wtCwd] = [...t.writes.keys()];
    assert.equal(wtCwd, worktreeCwdFor(repo, 'alpha'));
    // Cleanup discards every swarm branch.
    const report = await swarmCleanup(repo);
    assert.ok(report.includes('alpha'));
    const { runShell } = await import('../src/tools/shell.js');
    const branches = await runShell('git branch --list "astrocode/*"', { cwd: repo });
    assert.ok(!branches.text.includes('astrocode/swarm-alpha'));
    // Summary helper reflects the last recorded swarm.
    recordSwarmForTest(r);
    assert.ok(lastSwarmSummary()!.includes('alpha'));
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

// The TUI/registry records results via the module-level store.
import { recordSwarmResult } from '../src/swarm.js';
function recordSwarmForTest(r: Parameters<typeof recordSwarmResult>[0]): void {
  recordSwarmResult(r);
}
