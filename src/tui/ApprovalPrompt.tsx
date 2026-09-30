import React from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from './theme.js';

/**
 * Shell-approval prompt: shown while the agent waits for a run_command
 * decision. Keys: y = run once, a = always (this session, by prefix),
 * n/Esc = deny. The agent's loop is blocked until a decision lands — that's
 * the point: no shell command runs without the user seeing it first (in
 * 'dangerous' or 'all' approval modes).
 */
export function ApprovalPrompt({
  command,
  cwd,
  onDecision,
}: {
  command: string;
  cwd: string;
  onDecision: (d: 'approved' | 'denied' | 'always') => void;
}) {
  useInput(
    (input, key) => {
      const k = input.toLowerCase();
      if (k === 'y' || key.return) onDecision('approved');
      else if (k === 'a') onDecision('always');
      else if (k === 'n' || key.escape) onDecision('denied');
    },
    { isActive: true },
  );

  const first = command.trim().split(/\s+/).slice(0, 2).join(' ');

  return (
    <Box borderStyle="round" borderColor={theme.plan} paddingX={1} flexDirection="column">
      <Text color={theme.title} bold>
        ⛔ Run command?
      </Text>
      <Box flexDirection="column" paddingX={2}>
        <Text color={theme.prompt}>$ {command}</Text>
        <Text dimColor>in {cwd}</Text>
      </Box>
      <Text color={theme.muted}>
        y run once · a always allow "{first}" · n/Esc deny
      </Text>
    </Box>
  );
}
