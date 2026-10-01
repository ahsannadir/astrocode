import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useStdout } from 'ink';
import { Banner } from './Banner.js';
import { MessageArea, type AgentWorker, type UIItem } from './MessageArea.js';
import { PromptInput } from './PromptInput.js';
import { SlashMenu } from './SlashMenu.js';
import { StatusBar } from './StatusBar.js';
import { TodoPanel } from './TodoPanel.js';
import { LoginModal, type LoginMeta } from './LoginModal.js';
import { ModelsModal } from './ModelsModal.js';
import { SettingsMenu } from './SettingsMenu.js';
import { ThemeModal } from './ThemeModal.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { ApprovalGate, normalizeApprovalMode, parseApproveEnv } from '../approval.js';
import type { ApprovalDecision } from '../approval.js';
import { theme, setTheme, THEME_NAMES } from './theme.js';
import type { AppConfig, ChatMessage, PlanMode, TokenFragment } from '../types.js';
import { createProvider } from '../ai/provider.js';
import {
  executeTool,
  getToolSchemas,
  PLAN_ALLOWED_TOOLS,
} from '../tools/registry.js';
import type { ToolProgressEvent } from '../tools/registry.js';
import { runSlashCommand, filterSlashCommands, SLASH_SAFE_WHILE_BUSY } from '../commands/slash.js';
import { runShell } from '../tools/shell.js';
import {
  revertLast,
  markTurnBoundary,
  changesSinceLastBoundary,
  rewindTurn,
} from '../undo.js';
import { formatCost, pricingFor, estimateTokens, costFromUsage, contextLimitFor, estimateContextTokens } from '../cost.js';
import { loadMemory, getMemoryText } from '../memory.js';
import { buildRepoMap, getRepoMap } from '../repomap.js';
import { listTodos, clearTodos } from '../todos.js';
import { clearAgentHistory } from '../agents.js';
import { runVerify, autoCommit } from '../verify.js';
import { LoopSensor } from '../loopsensor.js';
import {
  compactConversation,
  describeCompaction,
} from '../compact.js';
import type { CompactResult } from '../compact.js';
import type { ApprovalMode } from '../approval.js';
import type { AIProvider } from '../types.js';
import { loadAuth, saveAuth, authFilePath, type AuthConfig } from '../auth.js';
import { copyToClipboard } from '../clipboard.js';
import { providerById, PROVIDERS } from '../providers.js';
import { connectAllMcp, disconnectAllMcp, mcpServerNames } from '../mcp.js';
import { loadSkills, skillsPromptBlock } from '../skills.js';
import type { SwarmEvent } from '../swarm.js';

interface Props {
  config: AppConfig;
  cwd: string;
}

const BANNER_H = 7; // header(1) + 5 logo rows + footer(1)
const STATUS_H = 3; // bordered status bar: top border + content + bottom border
const PROMPT_H = 4; // hint line(1) + bordered input box(3)
const APPROVAL_H = 5; // bordered approval prompt: title + command + cwd + hint + borders
const MIN_MESSAGE_H = 3; // keep at least one content line + breathing room

// Cycle options for the /settings menu (module-level so they stay static).
const TURN_OPTIONS = [5, 10, 20, 50, 100];
const BUDGET_OPTIONS = [0, 1, 2, 5, 10];

export function App({ config, cwd }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const width = Math.max(30, columns);

  // ---- state ----
  const [model, setModelState] = useState(config.model);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [, setVersion] = useState(0);
  const [tick, setTick] = useState(0);
  const [tokenCount, setTokenCount] = useState(0);
  const [mode, setModeState] = useState<PlanMode>('act');
  const [sessionName, setSessionName] = useState('session');
  const [costUsd, setCostUsd] = useState(0);
  const [gitBranch, setGitBranch] = useState('');
  const [slashSel, setSlashSel] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [contextTokens, setContextTokens] = useState(0);
  const [contextLimit, setContextLimit] = useState(contextLimitFor(config.model));
  const [, setTodoVersion] = useState(0);
  // ---- interactive popups (/login, /models, /settings, /theme) + copy mode ----
  const [modal, setModal] = useState<null | 'login' | 'models' | 'settings' | 'theme'>(null);
  const [themeName, setThemeName] = useState('astro');
  const [copyMode, setCopyMode] = useState(false);
  // ---- shell approval (run_command gating) ----
  const [pendingApproval, setPendingApproval] = useState<{ command: string; resolve: (d: ApprovalDecision) => void } | null>(null);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(
    () => normalizeApprovalMode(config.approvalMode ?? process.env.ASTROCODE_APPROVAL_MODE),
  );
  const approvalGateRef = useRef<ApprovalGate>(
    new ApprovalGate(approvalMode, parseApproveEnv(process.env.ASTROCODE_APPROVE)),
  );
  // ---- queued prompts typed while the agent is busy ----
  const [queue, setQueue] = useState<string[]>([]);
  const queueRef = useRef<string[]>([]);
  const [connected, setConnected] = useState(!config.demo);
  const [providerId, setProviderId] = useState<string>(
    () => loadAuth()?.provider ?? PROVIDERS[0].id,
  );

  // ---- slash-command overlay state ----
  // The menu stays browsable while the agent is busy (informational commands
  // run mid-turn), and it windows the FULL match list so "/" + ↑/↓ can reach
  // every command instead of just the first screenful.
  const slashNeedle = input.startsWith('/') ? input.slice(1) : null;
  // Cap visible rows so the menu + layout never exceeds the terminal height.
  // Available = rows - BANNER_H - STATUS_H - PROMPT_H - MIN_MESSAGE_H - 3(menu chrome)
  const slashRowCap = Math.min(
    8,
    Math.max(3, rows - BANNER_H - STATUS_H - PROMPT_H - MIN_MESSAGE_H - 3),
  );
  const slashMatches = useMemo(
    () => (slashNeedle === null ? [] : filterSlashCommands(slashNeedle)),
    [slashNeedle],
  );
  const slashActive =
    slashNeedle !== null && slashMatches.length > 0 && !slashDismissed;
  // Typing re-opens a dismissed menu, and a changed query re-ranks the list,
  // so reset the highlight to the top match instead of leaving a stale index
  // pointing at a different command than the one the user typed.
  useEffect(() => {
    setSlashDismissed(false);
  }, [input]);
  useEffect(() => {
    setSlashSel(0);
  }, [slashNeedle]);

  // ---- layout: account for the slash menu so total never exceeds terminal ----
  // SlashMenu = top-border(1) + visible items(N) + hint(1) + bottom-border(1)
  const slashMenuH = slashActive ? Math.min(slashMatches.length, slashRowCap) + 3 : 0;
  // Live task panel (only when there are todos). Title(1) + rows + borders(2),
  // plus one "earlier tasks hidden" notice row when the list was trimmed.
  const todos = listTodos();
  const todoRows = Math.min(todos.length, 6);
  const todoH = todos.length > 0 ? todoRows + 3 + (todos.length > 6 ? 1 : 0) : 0;

  // Login modal: title(1)+subtitle(1)+items(PROVIDERS.length)+hint(1)+borders(2).
  // Models modal: items(N)+title(1)+hint(1)+borders(2)+up to 2 "more" rows = N+6.
  // Settings modal: title(1)+rows(7)+hint(1)+borders(2) = 11.
  // Theme modal: title(1)+subtitle(1)+hint(1)+borders(2)+capped list rows.
  const modelsCap = Math.max(
    4,
    rows - BANNER_H - STATUS_H - MIN_MESSAGE_H - todoH - 6,
  );
  const themeCap = Math.max(4, rows - BANNER_H - STATUS_H - MIN_MESSAGE_H - todoH - 5);
  const modalH =
    modal === 'login'
      ? PROVIDERS.length + 5
      : modal === 'models'
        ? modelsCap + 6
        : modal === 'settings'
          ? 11
          : modal === 'theme'
            ? Math.min(THEME_NAMES.length, themeCap) + 5
            : 0;
  const promptH = modal !== null ? modalH : PROMPT_H;
  // The approval prompt replaces the input box visually but still costs rows.
  const approvalH = pendingApproval ? APPROVAL_H : 0;
  const queueH = queue.length > 0 ? 1 : 0;
  const messageHeight = Math.max(
    MIN_MESSAGE_H,
    rows - BANNER_H - STATUS_H - promptH - slashMenuH - todoH - approvalH - queueH,
  );
  const sel = Math.max(0, Math.min(slashSel, Math.max(0, slashMatches.length - 1)));
  const moveSlash = useCallback((dir: 1 | -1) => {
    setSlashSel((s) => {
      const n = slashMatches.length;
      if (n === 0) return s;
      return (s + dir + n) % n;
    });
  }, [slashMatches.length]);

  // ---- refs ----
  const itemsRef = useRef<UIItem[]>([]);
  const convRef = useRef<ChatMessage[]>([]);
  const providerRef = useRef<AIProvider | null>(null);
  if (providerRef.current === null) {
    providerRef.current = createProvider({ ...config, model: config.model });
  }
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const configRef = useRef(config);
  const modeRef = useRef<PlanMode>('act');
  const runAgentRef = useRef<() => Promise<void>>();
  const costRef = useRef(0);
  const tokensRef = useRef(0);
  const pricingRef = useRef(pricingFor(config.model));
  const memoryRef = useRef('');
  const skillsLoaded = useRef(false);
  // Cost-accounting callback usable outside runAgent (swarm launcher, MCP
  // tool calls) — same math as runAgent's inline `charge`.
  const chargeRef = useRef<(input: string, output: string) => void>(() => {});
  useEffect(() => {
    chargeRef.current = (inputText: string, outputText: string) => {
      const p = pricingRef.current;
      const inTok = estimateTokens(inputText);
      const outTok = estimateTokens(outputText);
      const delta =
        (inTok / 1_000_000) * p.inputPerM + (outTok / 1_000_000) * p.outputPerM;
      costRef.current += delta;
      tokensRef.current += outTok;
      setCostUsd(costRef.current);
      setTokenCount(tokensRef.current);
    };
  }, []);
  const repoMapRef = useRef('');

  // Load the git branch once for the status bar.
  useEffect(() => {
    runShell('git rev-parse --abbrev-ref HEAD 2>/dev/null').then((r) => {
      if (r.ok && r.text.trim()) {
        setGitBranch(r.text.trim().replace(/\n.*/, ''));
      }
    });
  }, []);

  // Load project memory + build the repo map once, so the system prompt
  // carries project context from the very first turn. Apply the saved theme
  // (env ASTROCODE_THEME or ~/.astrocode/config.json) so the palette is right
  // before the first paint.
  useEffect(() => {
    loadMemory(cwd).then(({ text }) => {
      memoryRef.current = text;
      bump();
    });
    buildRepoMap(cwd).then((r) => {
      repoMapRef.current = r.text;
      bump();
    });
    // Open Tool Bus: connect configured MCP servers + load skills so their
    // tools/catalog are live before the first turn.
    connectAllMcp(cwd).then(({ connected, failed }) => {
      if (connected.length > 0) {
        pushItem({ kind: 'system', text: `🔌 MCP connected: ${connected.join(', ')}` });
      }
      for (const f of failed) {
        pushItem({ kind: 'system', text: `⚠ MCP "${f.name}" failed: ${f.error}` });
      }
    });
    loadSkills(cwd).then((catalog) => {
      if (catalog) {
        skillsLoaded.current = true;
        const n = catalog.split('\n').length - 2;
        pushItem({ kind: 'system', text: `🎓 Skills loaded: ${n} (see /skills)` });
      }
      bump();
    });
    setContextLimit(contextLimitFor(config.model));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  // Tear down MCP child processes when the TUI exits.
  useEffect(() => {
    return () => disconnectAllMcp();
  }, []);

  useEffect(() => {
    const applied = setTheme(config.theme);
    setThemeName(applied);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // Re-render when the terminal is resized: the layout (and the responsive
  // status bar) read stdout.rows/columns at render time, and Ink does not
  // watch for resize on its own. Without this, an idle session keeps its
  // stale frame after a resize.
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => bump();
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout, bump]);

  const pushItem = useCallback((item: UIItem) => {
    itemsRef.current.push(item);
    bump();
  }, [bump]);

  /**
   * Live-updates an agent_activity item from spawn_agent progress events.
   * Mutates the item in place (the MessageArea re-renders on each bump).
   */
  const updateAgentActivity = useCallback(
    (item: Extract<UIItem, { kind: 'agent_activity' }>, e: ToolProgressEvent) => {
      if (e.type === 'spawn_done') {
        item.active = false;
        bump();
        return;
      }
      if (e.type === 'worker_start') {
        if (!item.workers.some((w) => w.worker === e.worker)) {
          item.workers.push({
            worker: e.worker,
            role: e.role,
            task: e.task,
            tools: [],
            turns: 0,
            actions: 0,
            done: false,
          });
        }
        bump();
        return;
      }
      const w = item.workers.find((x) => x.worker === e.worker);
      if (!w) return;
      if (e.type === 'worker_tool') {
        w.tools.push(e.tool);
      } else if (e.type === 'worker_done') {
        w.turns = e.turns;
        w.actions = e.actions;
        w.done = true;
      }
      bump();
    },
    [bump],
  );

  // ---- shell approval: surface the prompt and await the user's decision ----
  // Installed once; the gate calls ask() synchronously from inside
  // run_command's handler, which awaits the promise until a key lands.
  useEffect(() => {
    approvalGateRef.current.setAsker(
      (req) =>
        new Promise<ApprovalDecision>((resolve) => {
          setPendingApproval({ command: req.command, resolve });
        }),
    );
    return () => approvalGateRef.current.setAsker(() => Promise.resolve('denied'));
  }, []);

  const handleApproval = useCallback(
    (d: ApprovalDecision) => {
      setPendingApproval((p) => {
        p?.resolve(d);
        return null;
      });
    },
    [],
  );

  const setModel = useCallback(
    (m: string) => {
      setModelState(m);
      providerRef.current = createProvider({ ...configRef.current, model: m });
      pricingRef.current = pricingFor(m);
      if (configRef.current.model !== m) {
        configRef.current = { ...configRef.current, model: m };
      }
    },
    [],
  );

  const setMode = useCallback((m: PlanMode) => {
    modeRef.current = m;
    setModeState(m);
  }, []);

  /**
   * /login completion: apply the new provider+key immediately (recreate the
   * provider), persist to ~/.astrocode/config.json, and flip the app live.
   * The 'openai-compatible' flow additionally supplies the base URL and the
   * model (picked from the fetched list or typed as a custom ID).
   */
  const handleLoginComplete = useCallback(
    (pid: string, apiKey: string, meta?: LoginMeta) => {
      const p = providerById(pid);
      const baseUrl = meta?.baseUrl || p.baseUrl;
      const model = meta?.model || p.defaultModel;
      configRef.current = {
        ...configRef.current,
        apiKey,
        baseUrl,
        model,
        provider: pid,
        demo: false,
      };
      saveAuth({
        provider: pid,
        apiKey,
        model,
        ...(meta?.baseUrl ? { baseUrl: meta.baseUrl } : {}),
      });
      setProviderId(pid);
      setConnected(true);
      setModel(model);
      setModal(null);
      pushItem({
        kind: 'system',
        text:
          `🔐 Connected to ${p.name}${meta?.baseUrl ? ` — ${meta.baseUrl}` : ''}. Key saved to ${authFilePath()}.\n` +
          `Model: ${model} — ${
            pid === 'openai-compatible'
              ? 're-run /login to change the endpoint or model.'
              : 'switch anytime with /models.'
          }`,
      });
    },
    [pushItem, setModel],
  );

  /** /models completion: switch model now and persist it for next launch. */
  const handleModelSelect = useCallback(
    (m: string) => {
      setModel(m);
      const stored = loadAuth();
      if (stored) saveAuth({ ...stored, model: m });
      setModal(null);
      pushItem({ kind: 'system', text: `Model switched to ${m}.` });
    },
    [pushItem, setModel],
  );

  /**
   * Ctrl+K selection done: push the copied text to the clipboard and report.
   */
  const handleCopy = useCallback(
    (text: string, lines: number) => {
      const res = copyToClipboard(text);
      setCopyMode(false);
      if (text === '') {
        pushItem({ kind: 'system', text: 'Nothing to copy — the selection was empty.' });
      } else if (res === 'failed') {
        pushItem({
          kind: 'error',
          text: 'Could not copy to the clipboard — your terminal lacks OSC 52 and no clipboard tool was found.',
        });
      } else {
        pushItem({
          kind: 'system',
          text: `Copied ${lines} line(s), ${text.length} chars to the clipboard.`,
        });
      }
    },
    [pushItem],
  );

  /**
   * /settings changes: apply to the live config, persist to config.json
   * (keeping any saved auth), and re-render so the menu shows new values.
   */
  const persistSettings = useCallback(
    (patch: Partial<AuthConfig>) => {
      configRef.current = { ...configRef.current, ...patch };
      const stored = loadAuth();
      const base: AuthConfig =
        stored ?? {
          provider: providerId,
          apiKey: configRef.current.apiKey,
          model: configRef.current.model,
        };
      saveAuth({ ...base, ...patch });
      bump();
    },
    [bump, providerId],
  );

  const cycleFrom = useCallback(
    <T,>(opts: readonly T[], cur: T): T =>
      opts[(opts.indexOf(cur) + 1 + opts.length) % opts.length],
    [],
  );

  /** /theme completion: apply the palette now and persist for next launch. */
  const handleThemeSelect = useCallback(
    (name: string) => {
      setTheme(name);
      setThemeName(name);
      persistSettings({ theme: name });
      setModal(null);
      pushItem({ kind: 'system', text: `Theme switched to ${name}.` });
    },
    [persistSettings, pushItem],
  );

  const handleCycleMode = useCallback(() => {
    // Mode is session state (like /plan & /act) — not persisted.
    setMode(modeRef.current === 'plan' ? 'act' : 'plan');
  }, [setMode]);

  const handleToggleVerify = useCallback(
    () => persistSettings({ verify: !configRef.current.verify }),
    [persistSettings],
  );
  const handleToggleAutocommit = useCallback(
    () => persistSettings({ autocommit: !configRef.current.autocommit }),
    [persistSettings],
  );
  const handleCycleApproval = useCallback(() => {
    const order: ApprovalMode[] = ['off', 'dangerous', 'all'];
    const next = order[(order.indexOf(approvalGateRef.current.mode) + 1) % order.length];
    approvalGateRef.current = new ApprovalGate(
      next,
      parseApproveEnv(process.env.ASTROCODE_APPROVE),
    );
    approvalGateRef.current.setAsker(
      (req) =>
        new Promise<ApprovalDecision>((resolve) => {
          setPendingApproval({ command: req.command, resolve });
        }),
    );
    setApprovalMode(next);
    persistSettings({ approvalMode: next });
  }, [persistSettings]);
  const handleCycleTurns = useCallback(
    () =>
      persistSettings({
        maxToolTurns: cycleFrom(
          TURN_OPTIONS,
          configRef.current.maxToolTurns || 20,
        ),
      }),
    [cycleFrom, persistSettings],
  );
  const handleCycleBudget = useCallback(
    () =>
      persistSettings({
        budget: cycleFrom(BUDGET_OPTIONS, configRef.current.budget || 0),
      }),
    [cycleFrom, persistSettings],
  );

  // Mode-aware system prompt: plan mode encourages analysis-only behavior.
  // Includes project memory + repo map + the current task list so the model
  // always has project context (like CLAUDE.md / Aider's repo map).
  const buildSystemPrompt = useCallback((m: PlanMode) => {
    const parts: string[] = [configRef.current.systemPrompt];

    const mem = memoryRef.current || getMemoryText();
    if (mem) parts.push(`\n\n## Project memory\n${mem}`);

    const rm = repoMapRef.current || getRepoMap();
    if (rm) parts.push(`\n\n## Workspace map\n${rm}`);

    // Skills catalog (progressive disclosure: one line per skill; bodies load
    // on demand via use_skill).
    if (skillsLoaded.current) {
      const block = skillsPromptBlock();
      if (block) parts.push(block);
    }

    const todos = listTodos();
    if (todos.length > 0) {
      parts.push(`\n\n## Current task list\n${todos.map((t) => `[${t.status}] ${t.id}: ${t.text}`).join('\n')}`);
    }

    if (m === 'plan') {
      parts.push(
        `\n\nYou are currently in PLAN mode. Produce a clear, concise plan for the requested task before any implementation.`,
        `\nYou may ONLY use read-only tools (read_file, list_dir, search_files, git_status, git_diff, repomap, fetch_url) and the todo tool.`,
        `\nDo NOT attempt to write/edit files or run mutating commands — they are blocked.`,
        `\nEnd your reply with a numbered plan starting with "## Plan".`,
      );
    } else {
      parts.push(
        `\n\nYou are currently in ACT mode: you have full access to read, write, edit, and run commands. Implement the task.`,
        `\nIf the user earlier produced a plan, follow it.`,
      );
    }
    return parts.join('');
  }, []);

  // ---- animation loop for stars/spinner ----
  // Only repaint while something is actually moving (busy spinner, live
  // activity cards, banner twinkle). When idle the screen stays perfectly
  // still: this keeps native mouse selection stable (many terminals cancel
  // or fight an in-progress drag when the app redraws under the cursor) and
  // costs zero CPU. Streaming output re-renders per token on its own.
  const animating =
    busy ||
    itemsRef.current.some(
      (i) => i.kind === 'agent_activity' && i.active,
    );
  useEffect(() => {
    if (!animating) return;
    const t = setInterval(() => setTick((v) => v + 1), 160);
    return () => clearInterval(t);
  }, [animating]);

  // ---- welcome ----
  useEffect(() => {
    if (itemsRef.current.length > 0) return;
    const demoNotice = config.demo
      ? 'Running in DEMO mode — no API key set. Connect a real model via ASTROCODE_API_KEY / ASTROCODE_MODEL.'
      : `Connected to ${config.model}.`;
    pushItem({ kind: 'system', text: demoNotice });
    pushItem({
      kind: 'assistant',
      text:
        '## Welcome aboard, operator ✦\n\n' +
        'I can read, write, edit, and explore code, run commands, and map your repo — right from this terminal.\n\n' +
        '- Type **/** to browse commands · **/help** lists everything\n' +
        '- Press **Ctrl+K** to select & copy transcript text\n' +
        '- Use **/plan** to think it through, **/act** to build',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  /** Queue a prompt typed while the agent is mid-turn. */
  const enqueuePrompt = useCallback(
    (v: string) => {
      if (v.startsWith('/')) {
        pushItem({
          kind: 'system',
          text:
            "Slash commands can't be queued — this one needs the agent to be idle.\n" +
            'Info commands (/help, /cost, /status, /context, /mode, …) still run mid-turn.',
        });
        return;
      }
      if (v.startsWith('!')) {
        pushItem({ kind: 'system', text: "Shell commands (!cmd) can't be queued — run them when the agent is idle." });
        return;
      }
      queueRef.current.push(v);
      setQueue([...queueRef.current]);
      pushItem({ kind: 'system', text: `⏳ Queued — runs when the current turn finishes.` });
    },
    [pushItem],
  );

  // ---- agent ----
  const handleSubmit = useCallback(
    async (raw: string) => {
      const value = raw.trim();
      if (!value) return;
      setInput('');
      setHistory((h) => [...h, value].slice(-100));

      // While busy: informational slash commands (SLASH_SAFE_WHILE_BUSY) run
      // immediately — they only read state. Everything else waits: ordinary
      // prompts queue, and shell/slash input is refused with a visible reason
      // instead of being sent to the model as a plain message.
      if (busyRef.current) {
        const head = (value.split(/\s+/)[0] ?? '').toLowerCase();
        const safeMidTurn = value.startsWith('/') && SLASH_SAFE_WHILE_BUSY.has(head);
        if (!safeMidTurn) {
          enqueuePrompt(value);
          return;
        }
      }

      // `!cmd` shell passthrough: run it YOURSELF, no model involved. Output
      // goes to the transcript; the agent does not see it unless you ask.
      if (value.startsWith('!')) {
        const cmd = value.slice(1).trim();
        if (!cmd) {
          pushItem({ kind: 'system', text: 'Usage: !<command> — run a shell command yourself (agent not involved).' });
          return;
        }
        pushItem({ kind: 'user', text: value });
        pushItem({ kind: 'tool_start', name: 'bash', args: JSON.stringify({ command: cmd }) });
        const r = await runShell(cmd, { cwd, timeoutMs: 120_000 });
        pushItem({
          kind: r.ok ? 'tool_result' : 'error',
          name: 'bash',
          ok: r.ok,
          text: r.text,
        });
        return;
      }

      // Slash commands
      if (value.startsWith('/')) {
        const res = await runSlashCommand(value, {
          config: configRef.current,
          conversationLength: convRef.current.length,
          messages: convRef.current,
          setModel,
          mode: modeRef.current,
          sessionName,
          cwd,
          costUsd: costRef.current,
          tokens: tokensRef.current,
          contextTokens,
        });
        if (res.exit) {
          exit();
          return;
        }
        if (res.mode) {
          setMode(res.mode);
        }
        if (res.sessionName) {
          setSessionName(res.sessionName);
        }
        if (res.clear) {
          itemsRef.current = [];
          convRef.current = [];
          costRef.current = 0;
          tokensRef.current = 0;
          setCostUsd(0);
          setTokenCount(0);
          setContextTokens(0);
          clearTodos();
          clearAgentHistory();
          pushItem({ kind: 'system', text: 'Conversation cleared.' });
        }
        if (res.load) {
          const s = res.load;
          convRef.current = s.messages ?? [];
          itemsRef.current = [];
          // Rebuild a compact transcript of the loaded conversation.
          for (const m of s.messages ?? []) {
            if (m.role === 'user' && m.content) {
              pushItem({ kind: 'user', text: m.content });
            } else if (m.role === 'assistant' && m.content) {
              pushItem({ kind: 'assistant', text: m.content });
            }
          }
        }
        if (res.undo) {
          const r = await revertLast();
          pushItem({
            kind: r.ok ? 'tool_result' : 'error',
            name: 'undo',
            ok: r.ok,
            text: r.text,
          });
        }
        if (res.rewind) {
          const r = await rewindTurn();
          pushItem({
            kind: r.ok ? 'tool_result' : 'error',
            name: 'rewind',
            ok: r.ok,
            text: r.text,
          });
        }
        if (res.verify) {
          pushItem({ kind: 'system', text: 'Running project verification (lint/test)…' });
          const r = await runVerify(cwd);
          pushItem({
            kind: r.ok ? 'tool_result' : 'error',
            name: 'verify',
            ok: r.ok,
            text: r.text,
          });
        }
        if (res.autocommit) {
          const r = await autoCommit(cwd);
          pushItem({
            kind: r.ok ? 'tool_result' : 'error',
            name: 'commit',
            ok: r.ok,
            text: r.text,
          });
        }
        if (res.login) {
          setModal('login');
        }
        if (res.models) {
          setModal('models');
        }
        if (res.settings) {
          setModal('settings');
        }
        if (res.theme) {
          setModal('theme');
        }
        if (res.swarm) {
          await launchSwarmRef.current?.(res.swarm.goal, res.swarm.noPlan);
        }
        if (res.compact) {
          const before = convRef.current.length;
          const r: CompactResult = compactConversation(convRef.current);
          convRef.current = r.messages;
          const after = convRef.current.length;
          pushItem({
            kind: 'system',
            text: describeCompaction(r) + (before !== after ? ` (${before} → ${after} messages)` : ''),
          });
          const afterMessages: ChatMessage[] = [
            { role: 'system', content: buildSystemPrompt(modeRef.current) },
            ...convRef.current,
          ];
          setContextTokens(estimateContextTokens(afterMessages));
        }
        if (res.message) {
          pushItem({ kind: 'system', text: res.message });
        }
        return;
      }

      // Normal user turn
      pushItem({ kind: 'user', text: value });
      convRef.current.push({ role: 'user', content: value });
      await runAgentRef.current?.();
    },
    [pushItem, setModel, setModal, exit, runAgentRef, sessionName, cwd, contextTokens, setSessionName, enqueuePrompt],
  );

  /**
   * Run a swarm from /swarm: streams worker progress into an activity card,
   * then posts the merge summary. Needs a live provider (demo works).
   */
  const launchSwarm = useCallback(
    async (goal: string, noPlan: boolean) => {
      if (!providerRef.current) return;
      pushItem({ kind: 'system', text: `✦ Swarm: decomposing "${goal}"…` });
      const card: { kind: 'agent_activity'; workers: AgentWorker[]; active: boolean } = {
        kind: 'agent_activity',
        workers: [],
        active: true,
      };
      pushItem(card);
      const onEvent = (e: SwarmEvent) => {
        switch (e.type) {
          case 'plan': {
            for (const w of e.plan.workers) {
              card.workers.push({
                worker: card.workers.length + 1,
                role: w.role,
                task: w.task,
                tools: [],
                turns: 0,
                actions: 0,
                done: false,
              });
            }
            bump();
            break;
          }
          case 'worker_status': {
            const w = card.workers.find((x) => x.role === e.worker || x.task.includes(e.worker));
            if (w && (e.status === 'merged' || e.status === 'failed' || e.status === 'skipped')) {
              w.done = true;
              bump();
            }
            break;
          }
          case 'worker_tool': {
            const w = card.workers.find((x) => x.role === e.worker || x.task.includes(e.worker));
            if (w) {
              w.tools.push(e.tool);
              bump();
            }
            break;
          }
          case 'worker_done': {
            const w = card.workers.find((x) => x.role === e.worker || x.task.includes(e.worker));
            if (w) {
              w.done = true;
              w.turns = e.turns;
              w.actions = e.actions;
              bump();
            }
            break;
          }
          case 'merge_result':
          case 'swarm_done':
            break;
        }
      };
      try {
        const { executeTool: exec } = await import('../tools/registry.js');
        const r = await exec(
          'swarm',
          JSON.stringify({ goal, no_plan: noPlan }),
          {
            cwd,
            mode: 'act',
            provider: providerRef.current,
            onCharge: chargeRef.current,
            onSwarmEvent: onEvent,
          },
        );
        card.active = false;
        bump();
        pushItem({ kind: r.ok ? 'tool_result' : 'error', name: 'swarm', ok: r.ok, text: r.text });
      } catch (e: any) {
        card.active = false;
        bump();
        pushItem({ kind: 'error', text: `Swarm failed: ${e?.message ?? e}` });
      }
    },
    [cwd, pushItem, bump],
  );
  const launchSwarmRef = useRef<(goal: string, noPlan: boolean) => Promise<void>>();
  useEffect(() => {
    launchSwarmRef.current = launchSwarm;
  }, [launchSwarm]);

  const runAgent = useCallback(async () => {
    busyRef.current = true;
    setBusy(true);
    // Fresh abort controller per turn — Esc resolves it and interrupts the
    // provider stream + the tool loop (see the catch below).
    const abort = new AbortController();
    abortRef.current = abort;
    const signal = abort.signal;
    let turns = 0;
    let fixAttempts = 0;
    let firstCommandSeen = false;
    const maxTurns = configRef.current.maxToolTurns || 20;
    const maxFixAttempts = 2;
    const budget = configRef.current.budget || 0;
    const activeMode = modeRef.current;
    // One loop sensor per turn: repeated identical tool calls within this
    // turn are nudged (3rd) and blocked (6th) — see loopsensor.ts.
    const sensor = new LoopSensor();

    // Checkpoint: mark a turn boundary so /rewind can restore the whole
    // working tree from before this turn.
    markTurnBoundary();

    // Build messages with a mode-aware system prompt (includes memory, repo
    // map, and the current task list). Re-assigned per loop iteration below
    // so every request carries the latest conversation (incl. tool results).
    let messagesForAgent: ChatMessage[] = [
      { role: 'system' as const, content: buildSystemPrompt(activeMode) },
      ...convRef.current,
    ];

    // Live context-window meter: estimate tokens across all messages.
    const ctxTok = estimateContextTokens(messagesForAgent);
    setContextTokens(ctxTok);

    const charge = (
      inputText: string,
      outputText: string,
      usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number },
    ) => {
      // Real provider usage when reported; chars÷4 estimate otherwise.
      const delta = costFromUsage(configRef.current.model, usage, inputText.length, outputText.length);
      costRef.current += delta;
      tokensRef.current += usage?.outputTokens ?? estimateTokens(outputText);
      setCostUsd(costRef.current);
      setTokenCount(tokensRef.current);
    };

    try {
      while (turns < maxTurns) {
        // CRITICAL: rebuild the system prompt (and thus the message array sent
        // to the model) every iteration. Reusing messagesForAgent as a live
        // array was safe only for pushes — but the rebuilt arrays below (and
        // the stale snapshot in the first iteration) meant TOOL RESULTS never
        // made it into the next request. The model then re-called the same
        // tools forever or answered blind. Now each iteration carries the
        // fresh conversation including the tool results.
        messagesForAgent = [
          { role: 'system' as const, content: buildSystemPrompt(activeMode) },
          ...convRef.current,
        ];

        // Enforce the spend budget before each request.
        if (budget > 0 && costRef.current >= budget) {
          pushItem({
            kind: 'error',
            text: `⛔ Spend budget reached (${formatCost(costRef.current)} ≥ ${formatCost(budget)}).\nRaise ASTROCODE_BUDGET or use /clear to reset.`,
          });
          break;
        }

        turns++;
        const inputSnapshot = messagesForAgent
          .map((m) => m.content ?? (m.tool_calls ? JSON.stringify(m.tool_calls) : ''))
          .join('\n');
        let outputText = '';

        // AUTO-COMPACTION: when the conversation is pushing past ~85% of the
        // model's context window, compact BEFORE the next request —
        // otherwise the provider rejects (or silently truncates) and the
        // whole turn dies. Mechanical, not prompt-based (see compact.ts).
        const ctxLimit = contextLimitFor(configRef.current.model);
        const ctxUsed = estimateContextTokens(messagesForAgent);
        if (ctxUsed >= ctxLimit * 0.85) {
          const r = compactConversation(convRef.current);
          if (r.messages.length < convRef.current.length || r.charsAfter < r.charsBefore) {
            convRef.current = r.messages;
            pushItem({
              kind: 'system',
              text:
                `🗜 Auto-compacted at ${Math.round((ctxUsed / ctxLimit) * 100)}% of the context window — ` +
                describeCompaction(r),
            });
            messagesForAgent = [
              { role: 'system' as const, content: buildSystemPrompt(activeMode) },
              ...convRef.current,
            ];
          }
        }

        const result = await providerRef.current!.streamComplete({
          messages: messagesForAgent,
          tools: getToolSchemas(),
          signal,
          onToken: (frag: TokenFragment) => {
            if (frag.type === 'text' && frag.text) {
              const text = frag.text;
              outputText += text;
              const arr = itemsRef.current;
              const last = arr[arr.length - 1];
              if (last && last.kind === 'assistant') {
                last.text += text;
              } else {
                arr.push({ kind: 'assistant', text });
              }
              bump();
            }
          },
        });
        // Prefer the provider's real usage over the chars÷4 estimate.
        charge(inputSnapshot, outputText, result.usage);

        if (result.tool_calls && result.tool_calls.length > 0) {
          convRef.current.push({
            role: 'assistant',
            content: null,
            tool_calls: result.tool_calls,
          });
          for (const call of result.tool_calls) {
            // spawn_agent gets a live activity card instead of a static
            // tool_start line: workers, roles, and tool actions stream in.
            const isAgentSpawn = call.name === 'spawn_agent';
            let activityItem: { kind: 'agent_activity'; workers: AgentWorker[]; active: boolean } | null = null;
            if (isAgentSpawn) {
              activityItem = { kind: 'agent_activity', workers: [], active: true };
              pushItem(activityItem);
            } else {
              pushItem({ kind: 'tool_start', name: call.name, args: call.arguments });
            }

            // Plan mode: block mutating tools, keep read-only + planning ones.
            if (activeMode === 'plan' && !PLAN_ALLOWED_TOOLS.has(call.name)) {
              const blocked = {
                ok: false,
                text: `Blocked in PLAN mode: "${call.name}" is not a read-only tool.\nSwitch to ACT mode (/act) to make changes.`,
              };
              pushItem({ kind: 'tool_result', name: call.name, ok: false, text: blocked.text });
              convRef.current.push({
                role: 'tool',
                tool_call_id: call.id || 'plan_block',
                name: call.name,
                content: blocked.text,
              });
              continue;
            }

            // Orientation: on this turn's FIRST run_command, tell the agent
            // how to prove the project still works (Anthropic's "get up to
            // speed" pattern — the agent should baseline checks early).
            if (
              call.name === 'run_command' &&
              !firstCommandSeen &&
              activeMode !== 'plan'
            ) {
              firstCommandSeen = true;
              pushItem({
                kind: 'system',
                text: 'ℹ️ Turn orientation: consider running the project\'s checks (typecheck/lint/test) early to establish a baseline before making changes.',
              });
            }

            const res = await executeTool(call.name, call.arguments, {
              cwd,
              mode: activeMode,
              provider: providerRef.current!,
              onCharge: charge,
              loopSensor: sensor,
              approvalGate: approvalGateRef.current,
              onProgress: activityItem
                ? (e: ToolProgressEvent) => updateAgentActivity(activityItem!, e)
                : undefined,
            });
            // Safety net: settle the activity card even if the tool call
            // ended without a spawn_done event (e.g. handler threw).
            if (activityItem && activityItem.active) {
              activityItem.active = false;
              bump();
            }
            pushItem({
              kind: 'tool_result',
              name: call.name,
              ok: res.ok,
              text: res.text,
            });
            convRef.current.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.name,
              content: res.text,
            });
          }
          continue;
        }

        if (result.content) {
          convRef.current.push({ role: 'assistant', content: result.content });
        }

        // Self-healing verification: if the agent edited files this turn and
        // verify is on, run it; on failure feed the errors back and let the
        // agent fix them (bounded by maxFixAttempts).
        if (configRef.current.verify && changesSinceLastBoundary() > 0) {
          const v = await runVerify(cwd);
          if (!v.ok && fixAttempts < maxFixAttempts) {
            fixAttempts++;
            pushItem({
              kind: 'tool_result',
              name: 'verify',
              ok: false,
              text:
                `${v.text}\n\n` +
                `⤾ Verification failed — feeding errors back to the agent for auto-fix ` +
                `(attempt ${fixAttempts}/${maxFixAttempts}).`,
            });
            convRef.current.push({
              role: 'user',
              content:
                `Your changes did not pass verification. Fix ALL of the reported issues, ` +
                `then re-run the checks yourself until they pass.\n\n${v.text}`,
            });
            continue;
          }
          pushItem({ kind: v.ok ? 'tool_result' : 'error', name: 'verify', ok: v.ok, text: v.text });
        }
        break;
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        pushItem({ kind: 'system', text: '⏹ Turn interrupted (Esc). Type a follow-up or press Enter to continue.' });
      } else {
        pushItem({ kind: 'error', text: `Error: ${e?.message ?? e}` });
      }
    } finally {
      // Post-turn guardrails (Aider-style): if the agent edited files this
      // turn, optionally auto-commit the changes (verify now runs in-loop as
      // part of the self-healing flow above).
      const changed = changesSinceLastBoundary() > 0;
      if (changed && configRef.current.autocommit) {
        const c = await autoCommit(cwd);
        pushItem({
          kind: c.ok ? 'tool_result' : 'error',
          name: 'commit',
          ok: c.ok,
          text: c.text,
        });
      }
      // Refresh context estimate (turn added tokens) and the todo panel.
      const afterMessages: ChatMessage[] = [
        { role: 'system', content: buildSystemPrompt(activeMode) },
        ...convRef.current,
      ];
      setContextTokens(estimateContextTokens(afterMessages));
      setTodoVersion((v) => v + 1);
      busyRef.current = false;
      setBusy(false);
      abortRef.current = null;
      // Drain the queue: prompts typed while the agent ran run now, one at a
      // time (a queued prompt can itself turn busy, so one per drain).
      const next = queueRef.current.shift();
      if (next !== undefined) {
        setQueue([...queueRef.current]);
        pushItem({ kind: 'user', text: next });
        convRef.current.push({ role: 'user', content: next });
        void runAgentRef.current?.();
      }
    }
  }, [cwd, pushItem, bump, buildSystemPrompt, setModel]);
  runAgentRef.current = runAgent;


  const items = itemsRef.current;

  return (
    <Box flexDirection="column">
      <Box height={BANNER_H} flexDirection="column" justifyContent="flex-start">
        <Banner tick={tick} />
      </Box>

      <Box marginX={1} flexGrow={1}>
        <Box
          flexGrow={1}
          borderStyle="round"
          borderColor={theme.border}
          paddingX={1}
          paddingY={0}
          height={messageHeight}
        >
          <MessageArea
            items={items}
            height={messageHeight - 2}
            width={width - 2} // pane padding (paddingX=1 both sides)
            thinking={busy}
            scrollEnabled={!busy && input.length === 0}
            tick={tick}
            selMode={copyMode && !busy}
            onCopy={handleCopy}
            onCancelSel={() => setCopyMode(false)}
            inputPaused={modal !== null}
          />
        </Box>
      </Box>

      <Box marginX={1} marginBottom={0}>
        <Box flexDirection="column" width="100%">
          {todos.length > 0 && <TodoPanel todos={todos} maxRows={6} width={width - 4} />}
          {slashActive && (
            <SlashMenu matches={slashMatches} sel={sel} width={width} maxRows={slashRowCap} />
          )}
          {queue.length > 0 && (
            <Box paddingX={1}>
              <Text color={theme.thinking}>
                ⏳ {queue.length} queued prompt{queue.length === 1 ? '' : 's'}
              </Text>
            </Box>
          )}
          {pendingApproval && (
            <ApprovalPrompt
              command={pendingApproval.command}
              cwd={cwd}
              onDecision={handleApproval}
            />
          )}
          {copyMode && !busy ? (
            <Box marginTop={1} paddingX={1}>
              <Text color={theme.promptSymbol}>⬚ select mode — ↑/↓ move · Enter copy · Esc cancel</Text>
            </Box>
          ) : modal === null ? (
            <Box
              borderStyle="round"
              borderColor={mode === 'plan' ? theme.plan : theme.promptSymbol}
              paddingX={1}
              marginTop={slashActive ? 1 : 0}
            >
              <PromptInput
                value={input}
                onChange={setInput}
                onSubmit={handleSubmit}
                history={history}
                disabled={pendingApproval !== null}
                busy={busy}
                onAbort={() => abortRef.current?.abort()}
                placeholder="Ask AstroCode anything — / for commands"
                slashMatches={slashActive ? slashMatches : []}
                slashSel={sel}
                onSlashMove={moveSlash}
                onSlashDismiss={() => setSlashDismissed(true)}
                onCopyMode={() => {
                  if (!busy) setCopyMode(true);
                }}
              />
            </Box>
          ) : modal === 'login' ? (
            <LoginModal
              onComplete={handleLoginComplete}
              onCancel={() => setModal(null)}
              maxRows={PROVIDERS.length - 2}
            />
          ) : modal === 'models' ? (
            <ModelsModal
              provider={providerById(providerId)}
              current={model}
              maxRows={modelsCap}
              onSelect={handleModelSelect}
              onCancel={() => setModal(null)}
            />
          ) : modal === 'theme' ? (
            <ThemeModal
              current={themeName}
              maxRows={themeCap}
              onSelect={handleThemeSelect}
              onCancel={() => setModal(null)}
            />
          ) : (
            <SettingsMenu
              mode={mode}
              verify={configRef.current.verify}
              autocommit={configRef.current.autocommit}
              approvalMode={approvalMode}
              maxToolTurns={configRef.current.maxToolTurns}
              budget={configRef.current.budget}
              model={model}
              providerName={providerById(providerId).name}
              connected={connected}
              onCycleMode={handleCycleMode}
              onToggleVerify={handleToggleVerify}
              onToggleAutocommit={handleToggleAutocommit}
              onCycleApproval={handleCycleApproval}
              onCycleTurns={handleCycleTurns}
              onCycleBudget={handleCycleBudget}
              onPickModel={() => setModal('models')}
              onPickProvider={() => setModal('login')}
              onCancel={() => setModal(null)}
            />
          )}
        </Box>
      </Box>

      <Box marginY={0}>
        <StatusBar
          width={width}
          mode={connected ? 'live' : 'demo'}
          planMode={mode}
          model={model}
          cwd={cwd}
          busy={busy}
          tick={tick}
          tokenCount={tokenCount}
          costUsd={costUsd}
          budget={configRef.current.budget}
          gitBranch={gitBranch}
          sessionName={sessionName}
          contextTokens={contextTokens}
          contextLimit={contextLimit}
          todoTotal={todos.length}
          todoDone={todos.filter((t) => t.status === 'completed').length}
        />
      </Box>
    </Box>
  );
}


