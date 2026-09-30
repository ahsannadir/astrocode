# AstroCode — project memory

This file is auto-loaded into the agent's system prompt. Put project
conventions, build commands, and anything the agent should always know here.

## Stack
- Language: TypeScript (strict), ESM, Node ≥ 18
- TUI: React 18 + Ink 5 (terminal UI)
- No runtime deps beyond `ink`/`react`; stay dependency-light.

## Commands
- `npm run typecheck` — `tsc --noEmit` (must pass with zero errors)
- `npm run build` — compile `src/` → `dist/`
- `npm run dev` — run from source via `tsx`
- `npm test` — `node:test` runner via `tsx --test tests/*.test.ts`

## Conventions
- Local imports use the `.js` extension (NodeNext resolution), e.g.
  `import { x } from './foo.js'` even for `.ts` source.
- Prefer `import type` for type-only imports.
- New tools go in `src/tools/registry.ts` as a `{ schema, handler }` entry;
  add read-only/planning tools to `READ_ONLY_TOOLS` / `PLAN_ALLOWED_TOOLS`.
- New slash commands go in `src/commands/slash.ts` (SLASH_COMMANDS + switch).
- The TUI is rendered with Ink; keep layout math (heights) within the terminal.
- Keep modules small and dependency-free; match the existing code style.

## Feature map (v1.3+)
- **Swarm Mode** (`src/swarm.ts`, tool `swarm`, command `/swarm`): parallel
  worktree-isolated workers; workers execute tools with `cwd` redirected to
  `worktreeCwdFor(cwd, worker)`; merges via `worktree.mergeWorktree`.
- **Open Tool Bus**: MCP client (`src/mcp.ts`, tools named `mcp_<server>_<tool>`),
  MCP server (`src/serve.ts`, launched by `astrocode serve`), skills
  (`src/skills.ts`, `use_skill` tool, `.astrocode/skills/<name>/SKILL.md`).
  External tools merge into `getToolSchemas()`/`getToolNames()` and dispatch
  inside `executeTool` BEFORE the builtin registry.

## Harness invariants (do not regress)
- **Tool results are bounded centrally** in `executeTool` via
  `truncateToolText` (`src/tooloutput.ts`) — never add a tool that returns
  unbounded output and bypasses it.
- **Every looping context gets a `LoopSensor`** (`src/loopsensor.ts`): the
  main loop creates one per turn (App.tsx), each sub-agent run gets its own
  (registry spawnOne). Identical repeat calls are nudged then blocked.
- **Tool args are repaired + coerced** in `executeTool`
  (`src/toolargs.ts`) before handlers run — handlers may assume typed args.
- **Compaction never breaks tool pairing**: use `compactConversation`
  (`src/compact.ts`); tool results stay adjacent to their tool_calls batch.
- **External tools (MCP/skills) are gated in plan mode** inside `executeTool` —
  their side effects are unknown, so they're blocked unless mode is `act`.
- **Swarm workers are sandboxed by path redirection, not trust**: never let a
  swarm worker execute a tool with the MAIN cwd; always pass the worktree cwd.
- **The MCP server hides mutating tools by default** (`ASTROCODE_SERVE_WRITES=1`
  opts in) and NEVER exposes `spawn_agent`/`worktree`/`todo`.
- New harness behavior needs offline unit tests (fake providers, tmp dirs —
  no network); swarm/toolbus tests live in `tests/swarm.test.ts` and
  `tests/toolbus.test.ts`.
