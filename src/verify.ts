/**
 * Post-edit verification & auto-commit for AstroCode (Aider-style guardrails).
 *
 * After the agent edits files, AstroCode can automatically:
 *   - run the project's lint/test/typecheck scripts (auto-detected from
 *     package.json, Makefile, Cargo.toml, or go.mod), and
 *   - commit the changes with a generated message.
 *
 * Toggle with ASTROCODE_VERIFY=1 and ASTROCODE_AUTOCOMMIT=1.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { runShell } from './tools/shell.js';

export interface VerifyScripts {
  build?: string;
  lint?: string;
  test?: string;
  typecheck?: string;
  source: string;
}

export async function detectScripts(cwd: string): Promise<VerifyScripts> {
  // Node / package.json
  try {
    const raw = await fs.readFile(path.join(cwd, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    const s: Record<string, string> = pkg.scripts ?? {};
    return {
      build: s.build,
      lint: s.lint,
      test: s.test || s.tests,
      typecheck: s.typecheck || s.tsc || s['type-check'],
      source: 'package.json',
    };
  } catch {
    /* not a node project */
  }
  // Makefile
  try {
    const txt = await fs.readFile(path.join(cwd, 'Makefile'), 'utf8');
    const has = (t: string) => new RegExp(`^${t}:`, 'm').test(txt);
    return {
      build: has('build') ? 'make build' : undefined,
      lint: has('lint') ? 'make lint' : undefined,
      test: has('test') ? 'make test' : undefined,
      source: 'Makefile',
    };
  } catch {
    /* no Makefile */
  }
  // Cargo (Rust)
  try {
    await fs.access(path.join(cwd, 'Cargo.toml'));
    return {
      build: 'cargo build',
      test: 'cargo test',
      lint: 'cargo clippy',
      source: 'Cargo.toml',
    };
  } catch {
    /* not cargo */
  }
  // Go
  try {
    await fs.access(path.join(cwd, 'go.mod'));
    return {
      build: 'go build ./...',
      test: 'go test ./...',
      source: 'go.mod',
    };
  } catch {
    /* not go */
  }
  return { source: 'none' };
}

export interface VerifyResult {
  ran: string[];
  text: string;
  ok: boolean;
}

/** Run typecheck → lint → test (whatever is detected) and summarise. */
export async function runVerify(cwd: string): Promise<VerifyResult> {
  const scripts = await detectScripts(cwd);
  const order: Array<'typecheck' | 'lint' | 'test'> = ['typecheck', 'lint', 'test'];
  const ran: string[] = [];
  const parts: string[] = [];
  let ok = true;
  for (const key of order) {
    const cmd = scripts[key];
    if (!cmd) continue;
    ran.push(cmd);
    const res = await runShell(cmd, { cwd, timeoutMs: 60_000 });
    const head = res.text.split('\n').slice(0, 40).join('\n');
    parts.push(`$ ${cmd}  [${res.ok ? 'pass' : 'FAIL'}]\n${head}`);
    if (!res.ok) ok = false;
  }
  if (ran.length === 0) {
    return { ran, text: `No lint/test scripts detected (${scripts.source}).`, ok: true };
  }
  return {
    ran,
    text: `Verified ${ran.length} script(s): ${ran.join(', ')}\n\n${parts.join('\n\n')}`,
    ok,
  };
}

/** Stage all changes and commit with an (optionally) provided message. */
export async function autoCommit(
  cwd: string,
  message?: string,
): Promise<{ ok: boolean; text: string }> {
  const status = await runShell('git status --porcelain', { cwd });
  if (!status.text.trim()) {
    return { ok: true, text: 'Nothing to commit — working tree clean.' };
  }
  const add = await runShell('git add -A', { cwd });
  if (!add.ok) return { ok: false, text: `git add failed: ${add.text}` };
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const msg = message || `astrocode: automated commit ${stamp}`;
  const commit = await runShell(`git commit -m "${msg.replace(/"/g, '\\"')}"`, { cwd });
  return { ok: commit.ok, text: commit.ok ? `Committed: ${msg}` : `commit failed: ${commit.text}` };
}
