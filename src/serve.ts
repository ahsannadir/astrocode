/**
 * MCP server mode for AstroCode — `astrocode serve` (the Open Tool Bus, part 3).
 *
 * Exposes AstroCode's own 15 built-in tools over the Model Context Protocol
 * (JSON-RPC 2.0 over stdio), so ANY other MCP-capable agent — Claude Code,
 * Codex, an editor — can delegate real work (file edits, searches, commands,
 * swarm status) to a local AstroCode instance. Read-only by default; enable
 * mutating tools explicitly with ASTROCODE_SERVE_WRITES=1.
 */
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import * as path from 'node:path';
import { executeTool } from './tools/registry.js';
import { getMemoryText } from './memory.js';
import { lastSwarmSummary } from './swarm.js';
import { discoverSkills } from './skills.js';

const VERSION = '1.3.0';

interface ServeOptions {
  cwd: string;
  /** Allow mutating tools (write/edit/patch/run_command/swarm). Default false. */
  allowWrites: boolean;
}

/** Tools never exposed over the bus, regardless of flags. */
const ALWAYS_HIDDEN = new Set(['spawn_agent', 'worktree', 'todo']);

function toolAllowed(name: string, opts: ServeOptions): boolean {
  if (ALWAYS_HIDDEN.has(name)) return false;
  const mutating =
    name === 'write_file' ||
    name === 'edit_file' ||
    name === 'multi_edit' ||
    name === 'apply_patch' ||
    name === 'run_command' ||
    name === 'swarm';
  return opts.allowWrites || !mutating;
}

/** Minimal handler surface of registry.executeTool we rely on. */
type Exec = (name: string, rawArgs: string, ctx: { cwd: string }) => Promise<{ ok: boolean; text: string }>;

export async function serveStdio(opts: ServeOptions): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const exec: Exec = executeTool as unknown as Exec;

  const send = (msg: unknown): void => {
    process.stdout.write(JSON.stringify(msg) + '\n');
  };

  const serverInfo = { name: 'astrocode', version: VERSION };
  const capabilities = { tools: {} };

  // Loaded lazily per listing so new skills on disk are picked up.
  async function toolDefs(): Promise<Array<{ name: string; description: string; inputSchema: unknown }>> {
    const { getToolNames } = await import('./tools/registry.js');
    const names = getToolNames().filter((n) => toolAllowed(n, opts));
    const registry = await import('./tools/registry.js');
    const defs: Array<{ name: string; description: string; inputSchema: unknown }> = [];
    for (const n of names) {
      // getToolSchemas returns {type:'function',function:{...}} wrappers.
      const schema = registry.getToolSchemas((x) => x === n)[0];
      if (!schema) continue;
      defs.push({
        name: schema.function.name,
        description: `[astrocode] ${schema.function.description}`,
        inputSchema: schema.function.parameters,
      });
    }
    return defs;
  }

  const server = {
    async initialize(params: any) {
      return {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities,
        serverInfo,
      };
    },
    async 'tools/list'() {
      return { tools: await toolDefs() };
    },
    async 'tools/call'(params: any) {
      const name = String(params?.name ?? '');
      if (!toolAllowed(name, opts)) {
        return {
          content: [{ type: 'text', text: `Tool "${name}" is not exposed over the bus (read-only server; set ASTROCODE_SERVE_WRITES=1 to enable writes).` }],
          isError: true,
        };
      }
      try {
        const res = await exec(name, JSON.stringify(params?.arguments ?? {}), { cwd: opts.cwd });
        return {
          content: [{ type: 'text', text: res.text }],
          isError: !res.ok,
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Tool error: ${e?.message ?? e}` }], isError: true };
      }
    },
    async 'prompts/list'() {
      return { prompts: [] };
    },
    async 'resources/list'() {
      return { resources: [] };
    },
  };

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') continue;

    // Notifications have no id — acknowledge nothing.
    if (msg.id === undefined || msg.id === null) {
      continue;
    }

    const handler = (server as Record<string, (p: any) => Promise<unknown>>)[msg.method];
    if (!handler) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      });
      continue;
    }
    try {
      const result = await handler(msg.params ?? {});
      send({ jsonrpc: '2.0', id: msg.id, result });
    } catch (e: any) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: String(e?.message ?? e) },
      });
    }
  }
}
