import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from './theme.js';
import { scrollWindow } from './layout.js';
import type { ProviderInfo } from '../providers.js';

interface Props {
  provider: ProviderInfo;
  /** The currently active model (gets a ✓ marker). */
  current: string;
  /**
   * Row budget for the list region — the "↑/↓ n more…" notices come out of
   * it, so the popup never outgrows its reservation (terminal-height aware).
   */
  maxRows: number;
  /** Called with the selected model id when the user confirms. */
  onSelect: (model: string) => void;
  onCancel: () => void;
}

/**
 * The /models popup — an opencode-style list of the connected provider's
 * models. ↑/↓ highlight (scrolling through long lists), Enter picks, Esc
 * cancels. The active model is marked ✓; free models (:free / -free suffix)
 * get a $0 tag.
 */
export function ModelsModal({ provider, current, maxRows, onSelect, onCancel }: Props) {
  const models = provider.models;
  const [sel, setSel] = useState(() => {
    const idx = models.indexOf(current);
    return idx >= 0 ? idx : 0;
  });

  useInput(
    (input, key) => {
      if (models.length === 0) return;
      if (key.upArrow) {
        setSel((s) => (s - 1 + models.length) % models.length);
        return;
      }
      if (key.downArrow) {
        setSel((s) => (s + 1) % models.length);
        return;
      }
      if (key.return) {
        onSelect(models[sel]);
        return;
      }
      if (key.escape) {
        onCancel();
        return;
      }
      // Type-ahead: jump to the first model starting with the typed char.
      // Single printable characters only — multi-char input is a paste or an
      // escape sequence fragment, never a navigation keystroke.
      if (input.length === 1 && input.charCodeAt(0) >= 32) {
        const ch = input.toLowerCase();
        const idx = models.findIndex((m) => m.toLowerCase().startsWith(ch));
        if (idx >= 0) setSel(idx);
      }
    },
    { isActive: true },
  );

  // Scroll window: keep the selection centered within maxRows so long model
  // lists (e.g. OpenRouter's free + paid set) stay fully navigable. maxRows
  // covers the "↑/↓ n more…" notices too, so a trimmed list can never render
  // taller than the height App reserved for this popup.
  const win = scrollWindow(models.length, sel, maxRows);
  const { count, start, hasMoreUp, hasMoreDown } = win;
  const visible = models.slice(start, start + count);

  return (
    <Box borderStyle="double" borderColor={theme.promptSymbol} paddingX={1} flexDirection="column">
      <Text color={theme.title} bold>
        🚀 Select a model — {provider.name}
      </Text>
      {hasMoreUp && (
        <Text color={theme.muted}>↑ {start} more…</Text>
      )}
      <Box flexDirection="column">
        {visible.map((m, i) => {
          const active = start + i === sel;
          const isCurrent = m === current;
          return (
            <Box key={m} flexDirection="row">
              <Text color={active ? theme.promptSymbol : theme.muted} bold={active}>
                {active ? '❯' : ' '}
              </Text>
              <Text color={active ? theme.prompt : theme.muted} bold={active}>
                {' '}
                {m}
              </Text>
              {isCurrent ? (
                <Text color={theme.toolOk}>  ✓ active</Text>
              ) : (
                m.endsWith(':free') || m.endsWith('-free') || m === 'openrouter/free' ? (
                  <Text color={theme.toolOk}>  $0</Text>
                ) : null
              )}
            </Box>
          );
        })}
      </Box>
      {hasMoreDown && (
        <Text color={theme.muted}>↓ {models.length - start - count} more…</Text>
      )}
      <Text color={theme.muted}>↑↓ navigate · Enter select · Esc cancel</Text>
    </Box>
  );
}
