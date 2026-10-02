import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from './theme.js';
import { scrollWindow } from './layout.js';
import { PROVIDERS } from '../providers.js';
import { listModels } from '../ai/openai.js';
import { backspaceAt, deleteWordBefore, insertAtCursor } from './inputEdit.js';

export interface LoginMeta {
  /** Base URL for the 'openai-compatible' provider. */
  baseUrl?: string;
  /** Model picked from the fetched list (or typed as a custom ID). */
  model?: string;
}

interface Props {
  /** Called with the chosen provider id + API key (+ base URL/model for the 'openai-compatible' flow). */
  onComplete: (providerId: string, apiKey: string, meta?: LoginMeta) => void;
  /** Called when the user cancels (Esc from the provider list). */
  onCancel: () => void;
  /**
   * Row budget for the list regions — the "↑/↓ n more…" notices come out of
   * it, so neither stage can outgrow the modal's reservation.
   */
  maxRows?: number;
}

const CUSTOM_MODEL_LABEL = '✎ Create custom model ID…';

/** One selectable row of the model-picker stage. */
type ModelRow = { label: string; kind: 'model' | 'custom' };

/** Truncate a long single-line status/error to keep the modal on one row. */
const ellipsize = (s: string, max = 90) =>
  s.length > max ? s.slice(0, max - 1) + '…' : s;

/**
 * The /login popup — an opencode-style staged screen:
 *   1. "Select a provider" — ↑/↓ highlight, Enter picks.
 *   2a. Regular providers: "Enter your API key" — type, Enter saves, Esc back.
 *   2b. 'OpenAI Compatible': Base URL → optional API key → live model list
 *       fetched from GET <baseUrl>/models, with a trailing "Create custom
 *       model ID" entry for endpoints that don't expose the list.
 * Rendered in place of the prompt while open; the prompt input is disabled.
 */
export function LoginModal({ onComplete, onCancel, maxRows }: Props) {
  const [stage, setStage] = useState<
    'providers' | 'baseurl' | 'key' | 'models' | 'custom-model'
  >('providers');
  const [sel, setSel] = useState(0);
  const [baseUrlText, setBaseUrlText] = useState('');
  const [urlError, setUrlError] = useState('');
  const [keyText, setKeyText] = useState('');
  const [customModelText, setCustomModelText] = useState('');
  const [modelSel, setModelSel] = useState(0);
  const [modelState, setModelState] = useState<{
    loading: boolean;
    models: string[];
    error?: string;
  }>({ loading: false, models: [] });

  const isCustom = PROVIDERS[sel]?.id === 'openai-compatible';
  const provider = PROVIDERS[sel];

  // Fetch the model list when the flow reaches the picker stage. One live
  // request per entry; an 'alive' flag ignores stale results after Esc.
  useEffect(() => {
    if (stage !== 'models') return;
    let alive = true;
    setModelState({ loading: true, models: [] });
    setModelSel(0);
    listModels(baseUrlText, keyText).then((r) => {
      if (alive) setModelState({ loading: false, models: r.models, error: r.error });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const modelRows: ModelRow[] = [
    ...modelState.models.map((m) => ({ label: m, kind: 'model' as const })),
    { label: CUSTOM_MODEL_LABEL, kind: 'custom' as const },
  ];

  /**
   * Text-input key handling shared by the base-URL / key / model stages.
   * These fields are append-only from the caret's perspective (the caret
   * always sits at the end), but backspace must still respect Ink's dual
   * backspace encodings (\b → key.backspace, DEL → key.delete) and filter
   * control characters out so pasted/stray bytes can't corrupt the value.
   */
  const handleTextInput = (
    input: string,
    key: { backspace?: boolean; delete?: boolean; ctrl?: boolean; escape?: boolean },
    value: string,
    setValue: (v: string) => void,
  ): boolean => {
    const isBackspace =
      key.backspace || key.delete || input === '\u007f' || input === '\u0008';
    if (isBackspace) {
      if (key.ctrl) {
        const r = deleteWordBefore(value, value.length);
        setValue(r ? r.value : value);
        return true;
      }
      const r = backspaceAt(value, value.length);
      setValue(r ? r.value : value);
      return true;
    }
    if (key.ctrl && input.toLowerCase() === 'u') {
      setValue('');
      return true;
    }
    if (input.length > 0 && !key.ctrl) {
      // Pastes arrive as one multi-char event; single keys go through the
      // printable filter in insertAtCursor.
      const ins = insertAtCursor(value, value.length, input);
      if (ins) {
        setValue(ins.value);
        return true;
      }
    }
    return false;
  };

  useInput(
    (input, key) => {
      if (stage === 'providers') {
        if (key.upArrow) {
          setSel((s) => (s - 1 + PROVIDERS.length) % PROVIDERS.length);
          return;
        }
        if (key.downArrow) {
          setSel((s) => (s + 1) % PROVIDERS.length);
          return;
        }
        if (key.return) {
          setUrlError('');
          setKeyText('');
          setStage(PROVIDERS[sel].id === 'openai-compatible' ? 'baseurl' : 'key');
          return;
        }
        if (key.escape) {
          onCancel();
          return;
        }
        return;
      }

      if (stage === 'baseurl') {
        if (key.escape) {
          setStage('providers');
          return;
        }
        if (key.return) {
          const clean = baseUrlText.trim().replace(/\/+$/, '');
          if (!/^https?:\/\//i.test(clean)) {
            setUrlError('Base URL must start with http:// or https:// — e.g. http://localhost:11434/v1');
            return;
          }
          setBaseUrlText(clean);
          setUrlError('');
          setKeyText('');
          setStage('key');
          return;
        }
        handleTextInput(input, key, baseUrlText, setBaseUrlText);
        return;
      }

      if (stage === 'key') {
        if (key.escape) {
          setStage(isCustom ? 'baseurl' : 'providers');
          return;
        }
        if (key.return) {
          const v = keyText.trim();
          // The custom flow treats the key as optional (local endpoints).
          if (v || isCustom) {
            setStage('models');
          }
          return;
        }
        handleTextInput(input, key, keyText, setKeyText);
        return;
      }

      if (stage === 'models') {
        const rows = modelRows;
        if (key.escape) {
          setStage('key');
          return;
        }
        if (rows.length === 0 || modelState.loading) return;
        if (key.upArrow) {
          setModelSel((s) => (s - 1 + rows.length) % rows.length);
          return;
        }
        if (key.downArrow) {
          setModelSel((s) => (s + 1) % rows.length);
          return;
        }
        if (key.return) {
          const row = rows[modelSel];
          if (!row) return;
          if (row.kind === 'custom') {
            setCustomModelText('');
            setStage('custom-model');
          } else {
            onComplete(provider.id, keyText.trim(), {
              baseUrl: baseUrlText,
              model: row.label,
            });
          }
          return;
        }
        // Type-ahead among the fetched models (not the custom entry).
        if (input.length > 0 && input.charCodeAt(0) >= 32) {
          const ch = input.toLowerCase();
          const idx = modelState.models.findIndex((m) => m.toLowerCase().startsWith(ch));
          if (idx >= 0) setModelSel(idx);
        }
        return;
      }

      // ---- custom model ID entry ----
      if (key.escape) {
        setStage('models');
        return;
      }
      if (key.return) {
        const v = customModelText.trim();
        if (v) {
          onComplete(provider.id, keyText.trim(), {
            baseUrl: baseUrlText,
            model: v,
          });
        }
        return;
      }
      handleTextInput(input, key, customModelText, setCustomModelText);
    },
    { isActive: true },
  );

  if (stage === 'providers') {
    // Same scroll window as the model list: maxRows is the whole row budget
    // (notices included), so this stage can never render taller than the
    // height App reserved for the modal.
    const win = scrollWindow(PROVIDERS.length, sel, maxRows ?? PROVIDERS.length);
    const { count, start, hasMoreUp, hasMoreDown } = win;
    const visible = PROVIDERS.slice(start, start + count);
    return (
      <Box borderStyle="double" borderColor={theme.promptSymbol} paddingX={1} flexDirection="column">
        <Text color={theme.title} bold>
          🔐 Connect a provider
        </Text>
        <Text color={theme.muted} dimColor>
          Pick where your model lives — your API key is stored locally in ~/.astrocode/config.json.
        </Text>
        {hasMoreUp && <Text color={theme.muted}>↑ {start} more…</Text>}
        <Box flexDirection="column">
          {visible.map((p, i) => {
            const active = start + i === sel;
            return (
              <Box key={p.id} flexDirection="row">
                <Text color={active ? theme.promptSymbol : theme.muted} bold={active}>
                  {active ? '❯' : ' '}
                </Text>
                <Text color={active ? theme.prompt : theme.muted} bold={active}>
                  {' '}
                  {p.name}
                </Text>
                <Text color={theme.muted}>  —  {p.tagline}</Text>
              </Box>
            );
          })}
        </Box>
        {hasMoreDown && (
          <Text color={theme.muted}>↓ {PROVIDERS.length - start - count} more…</Text>
        )}
        <Text color={theme.muted}>↑↓ navigate · Enter select · Esc cancel</Text>
      </Box>
    );
  }

  if (stage === 'baseurl') {
    return (
      <Box borderStyle="double" borderColor={theme.promptSymbol} paddingX={1} flexDirection="column">
        <Text color={theme.title} bold>
          🔌 OpenAI Compatible — base URL
        </Text>
        {urlError ? (
          <Text color={theme.toolFail}>{ellipsize(urlError)}</Text>
        ) : (
          <Text color={theme.muted} dimColor>
            e.g. https://api.openai.com/v1 · http://localhost:11434/v1 · http://localhost:1234/v1
          </Text>
        )}
        <Box flexDirection="row">
          <Text color={theme.promptSymbol} bold>❯ </Text>
          {baseUrlText.length === 0 ? (
            <Text dimColor>https://your-endpoint/v1</Text>
          ) : (
            <Text color={theme.prompt}>
              {baseUrlText.slice(0, -1)}
              <Text inverse color={theme.prompt}>
                {baseUrlText.slice(-1) || ' '}
              </Text>
            </Text>
          )}
        </Box>
        <Text color={theme.muted}>Enter continue · Esc back to providers</Text>
      </Box>
    );
  }

  if (stage === 'models') {
    const win = scrollWindow(modelRows.length, modelSel, maxRows ?? 8);
    const { count, start, hasMoreUp, hasMoreDown } = win;
    const visible = modelRows.slice(start, start + count);
    return (
      <Box borderStyle="double" borderColor={theme.promptSymbol} paddingX={1} flexDirection="column">
        <Text color={theme.title} bold>
          🚀 Choose a model — {baseUrlText}
        </Text>
        {modelState.loading ? (
          <Text color={theme.thinking}>◌ fetching models from {baseUrlText}/models …</Text>
        ) : modelState.error ? (
          <Text color={theme.toolFail}>{ellipsize(modelState.error)}</Text>
        ) : (
          <Text color={theme.muted} dimColor>
            {modelState.models.length} models found — pick one, or create a custom model ID.
          </Text>
        )}
        {!modelState.loading && (
          <>
            {hasMoreUp && <Text color={theme.muted}>↑ {start} more…</Text>}
            <Box flexDirection="column">
              {visible.map((row, i) => {
                const active = start + i === modelSel;
                return (
                  <Box key={`${row.kind}:${row.label}`} flexDirection="row">
                    <Text color={active ? theme.promptSymbol : theme.muted} bold={active}>
                      {active ? '❯' : ' '}
                    </Text>
                    <Text
                      color={row.kind === 'custom' ? theme.title : active ? theme.prompt : theme.muted}
                      bold={active}
                    >
                      {' '}
                      {row.label}
                    </Text>
                  </Box>
                );
              })}
            </Box>
            {hasMoreDown && (
              <Text color={theme.muted}>↓ {modelRows.length - start - count} more…</Text>
            )}
          </>
        )}
        <Text color={theme.muted}>↑↓ navigate · Enter select · Esc back</Text>
      </Box>
    );
  }

  if (stage === 'custom-model') {
    return (
      <Box borderStyle="double" borderColor={theme.promptSymbol} paddingX={1} flexDirection="column">
        <Text color={theme.title} bold>
          ✎ Custom model ID
        </Text>
        <Text color={theme.muted} dimColor>
          Type the model ID exactly as your endpoint expects it (sent as the `model` field).
        </Text>
        <Box flexDirection="row">
          <Text color={theme.promptSymbol} bold>❯ </Text>
          {customModelText.length === 0 ? (
            <Text dimColor>e.g. llama3.1:70b · my-model@latest</Text>
          ) : (
            <Text color={theme.prompt}>
              {customModelText.slice(0, -1)}
              <Text inverse color={theme.prompt}>
                {customModelText.slice(-1) || ' '}
              </Text>
            </Text>
          )}
        </Box>
        <Text color={theme.muted}>Enter connect · Esc back to models</Text>
      </Box>
    );
  }

  // ---- API-key stage (regular providers: required · custom: optional) ----
  const shown = keyText;
  return (
    <Box borderStyle="double" borderColor={theme.promptSymbol} paddingX={1} flexDirection="column">
      <Text color={theme.title} bold>
        🔑 {provider.name} API key
      </Text>
      <Text color={theme.muted} dimColor>
        {isCustom
          ? `Key for ${baseUrlText} — press Enter to skip for keyless endpoints (Ollama, LM Studio…).`
          : `Connect to ${provider.name} — ${provider.baseUrl}. The key is stored locally, never sent anywhere else.`}
      </Text>
      <Box flexDirection="row">
        <Text color={theme.promptSymbol} bold>❯ </Text>
        {shown.length === 0 ? (
          <Text dimColor>{isCustom ? 'sk-… (optional — Enter to skip)' : `paste your ${provider.name} API key here…`}</Text>
        ) : (
          <Text color={theme.prompt}>
            {shown.slice(0, -1)}
            <Text inverse color={theme.prompt}>
              {shown.slice(-1) || ' '}
            </Text>
          </Text>
        )}
      </Box>
      <Text color={theme.muted}>
        {isCustom ? 'Enter continue · Esc back to base URL' : 'Enter save · Esc back to providers'}
      </Text>
    </Box>
  );
}
