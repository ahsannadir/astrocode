import React from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { theme } from './theme.js';

/**
 * Shell-approval prompt: shown while the agent waits for a run_command
 * decision. Keys: y = run once, a = always (this session, by prefix),
 * n/Esc = deny. The agent's loop is blocked until a decision lands — that's
 * the point: no shell command runs without the user seeing it first (in
 * 'dangerous' or 'all' approval modes). Every row is truncated to the terminal
 * width so the panel keeps the exact height App reserves for it.
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
  // Keep this panel at the reserved APPROVAL_H: a long command (or a deep cwd)
  // must be truncated, never wrapped, or the box grows past its rows.
  const { stdout } = useStdout();
  // marginX(2) + borders(2) + paddingX(2) + inner paddingX(2) + "$ "(2).
  const room = Math.max(24, (stdout?.columns ?? 80) - 10);
  const line = (s: string) => (s.length > room ? `${s.slice(0, room - 1)}…` : s);

  return (
    <Box borderStyle="round" borderColor={theme.plan} paddingX={1} flexDirection="column">
      <Text color={theme.title} bold>
        ⛔ Run command?
      </Text>
      <Box flexDirection="column" paddingX={2}>
        <Text color={theme.prompt}>{line(`$ ${command}`)}</Text>
        <Text dimColor>{line(`in ${cwd}`)}</Text>
      </Box>
      <Text color={theme.muted}>
        {line(`y run once · a always allow "${first}" · n/Esc deny`)}
      </Text>
    </Box>
  );
}
