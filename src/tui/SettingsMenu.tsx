import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from './theme.js';
import { scrollWindow } from './layout.js';
import type { PlanMode } from '../types.js';
import type { ApprovalMode } from '../approval.js';

interface Props {
  /**
   * Row budget for the option list — the "↑/↓ n more…" notices come out of
   * it, so the popup never outgrows its reservation (terminal-height aware).
   */
  maxRows?: number;
  mode: PlanMode;
  verify: boolean;
  autocommit: boolean;
  approvalMode: ApprovalMode;
  maxToolTurns: number;
  budget: number;
  model: string;
  providerName: string;
  connected: boolean;
  onCycleMode: () => void;
  onToggleVerify: () => void;
  onToggleAutocommit: () => void;
  /** Cycle shell-approval mode: off → dangerous → all → off. */
  onCycleApproval: () => void;
  onCycleTurns: () => void;
  onCycleBudget: () => void;
  /** Close settings and open the model picker. */
  onPickModel: () => void;
  /** Close settings and open the provider login. */
  onPickProvider: () => void;
  onCancel: () => void;
}

interface Row {
  label: string;
  value: string;
  kind: 'toggle' | 'cycle' | 'action';
  run: () => void;
}

const short = (s: string) => (s.length > 44 ? `${s.slice(0, 41)}…` : s);

/**
 * The /settings popup — an opencode-style menu of toggle/cycle rows plus
 * shortcuts to the model & provider pickers. Enter/←/→ activate the
 * highlighted row; changes apply immediately and persist on disk.
 */
export function SettingsMenu({
  maxRows,
  mode,
  verify,
  autocommit,
  approvalMode,
  maxToolTurns,
  budget,
  model,
  providerName,
  connected,
  onCycleMode,
  onToggleVerify,
  onToggleAutocommit,
  onCycleApproval,
  onCycleTurns,
  onCycleBudget,
  onPickModel,
  onPickProvider,
  onCancel,
}: Props) {
  const rows: Row[] = [
    {
      label: 'Interaction mode',
      value: mode === 'plan' ? 'plan (read-only)' : 'act (full access)',
      kind: 'cycle',
      run: onCycleMode,
    },
    {
      label: 'Shell approval',
      value:
        approvalMode === 'all'
          ? 'every command'
          : approvalMode === 'dangerous'
            ? 'risky commands'
            : 'off',
      kind: 'cycle',
      run: onCycleApproval,
    },
    {
      label: 'Verify on edits',
      value: verify ? 'on' : 'off',
      kind: 'toggle',
      run: onToggleVerify,
    },
    {
      label: 'Auto-commit changes',
      value: autocommit ? 'on' : 'off',
      kind: 'toggle',
      run: onToggleAutocommit,
    },
    {
      label: 'Max tool turns',
      value: `${maxToolTurns}`,
      kind: 'cycle',
      run: onCycleTurns,
    },
    {
      label: 'Spend budget',
      value: budget > 0 ? `$${budget.toFixed(2)}` : 'unlimited',
      kind: 'cycle',
      run: onCycleBudget,
    },
    {
      label: 'Model',
      value: short(model),
      kind: 'action',
      run: onPickModel,
    },
    {
      label: 'Provider',
      value: connected ? short(providerName) : 'not connected — /login',
      kind: 'action',
      run: onPickProvider,
    },
  ];

  const [sel, setSel] = useState(0);
  // Window the option list against the height budget, same as the model and
  // theme pickers. A hardcoded full-height list was one of the ways a frame
  // reached stdout.rows and tripped Ink's direct-write path on Esc.
  const win = scrollWindow(rows.length, sel, maxRows ?? rows.length);
  const { count, start, hasMoreUp, hasMoreDown } = win;
  const visible = rows.slice(start, start + count);

  useInput(
    (input, key) => {
      // Home/End move the highlight to the first/last row (Ink reports the
      // CSI H / CSI F sequences as raw input, not named keys).
      if (input === '[H' || input === 'OH') {
        setSel(0);
        return;
      }
      if (input === '[F' || input === 'OF') {
        setSel(rows.length - 1);
        return;
      }
      if (key.upArrow) {
        setSel((s) => (s - 1 + rows.length) % rows.length);
        return;
      }
      if (key.downArrow) {
        setSel((s) => (s + 1) % rows.length);
        return;
      }
      if (key.leftArrow || key.rightArrow || key.return) {
        rows[sel].run();
        return;
      }
      if (key.escape) {
        onCancel();
        return;
      }
    },
    { isActive: true },
  );

  return (
    <Box borderStyle="double" borderColor={theme.promptSymbol} paddingX={1} flexDirection="column">
      <Text color={theme.title} bold>
        ⚙ Settings
      </Text>
      {hasMoreUp && <Text color={theme.muted}>↑ {start} more…</Text>}
      <Box flexDirection="column">
        {visible.map((r, i) => {
          const idx = start + i;
          const active = idx === sel;
          const valueColor =
            r.kind === 'toggle'
              ? r.value === 'on'
                ? theme.toolOk
                : theme.muted
              : r.kind === 'action'
                ? theme.prompt
                : theme.status;
          return (
            <Box key={r.label} flexDirection="row">
              <Text color={active ? theme.promptSymbol : theme.muted} bold={active}>
                {active ? '❯' : ' '}
              </Text>
              <Text color={active ? theme.prompt : theme.muted} bold={active}>
                {' '}
                {r.label}
              </Text>
              <Box flexGrow={1} />
              <Text color={valueColor} bold={active && r.kind !== 'action'}>
                {r.value}
              </Text>
            </Box>
          );
        })}
      </Box>
      {hasMoreDown && (
        <Text color={theme.muted}>↓ {rows.length - start - count} more…</Text>
      )}
      <Text color={theme.muted}>
        ↑↓ navigate · Enter/←/→ change · Esc close
      </Text>
    </Box>
  );
}
