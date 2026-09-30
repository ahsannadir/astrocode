import React from 'react';
import { Box, Text } from 'ink';
import { theme, spinnerFrames } from './theme.js';
import type { PlanMode } from '../types.js';
import { formatCost } from '../cost.js';

interface Props {
  mode: 'demo' | 'live';
  planMode: PlanMode;
  model: string;
  cwd: string;
  busy: boolean;
  tick: number;
  tokenCount: number;
  costUsd: number;
  budget: number;
  gitBranch: string;
  sessionName: string;
  /** Estimated tokens used in the context window. */
  contextTokens: number;
  /** Context-window size (in tokens) for the active model. */
  contextLimit: number;
  /** Total tasks in the live task list. */
  todoTotal: number;
  /** Completed tasks in the live task list. */
  todoDone: number;
  /** Terminal width, so the bar can shed details instead of wrapping. */
  width: number;
}

function contextColor(pct: number): string {
  if (pct >= 80) return 'red';
  if (pct >= 50) return 'yellow';
  return 'green';
}

/** A tiny meter: ▰ used, ▱ free. `cells` bounds its width (0 = hide). */
function contextMeter(pct: number, cells: number): string {
  if (cells <= 0) return '';
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * cells);
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled);
}

/** One styled span of a status segment. */
interface Piece {
  text: string;
  color: string;
  bold?: boolean;
}
/** A segment = one logical item; pieces render back-to-back within it. */
type Segment = Piece[];

const SEP = '  ·  ';

export function StatusBar({
  mode,
  planMode,
  model,
  cwd,
  busy,
  tick,
  tokenCount,
  costUsd,
  budget,
  gitBranch,
  sessionName,
  contextTokens,
  contextLimit,
  todoTotal,
  todoDone,
  width,
}: Props) {
  const spin = spinnerFrames[tick % spinnerFrames.length];
  const avail = Math.max(24, width - 4); // rounded border + paddingX on both sides
  const overBudget = budget > 0 && costUsd > budget;
  const ctxPct = contextLimit > 0 ? Math.min(100, (contextTokens / contextLimit) * 100) : 0;
  const ctxColor = contextColor(ctxPct);
  const modeColor = planMode === 'plan' ? theme.plan : theme.status;

  // Progressive refinement: start with every detail shown, then shed the
  // lowest-priority ones until the three groups fit on a single line at this
  // terminal width (the layout reserves exactly 3 rows for this bar).
  let cwdMax = 36;
  let meterCells = 5;
  let modelMax = 30;
  let showSession = true;
  let showTok = true;
  let showTodo = true;
  let showSpendLabel = true;
  let showModelLabel = true;
  let showBranch = true;
  let showModeSuffix = true;

  const shrinkSteps: Array<() => void> = [
    () => (showSession = false),
    () => (showTok = false),
    () => (showTodo = false),
    () => (modelMax = 14),
    () => (cwdMax = 24),
    () => (meterCells = 3),
    () => (cwdMax = 14),
    () => (showSpendLabel = false),
    () => (showModelLabel = false),
    () => (showModeSuffix = false),
    () => (cwdMax = 8),
    () => (showBranch = false),
    () => (meterCells = 0),
  ];

  const trunc = (s: string, max: number) =>
    s.length > max ? '…' + s.slice(-(max - 1)) : s;

  const measure = () => {
    const shownCwd = trunc(cwd, cwdMax);
    const shownModel = model.length > modelMax ? model.slice(0, modelMax - 1) + '…' : model;
    const modeLabel =
      (planMode === 'plan' ? '◇ plan' : '◆ act') +
      (showModeSuffix ? `·${mode}` : '');
    const ctxText =
      `ctx ` +
      (meterCells > 0 ? `${contextMeter(ctxPct, meterCells)} ` : '') +
      `${ctxPct.toFixed(0)}%`;

    const left: Segment[] = [
      [{ text: busy ? `${spin} working` : '● ready', color: busy ? theme.status : theme.toolOk }],
      [{ text: modeLabel, color: modeColor, bold: true }],
      [
        ...(showModelLabel ? [{ text: 'model ', color: theme.muted } as Piece] : []),
        { text: shownModel, color: theme.assistant },
      ],
    ];
    const mid: Segment[] = [];
    if (showTodo && todoTotal > 0) {
      mid.push([
        { text: '✓ ', color: theme.muted },
        { text: `${todoDone}/${todoTotal}`, color: theme.toolOk },
      ]);
    }
    mid.push([{ text: ctxText, color: ctxColor }]);
    if (showTok) {
      mid.push([
        { text: 'tok ', color: theme.muted },
        { text: String(tokenCount), color: theme.assistant },
      ]);
    }
    mid.push([
      {
        text: overBudget ? '⛔ ' : showSpendLabel ? 'spend ' : '',
        color: overBudget ? theme.toolFail : theme.muted,
      },
      { text: formatCost(costUsd), color: overBudget ? theme.toolFail : theme.status },
    ]);
    const right: Segment[] = [];
    if (showBranch && gitBranch) {
      right.push([
        { text: '⎇ ', color: theme.muted },
        { text: gitBranch, color: theme.prompt },
      ]);
    }
    if (showSession) right.push([{ text: sessionName, color: theme.muted }]);
    right.push([{ text: shownCwd, color: theme.muted }]);
    return { left, mid, right };
  };

  const groupLen = (g: Segment[]) =>
    g.reduce(
      (n, seg) => n + seg.reduce((m, p) => m + p.text.length, 0),
      g.length > 0 ? 5 * (g.length - 1) : 0,
    );

  let groups = measure();
  for (const step of shrinkSteps) {
    const total = groupLen(groups.left) + groupLen(groups.mid) + groupLen(groups.right);
    // Keep room for the space-between gaps so groups never touch.
    if (total + 6 <= avail) break;
    step();
    groups = measure();
  }

  const renderGroup = (g: Segment[], key: string) => (
    <Box key={key}>
      {g.map((seg, i) => (
        <React.Fragment key={i}>
          {i > 0 && <Text color={theme.muted}>{SEP}</Text>}
          {seg.map((p, j) => (
            <Text key={j} color={p.color} bold={p.bold}>
              {p.text}
            </Text>
          ))}
        </React.Fragment>
      ))}
    </Box>
  );

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      justifyContent="space-between"
      width="100%"
    >
      {renderGroup(groups.left, 'left')}
      {renderGroup(groups.mid, 'mid')}
      {renderGroup(groups.right, 'right')}
    </Box>
  );
}
