/**
 * AstroCode visual themes.
 *
 * `theme` is a mutable singleton: every component imports it and reads colors
 * at render time, so `setTheme()` overwrites the fields in place and the next
 * re-render picks up the new palette everywhere. The /theme popup switches
 * between the palettes below; the choice persists to ~/.astrocode/config.json.
 */

/** Named Ink colors used by the UI (chalk base + bright aliases). */
const INK_COLORS = new Set([
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'gray', 'blackBright', 'redBright', 'greenBright', 'yellowBright',
  'blueBright', 'magentaBright', 'cyanBright', 'whiteBright',
]);

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
  // Syntax highlighting roles (see src/tui/syntax.ts). Kept to named Ink
  // colors so validThemeColors() and every palette stay honest.
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

export const THEMES: Record<string, Theme> = {
  astro: {
    ascii: 'cyan',
    asciiAccent: 'magenta',
    star: 'magenta',
    user: 'cyanBright',
    assistant: 'white',
    assistantLabel: 'cyan',
    system: 'yellow',
    error: 'red',
    toolName: 'magentaBright',
    toolOk: 'green',
    toolFail: 'red',
    muted: 'gray',
    border: 'gray',
    status: 'blueBright',
    prompt: 'greenBright',
    promptSymbol: 'magenta',
    thinking: 'yellow',
    title: 'cyanBright',
    plan: 'blueBright',
    heading: 'cyanBright',
    bullet: 'yellow',
    code: 'greenBright',
    synKeyword: 'magentaBright',
    synString: 'greenBright',
    synNumber: 'yellowBright',
    synComment: 'gray',
    synFunction: 'cyanBright',
    synType: 'blueBright',
    synPunct: 'white',
    synAdd: 'greenBright',
    synDel: 'redBright',
    codeBorder: 'gray',
  },
  ocean: {
    ascii: 'blue',
    asciiAccent: 'cyan',
    star: 'cyan',
    user: 'cyanBright',
    assistant: 'white',
    assistantLabel: 'blueBright',
    system: 'yellow',
    error: 'red',
    toolName: 'cyanBright',
    toolOk: 'greenBright',
    toolFail: 'red',
    muted: 'gray',
    border: 'blue',
    status: 'blue',
    prompt: 'cyanBright',
    promptSymbol: 'cyan',
    thinking: 'yellow',
    title: 'blueBright',
    plan: 'cyan',
    heading: 'blueBright',
    bullet: 'yellow',
    code: 'greenBright',
    synKeyword: 'cyanBright',
    synString: 'greenBright',
    synNumber: 'yellowBright',
    synComment: 'gray',
    synFunction: 'blueBright',
    synType: 'cyan',
    synPunct: 'white',
    synAdd: 'greenBright',
    synDel: 'redBright',
    codeBorder: 'blue',
  },
  sunset: {
    ascii: 'yellow',
    asciiAccent: 'magenta',
    star: 'yellow',
    user: 'yellowBright',
    assistant: 'white',
    assistantLabel: 'magentaBright',
    system: 'yellow',
    error: 'red',
    toolName: 'magentaBright',
    toolOk: 'greenBright',
    toolFail: 'red',
    muted: 'gray',
    border: 'yellow',
    status: 'magenta',
    prompt: 'yellowBright',
    promptSymbol: 'magenta',
    thinking: 'yellow',
    title: 'magentaBright',
    plan: 'magenta',
    heading: 'yellowBright',
    bullet: 'yellow',
    code: 'greenBright',
    synKeyword: 'magentaBright',
    synString: 'greenBright',
    synNumber: 'yellowBright',
    synComment: 'gray',
    synFunction: 'yellowBright',
    synType: 'magenta',
    synPunct: 'white',
    synAdd: 'greenBright',
    synDel: 'redBright',
    codeBorder: 'yellow',
  },
  forest: {
    ascii: 'green',
    asciiAccent: 'greenBright',
    star: 'greenBright',
    user: 'greenBright',
    assistant: 'white',
    assistantLabel: 'green',
    system: 'yellow',
    error: 'red',
    toolName: 'greenBright',
    toolOk: 'greenBright',
    toolFail: 'red',
    muted: 'gray',
    border: 'green',
    status: 'green',
    prompt: 'greenBright',
    promptSymbol: 'greenBright',
    thinking: 'yellow',
    title: 'greenBright',
    plan: 'green',
    heading: 'greenBright',
    bullet: 'yellow',
    code: 'greenBright',
    synKeyword: 'greenBright',
    synString: 'yellowBright',
    synNumber: 'cyanBright',
    synComment: 'gray',
    synFunction: 'cyanBright',
    synType: 'green',
    synPunct: 'white',
    synAdd: 'greenBright',
    synDel: 'redBright',
    codeBorder: 'green',
  },
  matrix: {
    ascii: 'green',
    asciiAccent: 'greenBright',
    star: 'green',
    user: 'green',
    assistant: 'greenBright',
    assistantLabel: 'green',
    system: 'green',
    error: 'red',
    toolName: 'greenBright',
    toolOk: 'greenBright',
    toolFail: 'red',
    muted: 'green',
    border: 'green',
    status: 'green',
    prompt: 'greenBright',
    promptSymbol: 'green',
    thinking: 'green',
    title: 'greenBright',
    plan: 'green',
    heading: 'green',
    bullet: 'green',
    code: 'greenBright',
    synKeyword: 'greenBright',
    synString: 'green',
    synNumber: 'greenBright',
    synComment: 'gray',
    synFunction: 'greenBright',
    synType: 'green',
    synPunct: 'green',
    synAdd: 'greenBright',
    synDel: 'red',
    codeBorder: 'green',
  },
  aurora: {
    // Northern lights: teal sky, green flash, blue depths.
    ascii: 'cyan',
    asciiAccent: 'greenBright',
    star: 'greenBright',
    user: 'greenBright',
    assistant: 'white',
    assistantLabel: 'cyan',
    system: 'yellow',
    error: 'red',
    toolName: 'cyanBright',
    toolOk: 'greenBright',
    toolFail: 'red',
    muted: 'gray',
    border: 'cyan',
    status: 'cyan',
    prompt: 'greenBright',
    promptSymbol: 'cyan',
    thinking: 'blueBright',
    title: 'cyanBright',
    plan: 'blueBright',
    heading: 'greenBright',
    bullet: 'cyanBright',
    code: 'greenBright',
    synKeyword: 'greenBright',
    synString: 'cyanBright',
    synNumber: 'yellowBright',
    synComment: 'gray',
    synFunction: 'cyan',
    synType: 'blueBright',
    synPunct: 'white',
    synAdd: 'greenBright',
    synDel: 'redBright',
    codeBorder: 'cyan',
  },
  cyberpunk: {
    // Neon voltage: hot magenta, electric cyan, acid yellow.
    ascii: 'magentaBright',
    asciiAccent: 'cyanBright',
    star: 'cyanBright',
    user: 'cyanBright',
    assistant: 'whiteBright',
    assistantLabel: 'magentaBright',
    system: 'yellowBright',
    error: 'red',
    toolName: 'magentaBright',
    toolOk: 'greenBright',
    toolFail: 'red',
    muted: 'gray',
    border: 'magentaBright',
    status: 'cyan',
    prompt: 'yellowBright',
    promptSymbol: 'magentaBright',
    thinking: 'blueBright',
    title: 'magentaBright',
    plan: 'cyanBright',
    heading: 'cyanBright',
    bullet: 'magentaBright',
    code: 'yellowBright',
    synKeyword: 'magentaBright',
    synString: 'cyanBright',
    synNumber: 'yellowBright',
    synComment: 'gray',
    synFunction: 'cyan',
    synType: 'magenta',
    synPunct: 'whiteBright',
    synAdd: 'greenBright',
    synDel: 'redBright',
    codeBorder: 'magentaBright',
  },
  dracula: {
    // The beloved palette: purple, pink, green, and cyan on night black.
    ascii: 'magenta',
    asciiAccent: 'magentaBright',
    star: 'magentaBright',
    user: 'cyanBright',
    assistant: 'white',
    assistantLabel: 'magentaBright',
    system: 'yellowBright',
    error: 'red',
    toolName: 'magentaBright',
    toolOk: 'greenBright',
    toolFail: 'red',
    muted: 'gray',
    border: 'magenta',
    status: 'magenta',
    prompt: 'greenBright',
    promptSymbol: 'magentaBright',
    thinking: 'magenta',
    title: 'magentaBright',
    plan: 'cyan',
    heading: 'cyanBright',
    bullet: 'magentaBright',
    code: 'greenBright',
    synKeyword: 'magentaBright',
    synString: 'greenBright',
    synNumber: 'yellowBright',
    synComment: 'gray',
    synFunction: 'cyanBright',
    synType: 'cyan',
    synPunct: 'white',
    synAdd: 'greenBright',
    synDel: 'redBright',
    codeBorder: 'magenta',
  },
  inferno: {
    // Ember & flame: red heat with a yellow core.
    ascii: 'red',
    asciiAccent: 'yellowBright',
    star: 'yellow',
    user: 'yellowBright',
    assistant: 'white',
    assistantLabel: 'redBright',
    system: 'yellow',
    error: 'red',
    toolName: 'yellowBright',
    toolOk: 'green',
    toolFail: 'red',
    muted: 'gray',
    border: 'red',
    status: 'redBright',
    prompt: 'yellowBright',
    promptSymbol: 'red',
    thinking: 'yellow',
    title: 'yellowBright',
    plan: 'yellow',
    heading: 'yellowBright',
    bullet: 'yellow',
    code: 'yellowBright',
    synKeyword: 'yellowBright',
    synString: 'redBright',
    synNumber: 'yellow',
    synComment: 'gray',
    synFunction: 'yellowBright',
    synType: 'red',
    synPunct: 'white',
    synAdd: 'greenBright',
    synDel: 'redBright',
    codeBorder: 'red',
  },
  nebula: {
    // Deep space: violet dust clouds and blue starlight.
    ascii: 'magenta',
    asciiAccent: 'blueBright',
    star: 'cyanBright',
    user: 'cyanBright',
    assistant: 'white',
    assistantLabel: 'magentaBright',
    system: 'yellow',
    error: 'red',
    toolName: 'magentaBright',
    toolOk: 'greenBright',
    toolFail: 'red',
    muted: 'gray',
    border: 'magenta',
    status: 'magentaBright',
    prompt: 'cyanBright',
    promptSymbol: 'magenta',
    thinking: 'blueBright',
    title: 'magentaBright',
    plan: 'blueBright',
    heading: 'cyanBright',
    bullet: 'magentaBright',
    code: 'blueBright',
    synKeyword: 'magentaBright',
    synString: 'cyanBright',
    synNumber: 'blueBright',
    synComment: 'gray',
    synFunction: 'cyan',
    synType: 'magenta',
    synPunct: 'white',
    synAdd: 'greenBright',
    synDel: 'redBright',
    codeBorder: 'magenta',
  },
  noir: {
    // Monochrome with a single red accent — chrome in shades of gray.
    ascii: 'white',
    asciiAccent: 'gray',
    star: 'whiteBright',
    user: 'whiteBright',
    assistant: 'white',
    assistantLabel: 'whiteBright',
    system: 'gray',
    error: 'red',
    toolName: 'whiteBright',
    toolOk: 'green',
    toolFail: 'red',
    muted: 'gray',
    border: 'gray',
    status: 'whiteBright',
    prompt: 'whiteBright',
    promptSymbol: 'white',
    thinking: 'gray',
    title: 'whiteBright',
    plan: 'white',
    heading: 'whiteBright',
    bullet: 'white',
    code: 'whiteBright',
    synKeyword: 'whiteBright',
    synString: 'white',
    synNumber: 'whiteBright',
    synComment: 'gray',
    synFunction: 'whiteBright',
    synType: 'white',
    synPunct: 'gray',
    synAdd: 'whiteBright',
    synDel: 'red',
    codeBorder: 'gray',
  },
  synthwave: {
    // Retro grid: magenta sky, cyan horizon, a yellow sun.
    ascii: 'magenta',
    asciiAccent: 'cyan',
    star: 'yellowBright',
    user: 'cyanBright',
    assistant: 'white',
    assistantLabel: 'magenta',
    system: 'yellowBright',
    error: 'red',
    toolName: 'magentaBright',
    toolOk: 'greenBright',
    toolFail: 'red',
    muted: 'gray',
    border: 'magenta',
    status: 'magenta',
    prompt: 'cyanBright',
    promptSymbol: 'magentaBright',
    thinking: 'blueBright',
    title: 'yellowBright',
    plan: 'cyan',
    heading: 'magentaBright',
    bullet: 'cyanBright',
    code: 'yellowBright',
    synKeyword: 'magentaBright',
    synString: 'cyanBright',
    synNumber: 'yellowBright',
    synComment: 'gray',
    synFunction: 'cyan',
    synType: 'magenta',
    synPunct: 'white',
    synAdd: 'greenBright',
    synDel: 'redBright',
    codeBorder: 'magenta',
  },
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

/** Guard for tests: every theme must use only valid named Ink colors. */
export function validThemeColors(t: Theme): boolean {
  return Object.values(t).every((c) => INK_COLORS.has(c));
}

export const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const starFrames = ['✦', '✧', '★', '☆'];
