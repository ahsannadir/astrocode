/**
 * MCP (Model Context Protocol) client for AstroCode — the Open Tool Bus.
 *
 * Speaks JSON-RPC 2.0 over stdio to MCP servers (reference protocol:
 * modelcontextprotocol.io). External tools are merged into the agent's tool
 * list as `mcp_<server>_<tool>` and executed through executeTool like any
 * built-in. Config lives in `<cwd>/.astrocode/mcp.json`.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ToolSchema } from './types.js';

// ── config ──────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean; // default true
}

/** Read `.astrocode/mcp.json`: { "mcpServers": { name: {...} } }. */
export async function readMcpConfig(cwd: string): Promise<Record<string, McpServerConfig>> {
  try {
    const raw = await fs.readFile(path.join(cwd, '.astrocode', 'mcp.json'), 'utf8');
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> };
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}

export async function writeMcpConfig(
  cwd: string,
  servers: Record<string, McpServerConfig>,
): Promise<void> {
  const dir = path.join(cwd, '.astrocode');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2), 'utf8');
}

// ── connection ──────────────────────────────────────────────────────────────

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>; // JSON Schema
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

export class McpConnection {
  readonly serverName: string;
  private child: ReturnType<typeof spawn>;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = '';
  private tools: McpToolDef[] = [];
  private alive = false;

  private constructor(serverName: string, child: ReturnType<typeof spawn>) {
    this.serverName = serverName;
    this.child = child;
  }

  /** Spawn + initialize + list tools. Throws with a readable message on failure. */
  static async connect(
    serverName: string,
    cfg: McpServerConfig,
    options?: { timeoutMs?: number },
  ): Promise<McpConnection> {
    const timeoutMs = options?.timeoutMs ?? 10_000;
    const child = spawn(cfg.command, cfg.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(cfg.env ?? {}) },
    });
    const conn = new McpConnection(serverName, child);

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      conn.buffer += chunk;
      // Messages are newline-delimited JSON (the common stdio transport).
      let idx: number;
      while ((idx = conn.buffer.indexOf('\n')) >= 0) {
        const line = conn.buffer.slice(0, idx).trim();
        conn.buffer = conn.buffer.slice(idx + 1);
        if (!line) continue;
        conn.handleLine(line);
      }
    });
    child.stderr!.on('data', () => {
      /* server logs — deliberately swallowed (bounded by the pipe) */
    });
    child.on('exit', (code) => {
      conn.alive = false;
      for (const [, p] of conn.pending) p.reject(new Error(`MCP server "${serverName}" exited (code ${code})`));
      conn.pending.clear();
    });
    child.on('error', (e) => {
      conn.alive = false;
      for (const [, p] of conn.pending) p.reject(e);
      conn.pending.clear();
    });

    const deadline = Date.now() + timeoutMs;
    await conn.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'astrocode', version: '1.3.0' },
    }, Math.max(1_000, deadline - Date.now()));
    // Notifications don't get responses; send initialized per the MCP lifecycle.
    conn.notify('notifications/initialized');

    const listed = await conn.rpc('tools/list', {}, Math.max(1_000, deadline - Date.now()));
    conn.tools = Array.isArray(listed?.tools) ? listed.tools : [];
    conn.alive = true;
    return conn;
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // non-JSON line from server — ignore
    }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(msg.error.message ?? `MCP error ${msg.error.code}`));
      } else {
        p.resolve(msg.result);
      }
    }
    // Notifications (no id) are ignored for now.
  }

  private async rpc(method: string, params: unknown, timeoutMs = 10_000): Promise<any> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP "${this.serverName}": ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin!.write(payload, (err?) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`MCP "${this.serverName}": failed to write: ${err.message}`));
        }
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n', () => {});
  }

  /** Remote tools, namespaced as mcp_<server>_<tool>. */
  namespacedTools(): Array<McpToolDef & { namespaced: string }> {
    return this.tools.map((t) => ({ ...t, namespaced: `mcp_${this.serverName}_${t.name}` }));
  }

  async callTool(toolName: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<{ ok: boolean; text: string }> {
    const res = await this.rpc('tools/call', { name: toolName, arguments: args }, timeoutMs);
    const content = Array.isArray(res?.content) ? res.content : [];
    const text = content
      .map((c: any) => (typeof c === 'string' ? c : c.type === 'text' ? c.text : JSON.stringify(c)))
      .join('\n');
    return { ok: !res?.isError, text: text || '(empty MCP tool result)' };
  }

  get isAlive(): boolean {
    return this.alive;
  }

  async shutdown(): Promise<void> {
    this.alive = false;
    try {
      this.notify('notifications/cancelled', {});
    } catch {
      /* best effort */
    }
    this.child.kill('SIGTERM');
  }
}

// ── session-level registry ──────────────────────────────────────────────────

const connections = new Map<string, McpConnection>();

export async function connectAllMcp(
  cwd: string,
  options?: { timeoutMs?: number },
): Promise<{ connected: string[]; failed: Array<{ name: string; error: string }> }> {
  const cfg = await readMcpConfig(cwd);
  const connected: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const [name, serverCfg] of Object.entries(cfg)) {
    if (serverCfg.enabled === false) continue;
    if (connections.has(name)) {
      connected.push(name);
      continue;
    }
    try {
      connections.set(name, await McpConnection.connect(name, serverCfg, options));
      connected.push(name);
    } catch (e: any) {
      failed.push({ name, error: String(e?.message ?? e) });
    }
  }
  return { connected, failed };
}

export function getMcpConnection(serverName: string): McpConnection | undefined {
  return connections.get(serverName);
}

export function mcpServerNames(): string[] {
  return [...connections.keys()];
}

export function disconnectAllMcp(): void {
  for (const [, c] of connections) c.shutdown();
  connections.clear();
}

/**
 * Convert an MCP JSON Schema tool into AstroCode's tool schema format.
 * Non-object / missing schemas degrade to a free-form `input` string param so
 * the model can still call the tool.
 */
export function mcpToolToSchema(t: McpToolDef & { namespaced: string }): ToolSchema {
  const input = (t.inputSchema ?? {}) as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const usable = input.type === 'object' && input.properties && typeof input.properties === 'object';
  return {
    type: 'function',
    function: {
      name: t.namespaced,
      description:
        `[MCP:${t.namespaced.split('_')[1]}] ` + (t.description ?? 'External MCP tool.'),
      parameters: usable
        ? ({
            type: 'object',
            properties: input.properties!,
            ...(input.required ? { required: input.required } : {}),
          } as ToolSchema['function']['parameters'])
        : {
            type: 'object',
            properties: {
              input: { type: 'string', description: 'Free-form arguments for this tool (schema unavailable).' },
            },
          },
    },
  };
}

/** All tools across live MCP connections, converted for the agent loop. */
export function allMcpToolSchemas(): ToolSchema[] {
  const out: ToolSchema[] = [];
  for (const [name, conn] of connections) {
    if (!conn.isAlive) continue;
    for (const t of conn.namespacedTools()) out.push(mcpToolToSchema(t));
  }
  return out;
}

/** Execute a namespaced MCP tool call (mcp_<server>_<tool>). */
export async function executeMcpTool(namespaced: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const prefix = `mcp_`;
  if (!namespaced.startsWith(prefix)) return { ok: false, text: `Not an MCP tool: ${namespaced}` };
  const rest = namespaced.slice(prefix.length);
  for (const [serverName, conn] of connections) {
    if (!conn.isAlive) continue;
    if (rest === serverName || rest.startsWith(serverName + '_')) {
      const toolName = rest === serverName ? '' : rest.slice(serverName.length + 1);
      const def = conn.namespacedTools().find((t) => t.name === toolName);
      if (!def) {
        return { ok: false, text: `Unknown MCP tool "${toolName}" on server "${serverName}".` };
      }
      try {
        return await conn.callTool(toolName, args);
      } catch (e: any) {
        return { ok: false, text: `MCP call failed: ${e?.message ?? e}` };
      }
    }
  }
  return { ok: false, text: `No live MCP connection matches "${namespaced}".` };
}
