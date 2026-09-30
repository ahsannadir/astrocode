/**
 * Shell-command approval for AstroCode.
 *
 * The danger list (isDangerousCommand) is a blunt instrument: it blocks the
 * catastrophic and runs everything else. Approval adds the missing middle
 * layer — a bounded "run this? [y]es / [n]o / a[lways]" decision, surfaced in
 * the TUI (or answered automatically in headless mode), with the user's
 * "always" decisions remembered for the session so a test suite doesn't ask
 * twenty times.
 *
 * Modes:
 *   off        — never prompt (today's behavior, plus the danger list).
 *   dangerous  — prompt only for commands that look risky (the danger list
 *                plus a softer risk heuristic: recursive deletes, force ops,
 *                installs, curls piped to shells, …).
 *   all        — prompt for every run_command.
 *
 * "Always allow" entries are command PREFIXES (first two whitespace words,
 * e.g. `npm run`, `git push`) — coarse on purpose; fine-grained allowlisting
 * is what a real policy engine is for, and the user saw the full command.
 */
import type { ToolResult } from './types.js';

export type ApprovalMode = 'off' | 'dangerous' | 'all';

/**
 * Hard danger list — commands that must never run without the model (or
 * user) explicitly forcing them. Canonical definition lives here so the
 * approval layer and the tool layer share one source of truth (re-exported
 * from tools/registry.ts for compatibility).
 */
export function isDangerousCommand(command: string): boolean {
  const c = command.trim().toLowerCase();
  const patterns = [
    /\brm\s+-rf\s+\/\s*$/, // rm -rf /
    /\brm\s+-rf\s+(\/|\*|\.)\s*$/, // rm -rf / * .
    /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, // fork bomb
    /\bmkfs\b/, // format
    /\bdd\s+if=.*of=\/dev\//, // overwrite a device
    />\s*\/dev\/sd/, // dump to a raw device
    /--force\s+push/, // force push
    /\bgit\b[^\n]*\bpush\b[^\n]*--?force/, // git push --force (other order)
    /git\s+reset\s+--hard/, // destructive git discard (without path control)
    /chmod\s+-r\s+777\s+\//, // chmod root (command is lowercased before matching)
    /shutdown|reboot|halt\b/, // machine control
  ];
  return patterns.some((re) => re.test(c));
}

export function normalizeApprovalMode(raw: unknown): ApprovalMode {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'all' || s === 'every' || s === 'yolo') return 'all';
  if (s === 'dangerous' || s === 'risky') return 'dangerous';
  return 'off';
}

/** Coarse prefix key for "always allow": first ≤2 whitespace words, lowercased. */
export function commandPrefix(command: string): string {
  const words = command.trim().toLowerCase().split(/\s+/).slice(0, 2);
  return words.join(' ');
}

/**
 * Softer risk heuristic than isDangerousCommand: destructive-ish things the
 * danger list doesn't name (rm -rf in a subdir, git reset/checkout -- .,
 * force operations, installs, remote script execution). Used in
 * 'dangerous' mode; the hard danger list always implies this.
 */
export function isRiskyCommand(command: string): boolean {
  const c = command.trim().toLowerCase();
  const patterns = [
    /\brm\b[^;&|\n]*\s(-[a-egi-qsu-z]*r|--recursive)/, // rm -r anywhere
    /\bgit\b[^;&|\n]*\b(reset|checkout|restore|clean)\b/, // discard-ish git ops
    /--force|-\bf\b/, // force flags
    /\b(npm|yarn|pnpm|bun)\s+(install|i|add|remove|uninstall|link)\b/, // installs
    /\bpip3?\s+install\b/,
    /\bcurl\b[^;&|\n]*\|\s*(ba)?sh\b/, // curl | sh
    /\bwget\b[^;&|\n]*\|\s*(ba)?sh\b/,
    /\bchmod\b[^;&|\n]*\s777\b/,
    /\bkill(all)?\b|\bpkill\b/,
    /\bdocker\b[^;&|\n]*\b(rm|system\s+prune)\b/,
    />\s*\/dev\/(?!null)/, // writing to a device node (but not /dev/null)
    /\bsudo\b/,
  ];
  return patterns.some((re) => re.test(c));
}

/** Decision the TUI (or headless mode) reports back for a pending request. */
export type ApprovalDecision = 'approved' | 'denied' | 'always';

export interface ApprovalRequest {
  command: string;
  cwd: string;
}

export interface ApprovalVerdict {
  /** true → run the command. */
  allow: boolean;
  /** What the tool result should say on a denial. */
  text?: string;
}

/**
 * Session-scoped approval state. One instance lives in the TUI app (or a
 * fresh one per headless run). The allowlist starts from env/config so
 * `ASTROCODE_APPROVE=npm test,npm run typecheck` pre-approves commands.
 */
export class ApprovalGate {
  readonly mode: ApprovalMode;
  private readonly allowed: Set<string>;
  /** Resolved asynchronously by the UI when a decision is needed. */
  private ask: ((req: ApprovalRequest) => Promise<ApprovalDecision>) | null = null;

  constructor(mode: ApprovalMode = 'off', preapproved: string[] = []) {
    this.mode = mode;
    this.allowed = new Set(
      preapproved.map((p) => commandPrefix(p)).filter((p) => p.length > 0),
    );
  }

  /** Install the UI callback that surfaces the prompt and awaits a decision. */
  setAsker(ask: (req: ApprovalRequest) => Promise<ApprovalDecision>): void {
    this.ask = ask;
  }

  /** Prefixes currently approved for the session (for /status etc). */
  approvedPrefixes(): string[] {
    return [...this.allowed].sort();
  }

  isPreapproved(command: string): boolean {
    return this.allowed.has(commandPrefix(command));
  }

  /**
   * Decide whether `command` may run. Never prompts when mode is 'off' or the
   * prefix was already approved; prompts otherwise, honoring the decision
   * ('always' records the prefix for the rest of the session).
   */
  async check(req: ApprovalRequest): Promise<ApprovalVerdict> {
    if (this.isPreapproved(req.command)) return { allow: true };

    const risky = isDangerousCommand(req.command) || isRiskyCommand(req.command);
    const needsPrompt =
      this.mode === 'all' ? true : this.mode === 'dangerous' ? risky : false;
    if (!needsPrompt) {
      // Hard danger list still refuses (unless force) at the tool layer;
      // here 'off' mode simply doesn't add prompts.
      return { allow: true };
    }

    if (!this.ask) {
      // No UI wired (shouldn't happen in the TUI; possible in tests/headless
      // without a resolver): fail closed in 'all', fail open-but-loud in
      // 'dangerous' for non-danger-list commands — actually fail CLOSED
      // always, predictable beats clever.
      return {
        allow: false,
        text: `⛔ Approval required but no prompt UI is available; command NOT run:\n  ${req.command}`,
      };
    }

    const decision = await this.ask(req);
    if (decision === 'always') {
      this.allowed.add(commandPrefix(req.command));
      return { allow: true };
    }
    if (decision === 'approved') return { allow: true };
    return {
      allow: false,
      text:
        `⛔ You declined to run:\n  ${req.command}\n` +
        `The agent should proceed without it or propose an alternative.`,
    };
  }
}

/** Parse the ASTROCODE_APPROVE env value ("npm test, git status") into prefixes. */
export function parseApproveEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
