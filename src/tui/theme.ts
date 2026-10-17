/**
 * AstroCode visual themes.
 *
 * `theme` is a mutable singleton: every component imports it and reads colors
 * at render time, so `setTheme()` overwrites the fields in place and the next
 * re-render picks up the new palette everywhere. The /theme popup switches
 * between the palettes below; the choice persists to ~/.astrocode/config.json.
 *
 * Every palette is authored in truecolor hex, not chalk color names. Named
 * colors (`'gray'`, `'magentaBright'`) are only slots in whatever scheme the
 * user's terminal happens to run: a scheme that paints `brightBlack` onto its
 * own background erases every `muted` label, and one that maps `yellow` to a
 * dark red makes `system` text unreadable. Hex is emitted as truecolor and
 * downsampled to the 256-color cube elsewhere, so a theme looks the same on
 * every machine.
 *
 * Each theme is one dominant hue plus two accents, and every color clears
 * 4.5:1 contrast against a near-black pane (`tests/theme.test.ts` enforces
 * both). That is what keeps twelve palettes from collapsing into the same
 * cyan-and-magenta soup.
 */

export interface Theme {
  ascii: string;
  asciiAccent: string;
  star: string;
  user: string;
  assistant: string;
  assistantLabel: string;
  system: string;
  error: string;
  toolName: string;
  toolOk: string;
  toolFail: string;
  muted: string;
  border: string;
  status: string;
  prompt: string;
  promptSymbol: string;
  thinking: string;
  title: string;
  plan: string;
  heading: string;
  bullet: string;
  code: string;
  // Syntax highlighting roles (see src/tui/syntax.ts).
  synKeyword: string;
  synString: string;
  synNumber: string;
  synComment: string;
  synFunction: string;
  synType: string;
  synPunct: string;
  /** Added / removed lines in diff and patch blocks. */
  synAdd: string;
  synDel: string;
  /** Gutter/label chrome for fenced code blocks. */
  codeBorder: string;
}

/**
 * The seven decisions a theme actually makes. Every other role is derived, so
 * a palette is a hue choice rather than thirty-two independent guesses — and
 * two themes can't drift into looking alike by sharing a stray slot.
 */
interface Palette {
  /** Dominant hue: banner, border, title, headings, tool names. */
  primary: string;
  /** Second hue: prompts, bullets, the user's own words, functions. */
  secondary: string;
  /** Third hue: status bar, plan text, thinking, numbers, types. */
  accent: string;
  /** Body text — near-white, tinted toward the theme. */
  body: string;
  /** De-emphasised text: labels, metadata, tool output, comments. */
  muted: string;
  /** Success: tool results, added diff lines. */
  ok: string;
  /** Failure: errors, removed diff lines. */
  fail: string;
  /** Per-role escapes for palettes that need a fourth voice. */
  over?: Partial<Theme>;
}

/** Derive the full role set from a palette's hues. */
function mk(p: Palette): Theme {
  return {
    ascii: p.primary,
    asciiAccent: p.secondary,
    star: p.secondary,
    user: p.secondary,
    assistant: p.body,
    assistantLabel: p.primary,
    system: p.accent,
    error: p.fail,
    toolName: p.primary,
    toolOk: p.ok,
    toolFail: p.fail,
    muted: p.muted,
    border: p.primary,
    status: p.accent,
    prompt: p.secondary,
    promptSymbol: p.primary,
    thinking: p.accent,
    title: p.primary,
    plan: p.accent,
    heading: p.primary,
    bullet: p.secondary,
    code: p.ok,
    synKeyword: p.primary,
    synString: p.ok,
    synNumber: p.accent,
    synComment: p.muted,
    synFunction: p.secondary,
    synType: p.accent,
    synPunct: p.body,
    synAdd: p.ok,
    synDel: p.fail,
    codeBorder: p.primary,
    ...p.over,
  };
}

export const THEMES: Record<string, Theme> = {
  // The flagship: cyan signal, orchid reply, lime success.
  astro: mk({
    primary: '#5ad1e6',
    secondary: '#e58cff',
    accent: '#a8e06a',
    body: '#e6eef2',
    muted: '#8b9aa6',
    ok: '#a8e06a',
    fail: '#ff6b7a',
  }),

  // Deep water: blue hull, teal current. No pink, no purple.
  ocean: mk({
    primary: '#5aa9ff',
    secondary: '#7fd6e0',
    accent: '#9ecbff',
    body: '#dce8f5',
    muted: '#8296ab',
    ok: '#63d8c0',
    fail: '#ff7a85',
  }),

  // Golden hour: gold sun, rose clouds, violet dusk.
  sunset: mk({
    primary: '#ffc857',
    secondary: '#ff6f91',
    accent: '#b48cff',
    body: '#f7e4d8',
    muted: '#b39a90',
    ok: '#b6e07a',
    fail: '#ff5f6d',
  }),

  // Understory: leaf green, moss, bark.
  forest: mk({
    primary: '#8fd46a',
    secondary: '#cfe08a',
    accent: '#d9b382',
    body: '#e4eddd',
    muted: '#93a68d',
    ok: '#7fe0a8',
    fail: '#e88a7a',
  }),

  // Phosphor: one hue, like the monitor it came from.
  matrix: mk({
    primary: '#4ade80',
    secondary: '#86efac',
    accent: '#34d399',
    body: '#d6ffe0',
    muted: '#5fa878',
    ok: '#4ade80',
    fail: '#ff6b6b',
    over: { synNumber: '#86efac', synType: '#86efac' },
  }),

  // Sky on fire: teal-green flash, lime rim, violet crown.
  aurora: mk({
    primary: '#4fe0b8',
    secondary: '#a6f08a',
    accent: '#9f8cff',
    body: '#e2f2ee',
    muted: '#86a8a4',
    ok: '#7ef0b0',
    fail: '#ff7a9a',
  }),

  // Night City neon: hot red signage, rose glow, cold ice highlight.
  cyberpunk: mk({
    primary: '#ff3b52',
    secondary: '#ff8a9a',
    accent: '#8fd4ff',
    body: '#f6e6e8',
    muted: '#a88d92',
    ok: '#7ee787',
    fail: '#ff8080',
    over: {
      // A red theme shouldn't paint its strings green.
      synString: '#ff8a9a',
      synNumber: '#ffb3bf',
      code: '#ff8a9a',
      status: '#ffb03a',
    },
  }),

  // The classic: lavender, pink, cyan, and a green that means "fine".
  dracula: mk({
    primary: '#bd93f9',
    secondary: '#ff79c6',
    accent: '#8be9fd',
    body: '#f8f8f2',
    muted: '#9a94b8',
    ok: '#50fa7b',
    fail: '#ff5555',
  }),

  // Ember bed: orange flame, yellow core, red underside.
  inferno: mk({
    primary: '#ff7a45',
    secondary: '#ffc46b',
    accent: '#ff5c4d',
    body: '#f7e6d8',
    muted: '#b09080',
    ok: '#a8d86a',
    fail: '#ff4d4d',
  }),

  // Deep space: indigo dust, magenta gas, no green anywhere.
  nebula: mk({
    primary: '#6f7dff',
    secondary: '#d98cff',
    accent: '#ff9ad5',
    body: '#e9e8ff',
    muted: '#9a94b8',
    ok: '#8fd4ff',
    fail: '#ff7a9a',
    over: { toolOk: '#8fd4ff', synAdd: '#8fd4ff' },
  }),

  // Chrome: everything is a shade of gray except the one thing that broke.
  noir: mk({
    primary: '#e8e8e8',
    secondary: '#c8c8c8',
    accent: '#ff4d4d',
    body: '#f5f5f5',
    muted: '#9a9a9a',
    ok: '#e8e8e8',
    fail: '#ff4d4d',
    over: { synNumber: '#c8c8c8', synType: '#c8c8c8', thinking: '#b0b0b0' },
  }),

  // Retro grid: magenta sky, violet horizon, a yellow sun.
  synthwave: mk({
    primary: '#ff5fd2',
    secondary: '#9b7bff',
    accent: '#ffd166',
    body: '#ffe6f7',
    muted: '#b090b8',
    ok: '#7ef0c0',
    fail: '#ff6b8a',
  }),
};

export const THEME_NAMES: string[] = Object.keys(THEMES);

/** The active palette. Mutated in place by setTheme(); read at render time. */
export const theme: Theme = { ...THEMES.astro };

/**
 * Bumped by setTheme(). Renderers that memoize color-derived output include
 * this in their cache key so a theme switch is picked up immediately.
 */
export let themeRevision = 0;

/**
 * Swap the active palette (unknown/empty names fall back to 'astro').
 * Returns the name that was actually applied.
 */
export function setTheme(name?: string | null): string {
  const applied = name && THEMES[name] ? name : 'astro';
  const t = THEMES[applied];
  for (const key of Object.keys(t) as (keyof Theme)[]) {
    theme[key] = t[key];
  }
  themeRevision++;
  return applied;
}

/** Guard for tests: every theme color must be a #rrggbb truecolor value. */
export function validThemeColors(t: Theme): boolean {
  return Object.values(t).every((c) => /^#[0-9a-fA-F]{6}$/.test(c));
}

export const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const starFrames = ['✦', '✧', '★', '☆'];
