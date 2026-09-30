/**
 * Tests for the Open Tool Bus: MCP client (src/mcp.ts), skills loader
 * (src/skills.ts), and the MCP server (src/serve.ts) — fake servers over real
 * child processes, temp dirs, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '..');

// A minimal MCP server for the client tests: speaks newline-delimited
// JSON-RPC over stdio, exposes one tool (echo) and one failing tool.
const SERVER_SCRIPT = `
const rl = require('node:readline').createInterface({ input: process.stdin });
function send(m) { process.stdout.write(JSON.stringify(m) + '\\n'); }
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return;
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'echo', description: 'Echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      { name: 'boom', description: 'Always fails', inputSchema: { type: 'object', properties: {} } }
    ] } });
  } else if (msg.method === 'tools/call') {
    if (msg.params.name === 'echo') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo: ' + msg.params.arguments.text }], isError: false } });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'kaboom' }], isError: true } });
    }
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } });
  }
});
`;

async function writeServer(root: string): Promise<string> {
  const file = path.join(root, 'fake-mcp-server.cjs');
  await fs.writeFile(file, SERVER_SCRIPT, 'utf8');
  return file;
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'astro-mcp-'));
}

// ── MCP client ──────────────────────────────────────────────────────────────

test('MCP client: connect, list namespaced tools, call, error handling', async () => {
  const tmp = await makeTempDir();
  const serverFile = await writeServer(tmp);
  await fs.mkdir(path.join(tmp, '.astrocode'), { recursive: true });
  await fs.writeFile(
    path.join(tmp, '.astrocode', 'mcp.json'),
    JSON.stringify({ mcpServers: { fake: { command: 'node', args: [serverFile] } } }),
    'utf8',
  );
  const { connectAllMcp, allMcpToolSchemas, executeMcpTool, disconnectAllMcp } = await import('../src/mcp.js');
  try {
    const { connected, failed } = await connectAllMcp(tmp);
    assert.deepEqual(connected, ['fake']);
    assert.equal(failed.length, 0);

    const tools = allMcpToolSchemas();
    assert.equal(tools.length, 2);
    const names = tools.map((t) => t.function.name).sort();
    assert.deepEqual(names, ['mcp_fake_boom', 'mcp_fake_echo']);

    const ok = await executeMcpTool('mcp_fake_echo', { text: 'hi' });
    assert.ok(ok.ok);
    assert.equal(ok.text, 'echo: hi');

    const bad = await executeMcpTool('mcp_fake_boom', {});
    assert.equal(bad.ok, false);
    assert.ok(bad.text.includes('kaboom'));

    const unknown = await executeMcpTool('mcp_fake_nope', {});
    assert.equal(unknown.ok, false);
  } finally {
    disconnectAllMcp();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('MCP client: unreachable server lands in failed, never throws', async () => {
  const tmp = await makeTempDir();
  await fs.mkdir(path.join(tmp, '.astrocode'), { recursive: true });
  await fs.writeFile(
    path.join(tmp, '.astrocode', 'mcp.json'),
    JSON.stringify({ mcpServers: { ghost: { command: 'astrocode-does-not-exist-xyz' } } }),
    'utf8',
  );
  const { connectAllMcp, disconnectAllMcp } = await import('../src/mcp.js');
  try {
    const { connected, failed } = await connectAllMcp(tmp, { timeoutMs: 2_000 });
    assert.equal(connected.length, 0);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].name, 'ghost');
  } finally {
    disconnectAllMcp();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ── skills ──────────────────────────────────────────────────────────────────

test('skills: discover, progressive disclosure (catalog → body on use)', async () => {
  const tmp = await makeTempDir();
  const skillDir = path.join(tmp, '.astrocode', 'skills', 'deploy');
  await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: deploy\ndescription: Ship the release step by step\n---\n\n1. bump version\n2. npm publish\n',
    'utf8',
  );
  await fs.writeFile(path.join(skillDir, 'scripts', 'go.sh'), '#!/bin/sh\n', 'utf8');
  const { loadSkills, getSkills, useSkill, skillsPromptBlock } = await import('../src/skills.js');
  try {
    const catalog = await loadSkills(tmp);
    assert.ok(catalog.includes('deploy'));
    assert.ok(catalog.includes('Ship the release step by step'));
    assert.equal(getSkills().length, 1);

    // Catalog block in the prompt mentions the skill but NOT the body steps.
    const block = skillsPromptBlock();
    assert.ok(block.includes('deploy'));
    assert.ok(!block.includes('npm publish'));

    // use_skill loads the body exactly once into context.
    const res = useSkill('deploy');
    assert.ok(res.ok);
    assert.ok(res.text.includes('npm publish'));
    assert.ok(res.text.includes('scripts/go.sh'));

    const miss = useSkill('nope');
    assert.equal(miss.ok, false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ── MCP server mode ─────────────────────────────────────────────────────────

test('MCP server: initialize → tools/list → tools/call over stdio (no writes by default)', async () => {
  const tmp = await makeTempDir();
  const { spawn } = await import('node:child_process');
  // Always run from source via tsx: a stale dist/ may predate the serve mode.
  const cmd = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [cmd, path.join(projectRoot, 'src', 'index.tsx'), 'serve'], {
    cwd: tmp,
    env: { ...process.env, ASTROCODE_SERVE_WRITES: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'hello.txt' } } }) + '\n');
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'write_file', arguments: { path: 'x.txt', content: 'y' } } }) + '\n');

    const lines: any[] = [];
    await new Promise<void>((resolve) => {
      let buf = '';
      const timer = setTimeout(resolve, 8_000);
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            lines.push(JSON.parse(line));
          } catch {
            /* ignore */
          }
          if (lines.length >= 4) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });

    const init = lines.find((l) => l.id === 1);
    assert.ok(init?.result?.serverInfo?.name === 'astrocode');

    const list = lines.find((l) => l.id === 2);
    const names = (list?.result?.tools ?? []).map((t: any) => t.name);
    assert.ok(names.includes('read_file'));
    assert.ok(!names.includes('write_file'), 'mutating tools hidden on read-only server');
    assert.ok(!names.includes('spawn_agent'), 'delegation tool always hidden');

    const read = lines.find((l) => l.id === 3);
    assert.equal(read?.result?.isError, true); // file doesn't exist — fine, tool RAN
    assert.ok(String(read?.result?.content?.[0]?.text).includes('read_file failed'));

    const write = lines.find((l) => l.id === 4);
    assert.equal(write?.result?.isError, true);
    assert.ok(String(write?.result?.content?.[0]?.text).includes('not exposed'));
  } finally {
    child.kill('SIGTERM');
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
