<p align="center">  
  <picture>  
    <source media="(prefers-color-scheme: dark)" srcset="assets/astrobanner-dark.png">  
    <source media="(prefers-color-scheme: light)" srcset="assets/astrobanner.png">  
    <img alt="AstroCode — a fast terminal coding agent" src="assets/astrobanner.png">  
  </picture>  
</p>

# AstroCode

<p align="center">
  <a href="https://www.npmjs.com/package/astrocode"><img alt="npm version" src="https://img.shields.io/badge/npm-v2026.10.4-blue"></a>
  <a href="https://nodejs.org"><img alt="node version" src="https://img.shields.io/badge/node-%3E%3D24.16.0%20%3C25%20%7C%7C%20%3E%3D26.1.0-green"></a>
  <img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-green">
</p>

**A fast terminal coding agent: sub-agents, and swarm mode, on exactly two dependencies.**

AstroCode lives in your terminal. Describe a task and it reads the repo, edits  
files, runs commands, and keeps going until the job is done — streaming every  
step into the TUI so you can watch it work and interrupt it mid-thought.

It's TypeScript on [Ink](https://github.com/vadimdemedes/ink) and React, running  
on Node 18.8+ with two runtime dependencies (`ink`, `react`). No Python, no  
database, no native modules, nothing to compile.

Under the hood it's a plain agentic loop — bounded turns, 16 built-in tools,  
sub-agent delegation — pointed at any provider that speaks the OpenAI  
`/chat/completions` API: OpenAI, Anthropic, OpenRouter, or a local server like  
Ollama, LM Studio, or vLLM. No API key yet? `--demo` runs a scripted local  
provider so you can try the whole pipeline offline.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ahsannadir/astrocode/main/scripts/install.sh | bash
```

The installer checks for Node 18.8+, installs from the npm registry, and falls  
back to a source build when the package isn't published yet — the same command  
works either way. It puts `astrocode` on your `PATH`; pass `--version <v>` to  
pin a release or `--from-source` to skip the registry entirely.

### From source

```bash
git clone https://github.com/ahsannadir/astrocode.git
cd astrocode && npm install && npm run build
node dist/index.js --demo      # no API key needed
npm run link                   # optional: `astrocode` on your PATH
```

## Connecting a model

Start the TUI, run `/login`, pick a provider, paste a key. `/models` then picks  
a model. Credentials are saved to `~/.astrocode/config.json` and reconnect  
automatically on the next launch.

The provider list covers OpenAI, Anthropic, OpenRouter, InferX, AgentRouter,  
ZenMux, and TokenRouter. For anything else that implements  
`POST /chat/completions`, choose **OpenAI Compatible**: AstroCode pulls the  
model list from `GET <baseUrl>/models`, and keyless local endpoints run fully  
live — no demo mode needed.

Once a compatible endpoint is saved, picking it again asks whether to reuse the  
saved base URL, key, and model or to reopen the wizard. Nothing is rewritten  
unless you finish the wizard.

If you'd rather skip the popup, set `ASTROCODE_API_KEY` (or `OPENAI_API_KEY`),  
`ASTROCODE_BASE_URL`, and `ASTROCODE_MODEL`. `astrocode --help` lists every  
variable AstroCode reads.


## Using it

Type what you want, in plain English. A line starting with `/` opens a menu that  
filters as you type: `↑`/`↓` to move, `Enter` to run, `Tab` to complete the  
command into the line so you can keep typing arguments, `Esc` to dismiss the  
menu without losing what you've written.

```text
You: add rate limiting to the login endpoint

❯ astrocode · reading src/routes/auth.ts · editing · running tests
```

The agent doesn't lock you out while it works. **Enter queues** your next prompt  
for when the current turn ends; **Esc interrupts** mid-turn and keeps your typed  
text for editing. `!cmd` runs a shell command yourself — outside the agent's  
view and outside its context.

Two modes decide what the agent may touch. `/plan` is read-only: reads,  
searches, and proposals, with writes and commands blocked at the tool layer  
rather than discouraged in the prompt. `/act` restores full access. The status  
bar always shows which one you're in.

Shell commands are guarded the same way. In `dangerous` or `all` approval mode,  
`run_command` asks before executing: `y` runs once, `a` always allows that  
command prefix for the session, `n` or `Esc` declines. Obviously destructive  
commands are refused outright unless the model explicitly forces them.

## What's in the box

### Sessions and context

Conversations save to `~/.astrocode/sessions` along with their model and mode,  
so you can close the laptop and pick up tomorrow; `/recall` searches them with a  
dependency-free BM25-style index. A compact repo map — directory tree, file  
counts, `package.json` scripts, README blurb — is built at startup and available  
on demand.

Context is managed rather than hoped for. `/compact` collapses old tool batches  
into one-line summaries while keeping the newest messages, tool-call/result  
pairing, and your own task statements intact; auto-compact fires near 85% of the  
window, so long sessions degrade instead of dying on a provider length error.  
Every tool result also passes through a central head-and-tail truncator, so one  
`read_file` on a minified bundle can't evict the conversation.

### Safety and recovery

Every write and edit snapshots the original file, so `/undo` reverts the last  
change and `/rewind` restores the whole working tree to how it looked before the  
last turn. `run_command` refuses `rm -rf /`, `dd`, `mkfs`, force-push, and  
`reset --hard` unless the model explicitly forces them, and plan mode blocks  
execution entirely. `ASTROCODE_BUDGET` sets a hard spend ceiling that pauses the  
loop.

### Cost and verification

When the provider reports usage — OpenAI-family `stream_options.include_usage`,  
Responses API `response.completed`, or a gateway forwarding either — cost, the  
context meter, and budget enforcement use the real numbers, prompt-cache  
discounts included. Pricing covers current OpenAI (GPT-5/4.1/o-series),  
Anthropic, Gemini, and DeepSeek; the chars÷4 estimate is only a fallback for  
servers that report nothing.

With `ASTROCODE_VERIFY=1`, AstroCode detects and runs your typecheck, lint, and  
tests after edits (from `package.json`, `Makefile`, `Cargo.toml`, or `go.mod`),  
and `ASTROCODE_AUTOCOMMIT=1` commits afterwards. A failing check hands the  
errors back to the agent for up to two repair rounds instead of ending the turn  
on a red test.

### Delegation

`spawn_agent` hands work to `researcher`, `file-picker`, `code-searcher`, or  
`reviewer` — read-only tools, hard turn/time/report budgets, no file edits, no  
child agents. Pass a `workers` array to run up to five at once and merge their  
reports.

`/swarm <goal>` goes further: it splits a goal into independent subtasks, gives  
each worker its own git worktree and branch, runs a full agent loop per worker  
in parallel, then merges the builders' branches back and keeps the researchers'  
reports. Failed workers are skipped with their branches kept for a manual retry;  
`/swarm cleanup` discards the lot.

### Extensibility

List MCP servers in `.astrocode/mcp.json` (the same shape as Claude Code's  
config) and their tools appear as `mcp_<server>_<tool>`. `astrocode serve` points  
the other direction: it exposes AstroCode's own tools over JSON-RPC 2.0 on stdio  
so another agent or editor can delegate to it — read-only unless  
`ASTROCODE_SERVE_WRITES=1`, and never exposing `spawn_agent`, `worktree`, or  
`todo`.

Skills are Markdown packages at `.astrocode/skills/<name>/SKILL.md` that cost one  
line of context until the agent actually loads them.


### The interface

A twinkling ASCII banner, and streamed replies rendered as real markdown —  
headings, nested emphasis, links, images, tables, task lists, and framed code  
blocks with syntax highlighting for ~30 languages. Diff and patch fences color  
their `+`/`-` lines and hunk headers. Inline spans are parsed before wrapping, so  
emphasis crossing a line break keeps its styling instead of leaking `**`  
markers; layout is measured in terminal cells, so CJK text and emoji wrap where  
they should.

Around that sit a live status bar (mode, model, context %, tasks, spend, branch,  
cwd), a task panel the agent keeps current through the `todo` tool, and real  
modals for `/login`, `/models`, `/settings`, and `/theme`. Twelve themes each  
carry their own syntax palette — scrolling `/theme` previews them live, and `Esc`  
puts the previous theme back. Your terminal's native mouse selection works, and  
`Ctrl+K` copies clean text without banners or prefixes.

If stdout isn't a TTY (CI, a pipe), AstroCode prints a banner and exits instead  
of crashing.

### Reliability by construction

The robustness work is mechanical rather than prompt-based: repeated identical  
tool calls are nudged and then blocked, with the first result replayed; malformed  
tool arguments (markdown fences, trailing commas, type drift) are repaired  
instead of failing the turn; and a sub-agent that burns its budget without  
answering gets one final tool-less call to write its report.

## Configuration

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

Anything you toggle in `/settings` — theme, verify, auto-commit, max turns,  
budget, mode — is written to `~/.astrocode/config.json` and applies immediately.  
`astrocode --help` prints the flags, the environment variables, and the full  
command list.

## Project memory

A project `ASTROCODE.md` (or `AGENTS.md`) in the repo root is injected into the  
system prompt on every launch: conventions, build commands, and anything the  
agent should never have to rediscover. Global rules go in  
`~/.astrocode/ASTROCODE.md`, and `/memory` shows what's currently loaded.

```markdown
# Project conventions

- Use pnpm, never npm.
- API routes live in src/routes; handlers return Result<T>.
- Run `npm run typecheck` before declaring anything done.
```

## Architecture

```text
src/
  index.tsx     CLI entry: flags, alternate-screen lifecycle, TUI mount
  ai/           provider clients — OpenAI chat + Responses, local demo
  tui/          Ink UI: App, layout, markdown, syntax, modals, theme
  tools/        registry.ts — the 16 tools, danger guard, plan-mode gating
  commands/     slash.ts — command table, filtering, resolution
  (harness)     sessions, memory, repomap, compact, cost, verify, undo,
                loopsensor, toolargs, tooloutput, subagent, swarm,
                worktree, mcp, skills, serve
tests/          node:test suites — offline, fake providers, temp dirs
scripts/        install.sh, pty probes, run_probes.py
```

The loop itself is small; most of the code is the harness around it. Tools are  
`{ schema, handler }` entries registered in one place, and the registry — not the  
prompt — decides what plan mode allows. `src/tui/markdown.ts` owns rendering and  
stays pure, so it can be tested without a terminal.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test suites via tsx
npm run build       # tsc -> dist/
npm run dev         # run from source with tsx
npm run probe       # build + drive the real TUI in a pty (needs Python 3)
```

The unit tests cover the harness pieces — patch application, compaction,  
argument repair, truncation, sessions, cost math — and run offline against fake  
providers and temp dirs, so they're safe in CI.

`npm run probe` covers what unit tests can't: the keystroke → Ink → frame path.  
Each probe boots the built CLI in a pty in `--demo`, types real keys, and  
asserts on the emulated screen — popups opening and closing on `Esc`, the  
`/models` picker, the `/login` reuse prompt — then the runner stops at the first  
failure. `python3 scripts/run_probes.py --list` shows which probes gate a release  
and which are diagnostics.

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
