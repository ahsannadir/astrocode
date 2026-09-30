# ✦ AstroCode

```
 ███   █████  ██████ ████    ████   ████   ████  ████   █████
██ ██  ██       ██   ██  ██ ██  ██ ██     ██  ██ ██  ██ ██
█████  █████    ██   ████   ██  ██ ██     ██  ██ ██  ██ ████
██ ██     ██    ██   ██ ██  ██  ██ ██     ██  ██ ██  ██ ██
██ ██  █████    ██   ██  ██  ████   ████   ████  ████   █████
```

<p align="center">
  <i>✦ ASTROCODE ✦ · ✦ AI TERMINAL CODING AGENT ✦</i>
</p>

**AstroCode** is a fully-fledged **AI terminal coding agent** — think Claude Code / OpenCode / Kilo — with a visually brilliant, live-updating TUI, built in **TypeScript** on [Ink](https://github.com/vadimdemedes/ink) + React.

It runs a real **agentic loop** in your terminal: it streams replies live, calls tools (read/write/edit files, search, shell), interprets the results, and loops until the job is done — right next to the code you're working on.

- ✅ **Real tools, real loop** — not a chat wrapper. 15 built-in tools, bounded turns, sub-agent delegation.
- ✅ **Swarm Mode** — one goal in, a fleet of parallel worktree-isolated agents out, merged back automatically.
- ✅ **Open Tool Bus** — MCP client **and** server, plus progressive-disclosure skills.
- ✅ **OpenAI-compatible** — OpenAI, Anthropic, OpenRouter, local servers (Ollama/LM Studio/vLLM), and more.
- ✅ **Works offline** — a built-in demo provider exercises the full pipeline with **zero API keys**.
- ✅ **Safety-first** — per-edit `/undo`, per-turn `/rewind`, destructive-command guard, spend budget.

---

## Table of contents

- [Quick start](#-quick-start)
- [Connecting a model](#-connecting-a-model)
- [Usage](#%EF%B8%8F-usage)
- [Slash commands](#-slash-commands)
- [Keyboard shortcuts](#%EF%B8%8F-keyboard-shortcuts)
- [Features](#-features)
  - [The agent loop](#the-agent-loop)
  - [Plan / Act modes](#plan--act-modes)
  - [Sessions & memory](#sessions--memory)
  - [Repo map & context management](#repo-map--context-management)
  - [Safety nets](#safety-nets)
  - [Verification & auto-commit](#verification--auto-commit)
  - [Sub-agents](#sub-agents)
  - [Git worktree sandbox](#git-worktree-sandbox)
  - [Harness engineering](#%F0%9F%A7%AC-harness-engineering)
  - [The TUI](#-the-tui)
- [Tools reference](#%F0%9F%94%A7-tools-reference)
- [Configuration](#%F0%9F%94%8C-configuration)
- [Architecture](#%F0%9F%A7%AC-architecture)
- [Development](#-development)
- [FAQ](#-faq)
- [License](#-license)

---

## 🚀 Quick start

```bash
npm install
npm run build

# Demo mode (no API key needed) — launch the TUI
node dist/index.js --demo
```

### Install globally (`astrocode` from anywhere)

AstroCode ships one command — **`astrocode`** — so you can launch it from any directory:

```bash
npm run link        # builds + links the command globally
# or, from any other project:
npm install -g /path/to/AstroCode
```

Then, in any folder:

```bash
astrocode                       # opens the TUI in the current directory
astrocode --cwd ~/some/project  # open a specific project
astrocode -m gpt-4o             # override the model
astrocode serve                 # run as an MCP server (Open Tool Bus)
astrocode --version
```

> If an older `astro` symlink from a previous install still shadows `astrocode`, remove it (`npm uninstall -g astrocode && hash -r`) or make sure `$(npm prefix -g)/bin` comes first in `PATH`. Sessions opened before the install may need `hash -r` to pick up the new command.

---

## 🔑 Connecting a model

### The easy way: `/login`

Launch the TUI, type `/login`, and pick a provider:

| Provider | Notes |
| --- | --- |
| **OpenAI** | GPT models, `sk-…` key |
| **Anthropic** | Claude models via its OpenAI-compatibility layer |
| **InferX · AgentRouter · ZenMux · TokenRouter** | Managed routers |
| **OpenRouter** | Hundreds of models behind one key |
| **OpenAI Compatible** | *Any* `/chat/completions` endpoint |

Paste your API key, then pick a model with `/models`. Credentials persist to
`~/.astrocode/config.json` and reconnect automatically on the next launch.

Pick **OpenAI Compatible** to connect *anything* that speaks
`POST /chat/completions` — vLLM, Ollama bridges, LM Studio, LocalAI, a
self-hosted gateway. AstroCode fetches the model list from `GET <baseUrl>/models`,
and keyless local endpoints run fully live (no demo mode needed).

### Or use environment variables

```bash
export ASTROCODE_API_KEY=sk-...
export ASTROCODE_MODEL=gpt-4o-mini          # optional
export ASTROCODE_BASE_URL=https://api.openai.com/v1   # optional
node dist/index.js
```

> `ASTROCODE_API_KEY` falls back to `OPENAI_API_KEY`; `ASTROCODE_BASE_URL` falls back to `OPENAI_BASE_URL`.

### Offline demo mode

No key? `--demo` (or just launching with no key configured) runs a scripted
local provider that streams text and exercises the full tool loop — file edits,
commands, todos, sub-agents — so you can audition the entire experience before
connecting a model.

---

## ⌨️ Usage

Type a normal message to talk to the agent. Start typing `/` to use a slash
command — a floating overlay menu filters commands as you type (navigate with
`↑`/`↓`, accept with `Tab`/`Enter`).

```text
You: add rate limiting to the login endpoint

❯ astrocode · planning… reading src/routes/auth.ts · editing · verifying
```

The agent reads files, proposes edits, runs your checks, and reports back —
streaming every step into the transcript with live status in the bar below.

---

## 📝 Slash commands

| Command | Description |
| --- | --- |
| `/help` | Show the help card |
| `/copy [all]` | Copy the last reply (or whole conversation) to the clipboard |
| `/login` | Connect a provider (interactive popup) |
| `/models` | Pick a model from the connected provider |
| `/settings` | Open the settings menu |
| `/theme` | Pick a color theme (12 palettes, live swatches) |
| `/model <n>` | Switch model (e.g. `/model gpt-4o`) |
| `/plan` `/act` | Plan mode (read-only) · Act mode (full access) |
| `/mode` | Show the current mode |
| `/clear` | Clear the conversation |
| `/save [n]` | Save this conversation to disk |
| `/load <n>` | Resume a saved conversation |
| `/sessions` | List saved sessions |
| `/new [n]` | Start a fresh conversation |
| `/delete <n>` | Delete a saved session |
| `/undo` | Revert the last file change |
| `/rewind` | Revert every change from the last turn |
| `/review` | Show a git diff of your working-tree changes |
| `/verify` | Run detected lint/typecheck/test on your changes |
| `/commit` | Auto-commit current changes |
| `/cost` | Show token & spend breakdown for this session |
| `/tools` | List available agent tools |
| `/agents` | List sub-agent roles & recent spawns |
| `/swarm <goal>` | Launch a parallel swarm (worktree-isolated agents) — `--no-plan` for one worker; `/swarm status`, `/swarm cleanup` |
| `/mcp` | Show connected MCP servers & their tools; `/mcp connect` to (re)connect |
| `/skills` | List skill packages; `/skills add <name>` scaffolds one; `/skills reload` |
| `/recall <q>` | BM25-style search over your saved sessions |
| `/compact` | Compact the context |
| `/context` | Show context-window usage |
| `/memory` | Show project memory (`ASTROCODE.md`); `/memory reload` re-reads |
| `/map` | Build & show the repo map |
| `/todo` | Show the live task list |
| `/status` | Show environment / connection info |
| `/stars` | Deploy stardust ✨ |
| `/whoami` | Introspect the agent |
| `/exit` | Quit AstroCode (also `Ctrl+C`; `/quit` works too) |

---

## ⌨️ Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `↑` / `↓` | Recall prompt history |
| `Tab` | Autocomplete slash commands |
| `PgUp` / `PgDn` | Scroll the transcript |
| `Ctrl+U` | Clear the input line |
| `Ctrl+K` | Selection mode — `↑`/`↓` move, `Enter` copies, `Esc` cancels |
| `Ctrl+Shift+C` / `Cmd+C` | Native terminal selection & copy |
| `Ctrl+C` | Quit |

---

## ✨ Features

### The agent loop

AstroCode doesn't chat — it **works**. Every request runs a bounded loop
(`ASTROCODE_MAX_TURNS`): the model streams a reply, may invoke tools, gets the
results fed back, and continues until it produces a final answer. Streaming is
character-by-character with markdown-lite styling (headings, bullets,
blockquotes, code blocks).

### Plan / Act modes

- `/plan` — the agent analyzes and proposes a plan using **read-only tools
  only**. Writes, edits, and commands are blocked *at the tool layer*, and the
  system prompt changes to match. Brainstorming can never accidentally edit
  your repo.
- `/act` — full access to implement.

The active mode is shown live in the status bar.

### Sessions & memory

- **Sessions** — `/save`, `/load`, `/sessions`, `/new`, `/delete` persist and
  resume whole conversations (including model & mode) from
  `~/.astrocode/sessions`. Close your laptop, come back tomorrow, continue
  mid-thought.
- **`/recall <query>`** — dependency-free BM25-style search over your saved
  sessions: *"how did we solve X last month?"* answered from your own past work.
- **Project memory** — drop an `ASTROCODE.md` (or `AGENTS.md`) in your repo
  and/or `~/.astrocode/ASTROCODE.md` for global rules; both are loaded into the
  system prompt automatically. `/memory` shows what's loaded; `/memory reload`
  re-reads. Like `CLAUDE.md` — the agent always knows your conventions & build
  commands.

### Repo map & context management

- **Repo map** — a compact, token-bounded map of your workspace (filtered
  directory tree, file/dir counts, key-file summaries like `package.json`
  scripts and the README blurb) is built on startup and injected into context —
  Aider's killer feature, dependency-free. The agent can call `repomap` to
  refresh it; `/map` prints it.
- **Context-window meter** — a live, color-coded readout in the status bar
  shows how full the model's context window is (green → yellow → red);
  `/context` draws a usage bar and warns before truncation.
- **`/compact` + auto-compact** — real deterministic compaction: old tool
  batches collapse to one-line summaries (tool names kept), the newest 12
  messages survive verbatim, tool-call/result pairing is never broken, and user
  task statements always survive. Triggers on demand or **automatically at
  ~85%** of the context window, so long sessions degrade gracefully instead of
  dying on a provider length error.
- **Tool-result truncation** — every tool result is piped through a central
  head+tail truncator (~16k chars) with an explicit elision notice telling the
  agent how to re-query more narrowly. One `read_file` on a minified bundle can
  no longer evict your conversation.

### Safety nets

- **Edit undo** — every `write_file` / `edit_file` snapshots the original;
  `/undo` reverts the most recent change.
- **Checkpoint & rewind** — before every turn AstroCode marks a checkpoint;
  `/rewind` reverts *all* file changes from the last turn at once, restoring
  the whole working tree to its pre-turn state.
- **Destructive-command guard** — `run_command` refuses obviously destructive
  commands (`rm -rf /`, `dd`, `mkfs`, force-push, `reset --hard`, …) unless
  explicitly forced with `"force": true`.
- **Spend budget** — live cost in the status bar (`/cost` for the breakdown),
  plus an optional hard ceiling (`ASTROCODE_BUDGET`) that pauses the loop
  automatically. No surprise bills from runaway loops.

### Verification & auto-commit

Set `ASTROCODE_VERIFY=1` and AstroCode runs your project's typecheck / lint /
tests after the agent edits files — auto-detected from `package.json`,
`Makefile`, `Cargo.toml`, or `go.mod`. Set `ASTROCODE_AUTOCOMMIT=1` to also
auto-commit. Trigger either on demand with `/verify` and `/commit`.

**Self-healing verification** — when verification fails, the lint/test errors
are fed back to the agent to fix (bounded to 2 retry rounds) before the turn
ends. The agent fixes its own failures.

### Swarm Mode 👥

`/swarm <goal>` (or the `swarm` tool) turns one goal into a **parallel fleet**:

1. **Planner** — a cheap tool-less call decomposes the goal into ≤5 *independent* subtasks (different files, no overlap).
2. **Isolation** — every worker gets an **ephemeral git worktree** (own branch, own checkout in the system temp dir). The main working tree is never touched.
3. **Parallel work** — one full agent loop per worker (up to 24 turns each), all running concurrently, live-streamed into a swarm activity card in the TUI.
4. **Arbitration** — finished builder branches are committed and **merged back** automatically; researchers report instead of merging; failed/empty workers are skipped with their branches kept for manual retry.
5. **Cleanup** — `/swarm status` shows the last fleet; `/swarm cleanup` discards all swarm worktrees/branches.

```text
❯ /swarm add rate limiting, docs for it, and tests — independently
✦ Swarm: decomposing…
  ▶ #1 rate-limit  [builder]  (write_file, run_command)
  ▶ #2 docs        [researcher]
  ▶ #3 tests       [builder]
✓ 2/3 merged · 1 research report
```

This is the "git worktrees + 10 agents" workflow other tools leave you to duct-tape with tmux — built in, model-agnostic, free.

### Open Tool Bus 🔌

AstroCode speaks **MCP (Model Context Protocol) in both directions** plus a skills system:

- **MCP client** — list servers in `.astrocode/mcp.json` under `"mcpServers"` (same shape as Claude Code's config); `/mcp connect` or auto-connect at launch. External tools appear to the agent as `mcp_<server>_<tool>` and run through the same harness as built-ins (bounded output, loop sensing, plan-mode gating).
- **MCP server** — `astrocode serve` exposes AstroCode's own tools over JSON-RPC 2.0 stdio, so **any other agent** (Claude Code, an editor, CI) can delegate real work to your local AstroCode. Read-only by default; `ASTROCODE_SERVE_WRITES=1` enables mutating tools. `spawn_agent`/`worktree`/`todo` are never exposed.
- **Skills** — progressive-disclosure packages in `.astrocode/skills/<name>/SKILL.md` (frontmatter: `name`, `description`). Only one line per skill loads at startup; the full body enters context on first use via the `use_skill` tool. `/skills add <name>` scaffolds one. Project skills beat user-level (`~/.astrocode/skills/`) on name conflicts.

### Sub-agents

The main agent can delegate exploration via `spawn_agent`:

| Role | Purpose |
| --- | --- |
| `researcher` | General exploration |
| `file-picker` | Find the relevant files |
| `code-searcher` | Search-heavy investigation |
| `reviewer` | Review code (may run commands) |

Each sub-agent runs its own mini tool loop with restricted, read-only tools,
hard turn/time/report budgets, and reports one concise answer back. A
`workers` array dispatches up to **5 sub-agents concurrently**
(allSettled-style) and merges their reports — parallel investigation without
giving children write access. Sub-agents can never edit files, touch the
sandbox, or spawn further sub-agents. `/agents` lists roles and recent spawns.

### Git worktree sandbox

The `worktree` tool creates an ephemeral branch + checkout (stored in the
system temp dir, tracked in `.astrocode/worktrees.json`) for **zero-risk
experiments**: run and test there, then `merge` back or `discard`. Enables
parallel tasks with no file-lock conflicts.

### 🧬 Harness engineering

AstroCode's loop follows the 2026 harness-engineering playbook — **mechanisms,
not instructions**. Reliability is enforced mechanically, so prompt discipline
is a bonus, not a requirement.

- **Bounded tool output** — central head+tail truncation before anything enters
  the context window (see above).
- **Loop sensor (backpressure)** — repeated *identical* tool calls (same tool,
  same canonicalized args) are sensed across a turn: the **3rd** gets a nudge
  appended to its result, the **6th** is blocked outright and the cached first
  result is replayed with a "change your approach" instruction. No more
  burning 20 turns re-running the same failing grep. Sub-agents each get their
  own sensor.
- **Tool-argument repair** — malformed model output is repaired instead of
  failing a whole provider turn: markdown fences, prose prefixes, trailing
  commas, single quotes, raw newlines in strings, and type drift
  (`"5"` → `5`, `"true"` → `true`, `{…}` → `[…]` per the tool's schema).
  Smaller/local models become dramatically more usable.
- **Salvaged sub-agent reports** — when a sub-agent burns its turn budget on
  tool calls without answering, the harness makes one final tool-less call:
  *"write your report NOW from everything you gathered."* Budget exhaustion
  produces a usable report instead of `(no final report)`.
- **Turn orientation** — on the first `run_command` of a turn, the agent is
  reminded to baseline the project's checks (typecheck/lint/test) before
  editing — the "get up to speed" pattern from long-running-agent research.

### 🖥️ The TUI

A terminal you actually want to look at:

- **Twinkling ASCII `ASTROCODE` banner** and rounded, bordered conversation pane.
- **Live streaming** with markdown-lite rendering.
- **Live status bar** — mode · model · context % · task count · spend · branch · cwd.
- **Live task panel** — the agent maintains a visible checklist via the `todo`
  tool, rendered above the prompt — multi-step work is never a black box.
- **Slash-command overlay** — type `/` and a floating menu filters commands
  with descriptions as you type.
- **Interactive popups** — `/login`, `/models`, `/settings`, `/theme` are real
  opencode-style modals with keyboard navigation.
- **12 color themes** — `astro`, `aurora`, `cyberpunk`, `dracula`, `forest`,
  `inferno`, `matrix`, `nebula`, `noir`, `ocean`, `sunset`, `synthwave` — with
  live swatches in `/theme`. Persists to `~/.astrocode/config.json`
  (`ASTROCODE_THEME` env wins).
- **Select & copy** — your terminal's **native mouse selection works right in
  the TUI** (drag + `Ctrl+Shift+C`/`Cmd+C`). For *clean* copies (no `❯`/`✔ ok`
  prefixes or tool banners, including text scrolled off-screen) press
  `Ctrl+K`: `↑`/`↓` move, `Enter` copies via OSC 52 (with
  `wl-copy`/`xclip`/`pbcopy` fallbacks), `Esc` cancels. `/copy` grabs the last
  reply (or `/copy all`).
- **Prompt editing** — cursor navigation, insert/delete, Home/End, history
  recall (`↑`/`↓`), `Ctrl+U` to clear, bracketed-paste sanitization.
- **Graceful non-TTY** — piped or CI? It prints the banner and context and
  exits cleanly instead of crashing.

---

## 🔧 Tools reference

15 built-in tools. Read-only tools are always available; mutating tools are
blocked in plan mode.

| Tool | Read-only | Description |
| --- | --- | --- |
| `read_file` | ✅ | Read a file (bounded output) |
| `list_dir` | ✅ | List a directory |
| `search_files` | ✅ | Grep-style content search |
| `git_status` | ✅ | Working-tree status |
| `git_diff` | ✅ | Unified diff (`staged`/`stat` options) |
| `repomap` | ✅ | Refresh the workspace map |
| `fetch_url` | ✅ | Fetch a URL, HTML stripped to readable text |
| `write_file` | — | Create/overwrite a file (snapshotted for `/undo`) |
| `edit_file` | — | Search/replace edit (snapshotted) |
| `multi_edit` | — | Many search/replace edits to one file in one call |
| `apply_patch` | — | Multi-hunk patch with **fuzzy matching** — hunks match by line similarity, tolerating whitespace and drift; all hunks apply transactionally (nothing is written unless every hunk matches) |
| `run_command` | — | Sandboxed, guarded shell runner |
| `todo` | — | Maintain the live task checklist |
| `worktree` | — | Ephemeral git-worktree sandbox (create / merge / discard) |
| `swarm` | — | Parallel fleet: decompose a goal, run worktree-isolated agents, merge winners |
| `spawn_agent` | ✅ | Delegate to bounded read-only sub-agents |

---

## 🔌 Configuration

### CLI flags

```text
astrocode [options]

  -d, --demo         Force offline demo mode (no API key needed)
  -m, --model <n>    Set the model (e.g. gpt-4o-mini)
      --cwd <path>   Working directory (default: current)
      --serve        Run as an MCP server over stdio (Open Tool Bus)
  -h, --help         Show help
  -v, --version      Show version
```

### Environment variables

| Env var | Purpose | Default |
| --- | --- | --- |
| `ASTROCODE_API_KEY` | API key (also reads `OPENAI_API_KEY`) | – |
| `ASTROCODE_BASE_URL` | OpenAI-compatible base URL (also reads `OPENAI_BASE_URL`) | `https://api.openai.com/v1` |
| `ASTROCODE_MODEL` | Default model | `gpt-4o-mini` |
| `ASTROCODE_MAX_TURNS` | Max tool-call turns per request | `20` |
| `ASTROCODE_BUDGET` | Hard USD spend ceiling for a session (`0` = none) | `0` |
| `ASTROCODE_VERIFY` | Run detected lint/test after edits (`1`/`true`) | off |
| `ASTROCODE_AUTOCOMMIT` | Auto-commit changes after a turn (`1`/`true`) | off |
| `ASTROCODE_THEME` | Color theme (12 palettes — see `/theme`) | `astro` |
| `ASTROCODE_SESSION_DIR` | Directory for `/save` sessions | `~/.astrocode/sessions` |
| `ASTROCODE_CONFIG_DIR` | Directory for config (`config.json`) | `~/.astrocode` |
| `ASTROCODE_AUTH_FILE` | Override the auth file path | `<config dir>/config.json` |

Settings toggled in `/settings` (theme, verify, auto-commit, max turns,
budget, mode) persist to `~/.astrocode/config.json` and apply immediately.

### Project memory file

Create `ASTROCODE.md` (or `AGENTS.md`) in your repo root:

```markdown
# Project conventions

- Use pnpm, never npm.
- All API routes live in src/routes; handlers return Result<T>.
- Run `npm run typecheck` before declaring anything done.
```

It's loaded into the system prompt on every launch — global rules go in
`~/.astrocode/ASTROCODE.md`.

---

## 🧬 Architecture

```
src/
├── index.tsx        CLI entry, arg parsing, render/non-TTY guard
├── config.ts        env/config + system prompt + version (merges saved auth)
├── types.ts         shared types (ChatMessage, ToolCall, PlanMode…)
├── providers.ts     provider registry (OpenAI · Anthropic · InferX · AgentRouter ·
│                    ZenMux · TokenRouter · OpenRouter · OpenAI Compatible + models)
├── auth.ts          /login credentials persisted to ~/.astrocode/config.json
├── cost.ts          token estimation + model pricing + context-window meter
├── sessions.ts      save/load/list/delete conversations
├── recall.ts        BM25-style search over saved sessions (/recall)
├── memory.ts        project & global ASTROCODE.md memory (auto-loaded)
├── repomap.ts       compact workspace map (tree + key files) → context
├── todos.ts         in-session task list store (todo tool + panel)
├── verify.ts        lint/test detection + run + auto-commit guardrails
├── webfetch.ts      URL fetch + HTML→text (fetch_url tool)
├── undo.ts          file snapshots + per-turn checkpoints (/undo, /rewind)
├── clipboard.ts     OSC 52 + wl-copy/xclip/pbcopy fallbacks
├── applypatch.ts    fuzzy multi-hunk patch engine (transactional apply)
├── worktree.ts      ephemeral git-worktree sandbox
├── swarm.ts         Swarm Mode: parallel worktree-isolated agents + merge arbiter
├── mcp.ts           MCP client: JSON-RPC over stdio, tool namespacing (Open Tool Bus)
├── serve.ts         MCP server mode (astrocode serve) — tools over the bus
├── skills.ts        progressive-disclosure skill packages (use_skill tool)
├── subagent.ts      bounded read-only sub-agent runner (roles, budgets, salvage)
├── agents.ts        sub-agent bookkeeping (/agents)
├── tooloutput.ts    central head+tail tool-result truncator
├── loopsensor.ts    repeated-call detection: nudge → block + replay
├── compact.ts       deterministic compaction + auto-compact at 85%
├── toolargs.ts      tool-argument repair (fences, quotes, type drift…)
├── ai/
│   ├── provider.ts  provider factory (auto-select openai/local demo)
│   ├── openai.ts    OpenAI-compatible streaming client (SSE + tool calls)
│   └── local.ts     offline demo provider (streams + exercises the tool loop)
├── tools/
│   ├── registry.ts  15 tool schemas + executors, danger guard, PLAN_ALLOWED_TOOLS
│   └── shell.ts     bounded shell runner
├── commands/
│   └── slash.ts     slash-command parsing & handlers
└── tui/
    ├── App.tsx        layout + agent controller + mode gating + budget/verify guard
    ├── Banner.tsx     animated ASCII wordmark
    ├── ascii.ts       banner glyph data
    ├── MessageArea.tsx  transcript + markdown-lite rendering
    ├── TodoPanel.tsx    live task checklist panel
    ├── PromptInput.tsx  line editor + history + autocomplete
    ├── SlashMenu.tsx    floating slash-command overlay menu
    ├── LoginModal.tsx   /login popup: provider picker + API-key entry
    ├── ModelsModal.tsx  /models popup: model picker
    ├── SettingsMenu.tsx /settings popup: mode/verify/auto-commit/turns/budget
    ├── ThemeModal.tsx   /theme popup: palette picker with swatches
    ├── StatusBar.tsx    mode · model · ctx% · tasks · spend · branch · cwd
    ├── theme.ts         12-palette theme registry
    └── inputEdit.ts     input-line editing primitives + paste sanitization
```

**Requirements:** Node.js ≥ 18.8. **Runtime deps:** `ink`, `react` — that's it.
No native modules, no Python, no database.

---

## 🛠️ Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test suite via tsx (tests/*.test.ts)
npm run build       # tsc → dist/
npm run dev         # run from source with tsx
npm run link        # build + link `astro` / `astrocode` globally
```

The test suite covers the harness pieces — patch application, compaction,
argument repair, truncation, sessions, cost math, and more.

---

## ❓ FAQ

**Does it work without an API key?**
Yes — demo mode runs a scripted local provider that streams text and exercises
the real tool loop. Everything except live model intelligence works.

**Which models work?**
Anything that speaks the OpenAI `/chat/completions` format, including Anthropic
(via its compatibility layer), OpenRouter, and local servers like Ollama
(bridge), LM Studio, and vLLM. Small/local models benefit especially from the
tool-argument repair layer.

**Where does AstroCode store my data?**
Everything lives under `~/.astrocode/` — sessions, auth config, global memory.
Override with `ASTROCODE_CONFIG_DIR` / `ASTROCODE_SESSION_DIR`. The worktree
sandbox lives in your system temp dir.

**Can it run arbitrary shell commands?**
The agent can run commands through a guarded, bounded runner. Obviously
destructive commands are refused unless explicitly forced, and plan mode blocks
command execution entirely.

**Is my code sent anywhere?**
Only to the model provider you configure — there is no AstroCode telemetry or
middleman server.

---

## 🌠 Why AstroCode stands out

Most terminal coding agents are black boxes that dump text and go. AstroCode is
a **self-aware, self-preserving coding companion** that treats every session as
a first-class artifact:

1. **Plan-then-act, enforced** — a real two-mode workflow where plan mode
   blocks mutations at the tool layer, not just in the prompt.
2. **Sessions that survive terminals** — save, resume, search (`/recall`),
   rename, delete.
3. **Git-native** — branch in the status bar, `git_status`/`git_diff` tools,
   `/review` diffs, `/commit` auto-commit, worktree sandboxes.
4. **Money-aware** — live spend, `/cost` breakdown, hard budget ceilings.
5. **Nothing is permanent** — `/undo` per edit, `/rewind` per turn, guarded
   shell, verification with self-healing retries.
6. **Context-aware** — live context meter, real compaction, auto-compact, tool
   output bounds.
7. **Knows your project** — startup repo map + `ASTROCODE.md` memory.8. **Shows its work** — live task panel and status counters for multi-step work.
9. **Swarm-native** — parallel worktree-isolated agents with merge arbitration, built in (no tmux gymnastics).
10. **Speaks MCP both ways** — consume any MCP server's tools *and* expose your own to other agents, plus progressive-disclosure skills.
11. **Harness-engineered** — loop sensing, argument repair, salvaged sub-agent reports: reliability by mechanism, not by hoping the model behaves.
10. **A terminal you actually want to look at** — themes, modals, streaming,
    native selection, and a twinkling banner.

The full experience works in **offline demo mode** with zero API keys, so you
can audition everything before connecting a model.

---

## 📄 License

MIT
