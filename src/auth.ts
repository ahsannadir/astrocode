/**
 * Auth/config persistence for the /login + /models flows.
 *
 * Credentials chosen in the TUI are stored as JSON in ~/.astrocode/config.json
 * (overridable via ASTROCODE_CONFIG_DIR / ASTROCODE_AUTH_FILE) so the app
 * reconnects automatically on the next launch. Synchronous on purpose:
 * loadConfig() runs once at startup before the TUI renders.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface AuthConfig {
  /** Provider id — one of the ids in providers.ts ('openai' | 'anthropic' | 'tokenrouter' | 'openrouter' | 'openai-compatible'). */
  provider: string;
  apiKey: string;
  /** Last model picked via /models (or the provider default). */
  model: string;
  /**
   * Base URL override for the 'openai-compatible' provider (the endpoint the
   * user typed in /login). Ignored for the built-in providers.
   */
  baseUrl?: string;
  /** Runtime settings changed via /settings (all optional, env vars win). */
  verify?: boolean;
  autocommit?: boolean;
  maxToolTurns?: number;
  budget?: number;
  /** Shell approval mode ('off' | 'dangerous' | 'all'). */
  approvalMode?: 'off' | 'dangerous' | 'all';
  /** Color theme picked via /theme (see tui/theme.ts). */
  theme?: string;
}

export function authDir(): string {
  return (
    process.env.ASTROCODE_CONFIG_DIR ||
    path.join(os.homedir(), '.astrocode')
  );
}

export function authFilePath(): string {
  return (
    process.env.ASTROCODE_AUTH_FILE ||
    path.join(authDir(), 'config.json')
  );
}

/**
 * Load the saved config, or null when unset/corrupt/empty.
 *
 * Returns the object even when no API key is present — settings changed via
 * /settings must survive a restart for demo users too. Consumers decide
 * whether an empty apiKey means "not logged in".
 */
export function loadAuth(): AuthConfig | null {
  try {
    const raw = readFileSync(authFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AuthConfig>;
    if (!parsed || typeof parsed !== 'object') return null;
    const hasAny =
      typeof parsed.provider === 'string' ||
      typeof parsed.apiKey === 'string' ||
      typeof parsed.model === 'string' ||
      typeof parsed.baseUrl === 'string' ||
      parsed.verify === true ||
      parsed.autocommit === true ||
      typeof parsed.maxToolTurns === 'number' ||
      typeof parsed.budget === 'number' ||
      typeof parsed.approvalMode === 'string' ||
      typeof parsed.theme === 'string';
    if (!hasAny) return null;
    return {
      provider: typeof parsed.provider === 'string' ? parsed.provider : 'openai',
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
      ...(typeof parsed.baseUrl === 'string' && parsed.baseUrl
        ? { baseUrl: parsed.baseUrl }
        : {}),
      ...(parsed.verify === true ? { verify: true } : {}),
      ...(parsed.autocommit === true ? { autocommit: true } : {}),
      ...(typeof parsed.maxToolTurns === 'number' ? { maxToolTurns: parsed.maxToolTurns } : {}),
      ...(typeof parsed.budget === 'number' ? { budget: parsed.budget } : {}),
      ...(typeof parsed.approvalMode === 'string' && parsed.approvalMode
        ? { approvalMode: parsed.approvalMode }
        : {}),
      ...(typeof parsed.theme === 'string' ? { theme: parsed.theme } : {}),
    };
  } catch {
    return null;
  }
}

/** Persist the auth config to disk (mkdir -p + write). Never throws. */
export function saveAuth(auth: AuthConfig): void {
  try {
    mkdirSync(authDir(), { recursive: true });
    writeFileSync(authFilePath(), JSON.stringify(auth, null, 2), 'utf8');
  } catch (e) {
    process.stderr.write(
      `AstroCode: could not save auth config: ${(e as Error).message}\n`,
    );
  }
}
