import { exec } from 'node:child_process';
import type { ToolResult } from '../types.js';

export interface ShellOptions {
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Run a shell command and capture stdout/stderr + exit code.
 * Returns a structured ToolResult.
 */
export function runShell(
  command: string,
  opts: ShellOptions = {},
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs + 500);

    const child = exec(
      command,
      {
        cwd: opts.cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        const code = error ? (typeof (error as any).code === 'number' ? (error as any).code : 1) : 0;
        const out = stdout ? stdout.trimEnd() : '';
        const err = stderr ? stderr.trimEnd() : '';
        let text = out;
        if (err) text = text ? `${text}\n${err}` : err;
        if (code !== 0 && text === '') text = String(error?.message || 'command failed');

        resolve({
          ok: code === 0,
          text:
            (text || '(no output)') +
            `\n[exit code: ${code}]`,
        });
      },
    );
  });
}
