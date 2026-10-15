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
- **Popups are always cancellable**: every interactive popup (/login, /models,
  /settings, /theme) must handle Esc FIRST — before any early return for an
  empty list, a loading state, or anything else. /models once checked Esc after
  bailing out on an empty model list, so an 'OpenAI Compatible' provider (its
  models are fetched live during /login, never stored in the registry) trapped
  the user in a popup that swallowed every keystroke. Key routing that carries
  this kind of rule belongs in a pure helper (`src/tui/modelPicker.ts`) so a
  test can pin it without a terminal. A popup that renders a row the layout
  did not reserve (the empty-list notice) must reserve it in `computeLayout`
  — under-reserving puts the frame on Ink's direct-write path and freezes it.
- **/login remembers a configured custom endpoint**: the saved
  'openai-compatible' config (`baseUrl`/`model` in the auth file) turns the
  provider row into a two-choice prompt — "Use existing configuration" or
  "Configure again" — instead of restarting the wizard. The branch and the
  row set are pure helpers in `src/tui/loginFlow.ts` (`providerEntryStage`,
  `existingCustomConfig`); reuse never rewrites the config file.

## Feature map (v1.3+)
- **Swarm Mode** (`src/swarm.ts`, tool `swarm`, command `/swarm`): parallel
  worktree-isolated workers; workers execute tools with `cwd` redirected to
  `worktreeCwdFor(cwd, worker)`; merges via `worktree.mergeWorktree`.
- **Open Tool Bus**: MCP client (`src/mcp.ts`, tools named `mcp_<server>_<tool>`),
  MCP server (`src/serve.ts`, launched by `astrocode serve`), skills
  (`src/skills.ts`, `use_skill` tool, `.astrocode/skills/<name>/SKILL.md`).
  External tools merge into `getToolSchemas()`/`getToolNames()` and dispatch
  inside `executeTool` BEFORE the builtin registry.
- **Terminal rendering** (`src/tui/markdown.ts` + `src/tui/syntax.ts`): the
  assistant renderer. `richLines(text, width)` returns `UILine[]` — styled
  segments plus the plain `copy` text a selection pastes. Fenced code blocks
  get a framed language label, a `│ ` gutter (`↪ ` for wrapped rows, copies
  exclude both) and per-token colors from the dependency-free highlighter
  (`detectLanguage` + `highlightCode`, memoized by language+source). Themes
  carry `syn*`/`synAdd`/`synDel`/`codeBorder` roles and `themeRevision` bumps
  on `setTheme()` to invalidate both caches. Keep these modules pure.
- **Markdown invariants**: inline spans are parsed FIRST, then wrapped
  (`wrapSegments`), so emphasis/code survive line breaks; all layout math uses
  `displayWidth`/`sliceToWidth` (cells, not code units) so CJK/emoji wrap
  correctly and hard-cuts never lose characters. Both ATX and setext headings,
  list continuations, and diff fences (language `diff`/`patch` → add/del
  tokens) are supported.
- **Shell approval** (`src/approval.ts`): `run_command` consults an
  `ApprovalGate` from `ToolContext.approvalGate` when present. Modes
  off/dangerous/all; `y/a/n` TUI prompt (`src/tui/ApprovalPrompt.tsx`); the
  "always" decision remembers a command PREFIX for the session. `ASTROCODE_APPROVE`
  pre-approves prefixes. The canonical `isDangerousCommand` also
  lives in approval.ts (registry re-exports it).
- **Real token usage** (`src/ai/openai.ts` `extractUsage` + `cost.ts`
  `costFromUsage`): chat completions send `stream_options.include_usage`,
  the Responses path reads `response.completed.usage`; cached tokens are
  billed at the model's cache rate. Falls back to chars÷4 when a server
  reports nothing. `Provider.streamComplete` may return `usage`.

## Slash-menu invariants (v1.3+ UX fixes)
- Filtering/ranking and Enter resolution are pure helpers in
  `src/commands/slash.ts`: `filterSlashCommands` (exact > prefix > substring,
  whitespace closes the menu) and `resolveSlashSubmission` (a fully typed
  command always wins over the highlighted one — `/model` must never morph
  into `/models`).
- The menu windows over the FULL match list (SlashMenu `maxRows`), so `/` +
  ↑/↓ can reach every command; `slashSel` resets whenever the query changes.
- Enter RUNS the command, Tab completes it into the line with the caret at the
  end (so arguments land after the command, not mid-word), Esc dismisses the
  menu without clearing the line (a second Esc clears).
- While the agent is busy the menu still shows; only
  `SLASH_SAFE_WHILE_BUSY` informational commands run mid-turn and everything
  else is refused with a message — shell/slash input must never be queued as
  a model message.

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
- **Rendering is centralized** in `src/tui/markdown.ts` (pure + tested in
  `tests/markdown.test.ts`; highlighter in `tests/syntax.test.ts`). Add new
  block types there rather than inline in a component, and give every
  non-chrome `UILine` a `copy` string so `/copy` and Ctrl+K selection stay
  clean (code copies without its gutter; frames/rules set `copy: ''`).
- **New syntax languages land in the highlighter, not the renderer**: add a
  `LangSpec` (keywords/builtins/sigils/comments/quotes) or a small scanner in
  `src/tui/syntax.ts`, an alias in `ALIASES`, and a unit test; the markdown
  side needs no changes.
