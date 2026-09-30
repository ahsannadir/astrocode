#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { writeSync } from 'node:fs';
import { App } from './tui/App.js';
import { renderAsciiText, ASCII_LINES } from './tui/ascii.js';
import { setTheme } from './tui/theme.js';
import { loadConfig, parseArgs, VERSION } from './config.js';
import { getToolNames } from './tools/registry.js';
import { runHeadless, readStdinIfPiped } from './headless.js';
import { ApprovalGate, normalizeApprovalMode, parseApproveEnv } from './approval.js';
import { loadSession } from './sessions.js';

const HELP = `AstroCode — AI terminal coding agent

USAGE
  astrocode [options]          launch the interactive TUI
  astrocode -p "task"          one-shot headless run (for scripts & CI)
  astrocode serve [--cwd dir]  run as an MCP server (Open Tool Bus)

OPTIONS
  -d, --demo         Force offline demo mode (no API key needed)
  -m, --model <n>    Set the model (e.g. gpt-4o-mini)
  -p, --print <t>    Headless: run <t> to completion, print, exit
      --json         With -p: emit machine-readable JSON instead of text
  -c, --continue <n> With -p: resume a saved session (see /sessions)
      --plan         With -p: plan mode (read-only analysis)
      --cwd <path>   Working directory (default: current)
      --serve        Run as an MCP server over stdio (same as 'serve')
  -h, --help         Show this help
  -v, --version      Show version

ENVIRONMENT
  ASTROCODE_API_KEY    API key (also reads OPENAI_API_KEY)
  ASTROCODE_BASE_URL   OpenAI-compatible endpoint (default https://api.openai.com/v1)
  ASTROCODE_MODEL      Default model
  ASTROCODE_MAX_TURNS  Max tool-call turns per request
  ASTROCODE_BUDGET     Max USD spend for a session (0 = unlimited)
  ASTROCODE_VERIFY     Run lint/test after edits (1 = on)
  ASTROCODE_AUTOCOMMIT Auto-commit changes after a turn (1 = on)
  ASTROCODE_APPROVAL_MODE  Shell approval: off (default) | dangerous | all
  ASTROCODE_APPROVE    Pre-approved command prefixes, comma-separated ("npm test, git status")
  ASTROCODE_THEME      Color theme (astro, aurora, cyberpunk, dracula, forest,
                       inferno, matrix, nebula, noir, ocean, sunset, synthwave)
  ASTROCODE_SESSION_DIR  Where /save sessions are stored (default ~/.astrocode/sessions)
  ASTROCODE_SERVE_WRITES Allow mutating tools over the MCP bus (1 = on; default read-only)

EXAMPLES
  astrocode --demo
  ASTROCODE_API_KEY=sk-... astrocode --model gpt-4o
  ASTROCODE_BUDGET=2.0 astrocode
  ASTROCODE_VERIFY=1 ASTROCODE_AUTOCOMMIT=1 astrocode
  astrocode -p "summarize what changed in git diff --staged" | less
  echo "extra context" | astrocode -p "review my changes"
  astrocode -p --json "list every TODO in src/" > report.json
  astrocode serve   # then point any MCP client (e.g. Claude Code) at it

SLASH COMMANDS
  /help /copy /login /models /settings /theme /model /plan /act /clear /save
  /load /sessions /new /undo /rewind /review /verify /commit /cost /tools
  /agents /swarm /mcp /skills /recall /compact /context /memory /map /todo
  /status /stars /whoami /delete /exit`;

function printBanner() {
  // ANSI colors for a nice non-interactive print.
  const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
  const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;
  const star = (s: string) => `\x1b[35m${s}\x1b[0m`;
  const lines = [
    `✦ ASTROCODE ✦`,
    ...ASCII_LINES.map((l, i) => (i % 2 === 0 ? cyan(l) : magenta(l))),
    `✦ ✦ AI TERMINAL CODING AGENT ✦ ✦`,
  ];
  process.stdout.write(lines.join('\n') + '\n' + star(' ✦ ') + '\n');
}

// ── alternate screen buffer ──────────────────────────────────────────────
// The TUI re-renders the twinkling banner ~6×/second. In the primary screen
// buffer every frame is appended to the terminal's scrollback, so scrolling
// the mouse wheel reveals stacked duplicate frames (the "glitch"). The
// alternate screen buffer (ESC[?1049h) is a separate page with NO scrollback
// — exactly what vim, htop, and less use. We enter it on startup and restore
// the primary buffer on every exit path so the user's shell history is intact.

const ENTER_ALT = '\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l'; // alt screen + clear + home + hide cursor
const EXIT_ALT = '\x1b[?25h\x1b[?1049l'; // show cursor + restore primary screen

function enterAltScreen(): void {
  process.stdout.write(ENTER_ALT);
}

/** Restore the primary screen buffer. Idempotent + safe in signal handlers. */
function exitAltScreen(): void {
  try {
    writeSync(1, EXIT_ALT);
  } catch {
    try {
      process.stdout.write(EXIT_ALT);
    } catch {
      // stdout already torn down — nothing more we can do.
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const serveMode = argv[0] === 'serve' || argv.includes('--serve');
  const args = parseArgs(serveMode && argv[0] === 'serve' ? argv.slice(1) : argv);

  if (args.help) {
    printBanner();
    process.stdout.write('\n' + HELP + '\n');
    return;
  }
  if (args.version) {
    process.stdout.write(`AstroCode v${VERSION}\n`);
    return;
  }

  const config = loadConfig(args);
  const cwd = args.cwd || process.cwd();

  // ---- headless one-shot mode (-p / --print) ------------------------------
  // Runs the same agent loop as the TUI, prints the final answer (streamed
  // live), and exits with a meaningful code: 0 ok · 1 error · 2 verify fail.
  // Piped stdin is prepended to the prompt, so `cat err.log | astrocode -p
  // "explain"` works. Ctrl+C aborts like any CLI process.
  if (args.print !== undefined) {
    const piped = await readStdinIfPiped();
    const prompt = (piped ? piped.trim() + '\n\n' : '') + args.print;
    if (!prompt.trim()) {
      process.stderr.write('astrocode: -p/--print requires a task (or piped stdin).\n');
      process.exitCode = 1;
      return;
    }
    let resume = null;
    if (args.continueSession) {
      const s = await loadSession(args.continueSession);
      if (!s) {
        process.stderr.write(`astrocode: no saved session named "${args.continueSession}" (see /sessions in the TUI).\n`);
        process.exitCode = 1;
        return;
      }
      resume = s.messages ?? [];
    }
    const gate = new ApprovalGate(
      // Headless can't prompt: 'dangerous'/'all' auto-denies un-approved
      // commands (fail closed). Pre-approved prefixes from ASTROCODE_APPROVE
      // still run.
      normalizeApprovalMode(
        process.env.ASTROCODE_APPROVAL_MODE ?? config.approvalMode,
      ) === 'off'
        ? 'off'
        : 'dangerous',
      parseApproveEnv(process.env.ASTROCODE_APPROVE),
    );
    const outcome = await runHeadless({
      config,
      cwd,
      prompt,
      mode: args.plan ? 'plan' : 'act',
      resume,
      json: args.json === true,
      approvalGate: gate,
    });
    process.exitCode = outcome.exitCode;
    return;
  }

  // ---- MCP server mode (Open Tool Bus) ------------------------------------
  // Exposes AstroCode's tools over JSON-RPC 2.0 stdio so any MCP client
  // (Claude Code, an editor, another agent) can delegate work to this repo.
  // Read-only unless ASTROCODE_SERVE_WRITES=1. No banner — stdio is the bus.
  if (serveMode) {
    const { serveStdio } = await import('./serve.js');
    await serveStdio({
      cwd,
      allowWrites: /^(1|true|yes|on)$/i.test(process.env.ASTROCODE_SERVE_WRITES ?? ''),
    });
    return;
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    // Non-interactive context (pipes, CI): print banner + context instead of crashing.
    printBanner();
    process.stdout.write(
      `\nAstroCode v${VERSION}\n` +
        `This is an interactive TUI — it needs a real terminal to run.\n` +
        `Mode: ${config.demo ? 'demo (offline)' : 'live'} · Model: ${config.model}\n` +
        `Provider: ${config.baseUrl}\n` +
        `Workspace: ${cwd}\n` +
        `Tools primed: ${getToolNames().join(', ')}\n` +
        `\nRun \`npx tsx src/index.ts --demo\` in an interactive shell to launch the UI.\n`,
    );
    return;
  }

  // ---- interactive TUI ----
  // Apply the saved color theme before the first frame so there's no flash
  // of the default palette (App re-applies it too — idempotent).
  setTheme(config.theme);
  // Enter the alternate screen buffer so the twinkling banner animation never
  // pollutes the user's scrollback, then restore it on every exit path.
  enterAltScreen();
  const restore = () => exitAltScreen();
  process.on('exit', restore);
  process.on('SIGINT', () => {
    restore();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    restore();
    process.exit(0);
  });
  process.on('SIGHUP', () => {
    restore();
    process.exit(0);
  });
  try {
    const instance = render(<App config={config} cwd={cwd} />);
    await instance.waitUntilExit();
  } finally {
    exitAltScreen();
  }
}

main().catch((e) => {
  process.stderr.write(`AstroCode fatal error: ${e?.stack || e}\n`);
  process.exitCode = 1;
});
