/**
 * Session-scoped sub-agent spawn history for AstroCode.
 *
 * Every `spawn_agent` call records a lightweight entry here so the user can
 * inspect what child agents ran this session via the `/agents` slash
 * command. The store is in-memory (per session) and cleared with /clear,
 * matching the todo list.
 */
export interface AgentHistoryEntry {
  /** Monotonic id. */
  id: number;
  /** Epoch ms of the spawn. */
  ts: number;
  /** Sub-agent role (researcher, file-picker, …). */
  role: string;
  /** The task, truncated for display. */
  task: string;
  /** Loop iterations used. */
  turns: number;
  /** Tool calls executed. */
  actions: number;
  /** Whether the sub-agent reported success. */
  ok: boolean;
}

const MAX_STORED = 50;
const history: AgentHistoryEntry[] = [];
let nextId = 1;

export function recordAgentSpawn(
  entry: Omit<AgentHistoryEntry, 'id' | 'ts'>,
): void {
  history.push({ ...entry, id: nextId++, ts: Date.now() });
  if (history.length > MAX_STORED) {
    history.splice(0, history.length - MAX_STORED);
  }
}

/** Newest-first history, capped at `limit` (limit ≤ 0 returns []). */
export function getAgentHistory(limit = 10): AgentHistoryEntry[] {
  if (limit <= 0) return [];
  return history.slice(-limit).reverse();
}

export function clearAgentHistory(): void {
  history.length = 0;
}
