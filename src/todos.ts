/**
 * In-session todo/task tracking for AstroCode.
 *
 * The agent maintains a live checklist via the `todo` tool so multi-step work
 * is visible and structured — inspired by Claude Code's TodoWrite, rendered in
 * a dedicated TUI panel and summarised in the status bar. Todos are in-memory
 * for the process lifetime and reset on /clear or /new.
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface Todo {
  id: string;
  text: string;
  status: TodoStatus;
  createdAt: number;
}

let todos: Todo[] = [];
let nextId = 1;

export function listTodos(): Todo[] {
  return todos.slice();
}

export function addTodo(text: string): Todo {
  const t: Todo = {
    id: `t${nextId++}`,
    text: text.trim() || '(empty task)',
    status: 'pending',
    createdAt: Date.now(),
  };
  todos.push(t);
  return t;
}

export function updateTodoStatus(id: string, status: TodoStatus): boolean {
  const t = todos.find((x) => x.id === id);
  if (!t) return false;
  t.status = status;
  return true;
}

export function updateTodoText(id: string, text: string): boolean {
  const t = todos.find((x) => x.id === id);
  if (!t) return false;
  t.text = text.trim() || t.text;
  return true;
}

export function deleteTodo(id: string): boolean {
  const before = todos.length;
  todos = todos.filter((x) => x.id !== id);
  return todos.length < before;
}

export function clearTodos(): void {
  todos = [];
  nextId = 1;
}

export function todoCounts(): { total: number; done: number; inProgress: number; pending: number } {
  let done = 0;
  let inProgress = 0;
  let pending = 0;
  for (const t of todos) {
    if (t.status === 'completed') done++;
    else if (t.status === 'in_progress') inProgress++;
    else pending++;
  }
  return { total: todos.length, done, inProgress, pending };
}

/** A compact, copy-pasteable block of the current task list. */
export function todoBlock(): string {
  if (todos.length === 0) return '(no tasks)';
  return todos
    .map((t) => {
      const mark = t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '>' : ' ';
      return `[${mark}] ${t.id}: ${t.text}`;
    })
    .join('\n');
}
