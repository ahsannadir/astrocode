# AstroCode

AstroCode is a coding agent that lives in your terminal. Describe a task, and
it reads your repo, edits files, runs commands, and keeps going until the job
is done — streaming every step into the TUI so you can watch it work.

It's TypeScript on top of [Ink](https://github.com/vadimdemedes/ink) and React,
and runs on Node 18.8+. There are exactly two runtime dependencies (`ink` and
`react`): no Python, no database, no native modules.

Under the hood it's a normal agentic loop with 16 built-in tools, bounded
turns, and sub-agent delegation. You can point it at any provider that speaks
the OpenAI `/chat/completions` API — OpenAI, Anthropic, OpenRouter, or a local
server like Ollama, LM Studio, or vLLM. If you don't have an API key yet,
`--demo` runs a scripted local provider so you can try the whole pipeline
offline.

## Install

```bash
git clone https://github.com/ahsannadir/astrocode.git
cd astrocode
npm install
npm run build

node dist/index.js --demo    # no API key needed
```

To get an `astrocode` command on your PATH:

```bash
npm run link                  # build + npm link
# or: npm install -g /path/to/AstroCode
```

```bash
astrocode                       # launch in the current directory
astrocode --cwd ~/code/project  # point it at a project
astrocode -m gpt-4o             # override the model
astrocode serve                 # run as an MCP server over stdio
```

### Automation and integrations

AstroCode is an interactive terminal app, so it needs a real TTY. To let another
tool drive it — a script, an editor, or a different agent — use the MCP server,
which speaks JSON-RPC 2.0 over stdio and is read-only by default:

```bash
astrocode serve                          # expose AstroCode's tools to an MCP client
ASTROCODE_SERVE_WRITES=1 astrocode serve # opt in to mutating tools
```

With stdout piped or no terminal attached, AstroCode prints a banner with that
hint instead of trying to draw the TUI.

## Connecting a model

The easy way: start the TUI, type `/login`, pick a provider, and paste your
API key. Then `/models` picks a model. Credentials are saved to
`~/.astrocode/config.json` and reconnect automatically next launch.

The provider list covers OpenAI, Anthropic, OpenRouter, InferX, AgentRouter,
ZenMux, and TokenRouter. Pick **OpenAI Compatible** for anything else that
implements `POST /chat/completions` — AstroCode pulls the model list from
`GET <baseUrl>/models`, and keyless local endpoints run fully live (no demo
mode needed).

Once an **OpenAI Compatible** endpoint is saved, picking it in `/login` again
asks first: **Use existing configuration** reconnects with the saved base URL,
key and model, while **Configure again** reopens the wizard. Nothing is
rewritten unless you complete the wizard.

If you'd rather not use the popup:

```bash
export ASTROCODE_API_KEY=sk-...            # falls back to OPENAI_API_KEY
export ASTROCODE_MODEL=gpt-4o              # optional
export ASTROCODE_BASE_URL=https://api.openai.com/v1   # falls back to OPENAI_BASE_URL
```

## Using it

Type what you want, in plain English. Start a line with `/` and a menu pops up
that filters as you type: `↑`/`↓` scroll through every command, `Enter` runs
the highlighted one, and `Tab` completes it into the line so you can keep
typing arguments. `Esc` closes the menu without losing the line (press it
again to clear). Informational commands (`/help`, `/cost`, `/status`, …) still
work while the agent is mid-turn.

```text
You: add rate limiting to the login endpoint

❯ astrocode · reading src/routes/auth.ts · editing · running tests
```

While the agent works you can keep typing: **Enter queues** your prompt and it
runs when the current turn finishes, and **Esc interrupts** the agent mid-turn
(your typed text is kept for editing). Type `!cmd` to run a shell command
yourself — the agent isn't involved and doesn't see the output.

In `dangerous` or `all` shell-approval mode, `run_command` prompts before
executing: `y` runs once, `a` always allows that command prefix for the
session, `n`/`Esc` declines. Cycle the mode in `/settings` (or set
`ASTROCODE_APPROVAL_MODE`), and pre-approve trusted prefixes with
`ASTROCODE_APPROVE="npm test, git status"`.

There are two modes. `/plan` is read-only: reads, searches, and proposals
only, with writes and commands blocked at the tool layer rather than
discouraged in the prompt. `/act` gives the agent full access again. The
current mode is always visible in the status bar.

## Commands

Getting around:

| Command | What it does |
| --- | --- |
| `/help` | Show the built-in help |
| `/login`, `/models`, `/model <n>` | Connect a provider, pick a model |
| `/settings`, `/theme` | Settings menu; color themes (12 palettes) |
| `/plan`, `/act`, `/mode` | Switch modes, show the current one |
| `/clear`, `/new` | Start a fresh conversation |
| `/copy [all]` | Copy the last reply or the whole conversation |
| `/exit` | Quit (also `/quit` or `Ctrl+C`) |

Sessions, memory, context:

| Command | What it does |
| --- | --- |
| `/save`, `/load`, `/sessions`, `/delete` | Save, resume, list, and delete conversations |
| `/recall <q>` | Search your saved sessions (BM25-style, no dependencies) |
| `/memory [reload]` | Show the loaded project memory |
| `/compact`, `/context` | Compact the context; show window usage |
| `/map`, `/todo` | Show the repo map; show the live task list |

Git and safety:

| Command | What it does |
| --- | --- |
| `/review` | Diff of your working tree |
| `/verify` | Run detected lint/typecheck/tests |
| `/commit [msg]` | Commit the current changes |
| `/undo` | Revert the last file change |
| `/rewind` | Revert everything from the last turn |
| `/cost` | Token and spend breakdown for the session |

Agents and extensions:

| Command | What it does |
| --- | --- |
| `/tools`, `/agents` | List tools and sub-agent roles |
| `/swarm <goal>` | Parallel worktree-isolated agents; also `/swarm status`, `/swarm cleanup` |
| `/mcp`, `/skills` | MCP servers and skill packages |
| `/status`, `/whoami`, `/stars` | Environment info, introspection, stardust |

## Keyboard

| Keys | Action |
| --- | --- |
| `↑` / `↓` | Prompt history (or browse the slash menu while it's open) |
| `Tab` | Complete the highlighted slash command (then type arguments) |
| `Enter` (menu open) | Run the highlighted slash command |
| `Enter` (while busy) | Queue the prompt for after the current turn |
| `Esc` (while busy) | Interrupt the running agent (typed text is kept) |
| `PgUp` / `PgDn` | Scroll the transcript |
| `Ctrl+U` | Clear the input line |
| `Ctrl+K` | Selection mode — `Enter` copies, `Esc` cancels |
| `Ctrl+Shift+C`, `Cmd+C` | Native terminal selection and copy |
| `Ctrl+C` | Quit |

## Tools

The 16 built-in tools. The read-only ones work in plan mode; the rest are
blocked there.

| Tool | Plan mode | What it does |
| --- | --- | --- |
| `read_file` | yes | Read a file (bounded output) |
| `list_dir` | yes | List a directory |
| `search_files` | yes | Grep-style content search |
| `git_status` | yes | Working-tree status |
| `git_diff` | yes | Unified diff (`staged` / `stat` options) |
| `repomap` | yes | Refresh the workspace map |
| `fetch_url` | yes | Fetch a URL and strip HTML to readable text |
| `spawn_agent` | yes | Delegate to bounded read-only sub-agents |
| `write_file` | – | Create or overwrite a file (snapshotted for `/undo`) |
| `edit_file` | – | Search/replace edit (snapshotted) |
| `multi_edit` | – | Many search/replace edits in one call |
| `apply_patch` | – | Multi-hunk patches with fuzzy line matching; all hunks land or nothing is written |
| `run_command` | – | Guarded shell runner |
| `todo` | – | Maintain the live task list |
| `worktree` | – | Ephemeral git-worktree sandbox (create / merge / discard) |
| `swarm` | – | Parallel worktree-isolated agents for a decomposed goal |

## What's in the box

**Sessions and memory.** Conversations save to `~/.astrocode/sessions` along
with their model and mode, so you can close the laptop and pick up tomorrow.
`/recall` searches them. A project `ASTROCODE.md` (or `AGENTS.md`) is injected
into the system prompt on every launch for conventions and build commands;
global rules go in `~/.astrocode/ASTROCODE.md`.

**Context management.** A compact repo map is built at startup — directory
tree, file counts, and summaries of key files like `package.json` scripts and
the README blurb. The status bar shows how full the model's context window is.
`/compact` collapses old tool batches into one-line summaries while keeping
the newest messages, tool-call/result pairing, and your task statements
intact; auto-compact fires around 85%, so long sessions degrade instead of
dying on a provider length error. Every tool result also passes through a
central head-and-tail truncator, so one `read_file` on a minified bundle can't
evict the conversation.

**Cost & context accuracy.** When the provider reports usage (OpenAI-family
`stream_options.include_usage`, Responses API `response.completed`, and
gateways that forward either), cost, the context meter, and budget enforcement
use the real numbers — including prompt-cache discounts — falling back to the
chars÷4 estimate only when a server reports nothing. Pricing covers current
OpenAI (GPT-5/4.1/o-series), Anthropic, Gemini, DeepSeek, and more.

**Undo, rewind, guardrails.** Every write/edit snapshots the original file for
`/undo`; `/rewind` restores the whole working tree to how it looked before the
last turn. `run_command` refuses obviously destructive commands (`rm -rf /`,
`dd`, `mkfs`, force-push, `reset --hard`) unless the model explicitly forces
them, and plan mode blocks execution entirely. `ASTROCODE_BUDGET` sets a hard
spend ceiling that pauses the loop.

**Verification.** With `ASTROCODE_VERIFY=1`, AstroCode detects and runs your
typecheck, lint, and tests after edits (from `package.json`, `Makefile`,
`Cargo.toml`, or `go.mod`); `ASTROCODE_AUTOCOMMIT=1` commits afterwards. When
a check fails, the errors are handed back to the agent to fix, up to two
rounds, instead of ending the turn on a red test.

**Swarm mode.** `/swarm <goal>` splits a goal into up to five independent
subtasks, gives each worker its own git worktree and branch, runs a full agent
loop per worker in parallel, then merges the builders' branches back and keeps
the researchers' reports. Failed workers are skipped with their branches kept
for a manual retry; `/swarm cleanup` discards the lot.

**MCP and skills.** List MCP servers in `.astrocode/mcp.json` (same shape as
Claude Code's config) and their tools appear as `mcp_<server>_<tool>`.
`astrocode serve` goes the other way, exposing AstroCode's tools over JSON-RPC
2.0 stdio so another agent can delegate work to it; it's read-only unless
`ASTROCODE_SERVE_WRITES=1` and never exposes `spawn_agent`, `worktree`, or
`todo`. Skills are Markdown packages in `.astrocode/skills/<name>/SKILL.md`
that cost one line of context until the agent actually loads them.

**Sub-agents.** `spawn_agent` delegates to `researcher`, `file-picker`,
`code-searcher`, or `reviewer`, each with read-only tools and hard
turn/time/report budgets. Pass a `workers` array to run up to five at once and
merge their reports. Sub-agents can't edit files or spawn children.

**Harness details.** The reliability work is mechanical rather than
prompt-based: repeated identical tool calls are nudged and then blocked, with
the first result replayed; malformed tool arguments (markdown fences, trailing
commas, type drift) are repaired instead of failing the turn; and a sub-agent
that burns its budget without answering gets one final tool-less call to write
its report.

**The TUI.** A twinkling ASCII banner, streaming replies rendered as real
markdown — headings, nested emphasis, links, images, task lists, tables and
framed fenced code blocks with syntax highlighting for ~30 languages. Code
fences understand diff/patch (`+`/`-`/hunk headers get their own colors), and
inline spans are parsed before wrapping so bold/code that crosses a line break
keeps its styling instead of leaking `**` markers. Layout is measured in
terminal cells, so CJK text and emoji wrap where they should. On top of that a
live status bar (mode, model, context %, tasks, spend, branch, cwd), a task
panel the agent keeps updated via the `todo` tool, and real modals for
`/login`, `/models`, `/settings`, and `/theme`. Twelve color themes, each with
its own syntax palette — scrolling `/theme` previews them live in the whole UI,
and Esc puts the previous theme back. Your terminal's native mouse selection works, and
`Ctrl+K` copies clean text without banners or prefixes; `/copy` grabs the last
reply. If stdout isn't a TTY (CI, a pipe), it prints a banner and exits instead
of crashing.

## Configuration

### CLI flags

```text
astrocode [options]

  -d, --demo         Force offline demo mode (no API key needed)
  -m, --model <n>    Set the model (e.g. gpt-4o)
      --cwd <path>   Working directory (default: current)
      --serve        Run as an MCP server over stdio
  -h, --help         Show help
  -v, --version      Show version

astrocode serve [--cwd <path>]    # same as --serve
```

### Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `ASTROCODE_API_KEY` | API key (also reads `OPENAI_API_KEY`) | – |
| `ASTROCODE_BASE_URL` | OpenAI-compatible base URL (also reads `OPENAI_BASE_URL`) | `https://api.openai.com/v1` |
| `ASTROCODE_MODEL` | Default model | provider default (`gpt-4o` for OpenAI) |
| `ASTROCODE_MAX_TURNS` | Max tool-call turns per request | `20` |
| `ASTROCODE_BUDGET` | Hard USD spend ceiling per session (`0` = none) | `0` |
| `ASTROCODE_VERIFY` | Run lint/tests after edits (`1`/`true`) | off |
| `ASTROCODE_AUTOCOMMIT` | Commit changes after a turn (`1`/`true`) | off |
| `ASTROCODE_APPROVAL_MODE` | Shell approval for run_command: `off`/`dangerous`/`all` | `off` |
| `ASTROCODE_APPROVE` | Pre-approved command prefixes, comma-separated | – |
| `ASTROCODE_THEME` | Color theme (see `/theme`) | `astro` |
| `ASTROCODE_SESSION_DIR` | Where `/save` sessions live | `~/.astrocode/sessions` |
| `ASTROCODE_CONFIG_DIR` | Config directory | `~/.astrocode` |
| `ASTROCODE_AUTH_FILE` | Override the auth file path | `<config dir>/config.json` |
| `ASTROCODE_SERVE_WRITES` | Allow mutating tools over the MCP bus (`1`) | off |

Anything toggled in `/settings` (theme, verify, auto-commit, max turns,
budget, mode) is written to `~/.astrocode/config.json` and applies immediately.

## Project memory

Drop an `ASTROCODE.md` in your repo root and it lands in the system prompt on
every launch:

```markdown
# Project conventions

- Use pnpm, never npm.
- API routes live in src/routes; handlers return Result<T>.
- Run `npm run typecheck` before declaring anything done.
```

Global rules go in `~/.astrocode/ASTROCODE.md`.

## Architecture

Most of the code is in `src/`: provider clients in `ai/`, the Ink UI in `tui/`,
and the tools (with their danger guard and plan-mode gating) in
`tools/registry.ts`. The rest is harness work — sessions, memory, repo map,
cost tracking, verification, undo/rewind, compaction, loop sensing, argument
repair, output truncation, sub-agents, swarm, worktrees, and the MCP client
and server. `src/commands/slash.ts` handles the slash commands, and
`src/index.tsx` is the CLI entry point.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test suite via tsx (tests/*.test.ts)
npm run probe       # build + drive the real TUI in a pty (Python 3)
npm run build       # tsc -> dist/
npm run dev         # run from source with tsx
```

The tests cover the harness pieces: patch application, compaction, argument
repair, truncation, sessions, cost math, and more. They run offline with fake
providers and temp dirs, so they're safe in CI.

`npm run probe` covers what unit tests can't: the keystroke → Ink → frame
path. Each probe boots the built CLI in a pty in `--demo`, types real keys, and
asserts on the emulated screen — popups opening and closing on `Esc`, the
`/models` picker, and the `/login` reuse prompt — then the runner stops at the
first failure. It needs Python 3 and a build (`npm run probe` builds first).
Every probe is a script in `scripts/`; `python3 scripts/run_probes.py --list`
shows which ones are part of the gate and which are diagnostics.

## FAQ

**Does it work without an API key?**
Yes. `--demo` runs a scripted local provider that streams text and drives the
real tool loop. Everything except live model intelligence works.

**Where does it store data?**
Under `~/.astrocode/` — sessions, auth config, global memory. Override with
`ASTROCODE_CONFIG_DIR` and `ASTROCODE_SESSION_DIR`; worktree sandboxes live in
the system temp directory.

**Can it run arbitrary shell commands?**
Through a guarded, bounded runner. Destructive commands are refused unless
explicitly forced, and plan mode blocks command execution entirely.

**Is my code sent anywhere?**
Only to the model provider you configure. There's no AstroCode telemetry or
middleman server.

## License

MIT

