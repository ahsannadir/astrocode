/**
 * Unit tests for the tool registry's safety guard and tool sets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  isDangerousCommand,
  getToolNames,
  READ_ONLY_TOOLS,
  PLAN_ALLOWED_TOOLS,
  executeTool,
} from '../src/tools/registry.js';

test('isDangerousCommand: flags destructive commands', () => {
  // Note: scoped paths (e.g. `rm -rf /home`, `rm -rf ./dist`) are deliberately
  // allowed — the guard blocks catastrophic targets, not scoped cleanups.
  const dangerous = [
    'rm -rf /',
    'rm -rf *',
    'sudo rm -rf .',
    'mkfs.ext4 /dev/sdb1',
    'dd if=/dev/zero of=/dev/sda',
    'git push --force origin main',
    'git push origin main --force',
    'git reset --hard HEAD',
    'chmod -R 777 /',
    'shutdown -h now',
    'reboot',
    ':(){ :|:& };:',
  ];
  for (const cmd of dangerous) {
    assert.equal(isDangerousCommand(cmd), true, `should flag: ${cmd}`);
  }
});

test('isDangerousCommand: allows normal commands', () => {
  const safe = [
    'npm test',
    'git push origin main',
    'git status',
    'node --version',
    'echo hello',
    'rm -rf ./node_modules/.cache', // scoped path is fine
    'mkdir -p dist',
    'cat package.json',
  ];
  for (const cmd of safe) {
    assert.equal(isDangerousCommand(cmd), false, `should allow: ${cmd}`);
  }
});

test('tool registry: core tools are registered', () => {
  const names = getToolNames();
  for (const t of ['read_file', 'write_file', 'edit_file', 'apply_patch', 'worktree', 'spawn_agent', 'todo', 'run_command']) {
    assert.ok(names.includes(t), `missing tool: ${t}`);
  }
});

test('executeTool: unknown tool and invalid JSON return clean errors', async () => {
  const unknown = await executeTool('no_such_tool', '{}', { cwd: '/' });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.text.includes('Unknown tool'));

  const badJson = await executeTool('list_dir', 'not json{', { cwd: '/' });
  assert.equal(badJson.ok, false);
  assert.ok(badJson.text.includes('Invalid JSON'));
});

test('executeTool: non-object args fall back to {} instead of crashing', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astro-tool-'));
  try {
    const r = await executeTool('list_dir', '[]', { cwd: tmp });
    assert.equal(r.ok, true); // lenient: treats bad args as {}
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('tool sets: plan mode permits read-only + planning aids only', () => {
  // Read-only tools must be plan-allowed.
  for (const t of READ_ONLY_TOOLS) {
    assert.ok(PLAN_ALLOWED_TOOLS.has(t), `read-only tool not plan-allowed: ${t}`);
  }
  // Mutating tools must NOT be plan-allowed.
  for (const t of ['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'worktree', 'run_command']) {
    assert.equal(PLAN_ALLOWED_TOOLS.has(t), false, `mutating tool plan-allowed: ${t}`);
  }
  // Delegation is a planning aid.
  assert.ok(PLAN_ALLOWED_TOOLS.has('spawn_agent'));
});
