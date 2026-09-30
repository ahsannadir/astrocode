/**
 * Clipboard support for AstroCode.
 *
 * Strategy: first try the terminal-native OSC 52 escape sequence
 * (ESC ] 52 ; c ; base64(text) BEL), which works in kitty, alacritty,
 * wezterm, ghostty, iTerm2, and tmux with `set-clipboard on`. Then fall
 * back to a platform clipboard command (wl-copy / xclip / xsel / pbcopy /
 * clip) for terminals that don't support OSC 52.
 */
import { spawn } from 'node:child_process';

export type CopyResult = 'osc52' | 'command' | 'failed';

const PLATFORM_CMDS: Record<string, string[]> = {
  linux: ['wl-copy', 'xclip -selection clipboard', 'xsel --clipboard --input'],
  darwin: ['pbcopy'],
  win32: ['clip'],
};

/** Push text into the system clipboard. Best-effort, never throws. */
export function copyToClipboard(text: string): CopyResult {
  if (!text) return 'failed';

  // 1) Terminal-native OSC 52 (works over SSH, no external tools needed).
  // Most modern terminals (kitty, alacritty, wezterm, ghostty, iTerm2, tmux
  // with set-clipboard) handle it, so on success we're done.
  try {
    const payload = Buffer.from(text, 'utf8').toString('base64');
    process.stdout.write(`\x1b]52;c;${payload}\x07`);
    return 'osc52';
  } catch {
    /* fall through to a platform command */
  }

  // 2) Platform command fallback for terminals without OSC 52 support.
  const cmds = PLATFORM_CMDS[process.platform] ?? [];
  for (const c of cmds) {
    try {
      const child = spawn(c, { shell: true, stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => {
        /* command not found — try the next one */
      });
      child.stdin.on('error', () => {});
      child.stdin.write(text);
      child.stdin.end();
      return 'command';
    } catch {
      continue;
    }
  }

  return 'failed';
}
