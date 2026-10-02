/**
 * Frame-height budgeting for the main screen.
 *
 * Ink's `onRender` takes a direct-write path as soon as the rendered frame is
 * >= `stdout.rows`:
 *
 *     if (outputHeight >= this.options.stdout.rows) {
 *       stdout.write(clearTerminal + fullStaticOutput + output)
 *     }
 *
 * That path bypasses log-update's own bookkeeping. The NEXT frame — which,
 * right after Esc, is byte-identical to what log-update still believes is on
 * screen — then emits zero bytes, so closing a full-height popup (/settings,
 * /theme, …) left the stale screen painted until some later frame happened to
 * differ. Only the WIDTH is set on Ink's root Yoga node, so the frame's height
 * is whatever the components add up to: every row spent here is a row Ink
 * sees. The single invariant that keeps the direct-write path unreachable is
 *
 *     totalHeight < rows
 *
 * so this module owns the arithmetic and `tests/layout.test.ts` sweeps the
 * state space against it. It deliberately has no Ink/React imports: the layout
 * is pure arithmetic and must stay testable without a terminal.
 */

export const BANNER_H = 7; // header(1) + 5 logo rows + footer(1)
export const BANNER_COMPACT_H = 1; // header only (star + wordmark + version)
export const STATUS_H = 3; // bordered status bar: top border + content + bottom border
export const PROMPT_H = 3; // bordered input box: top border + input row + bottom border
// Cells the prompt box spends outside its text: marginX(2) + borders(2) +
// paddingX(2) + the "❯ " marker(2).
export const PROMPT_TEXT_INSET = 8;
export const APPROVAL_H = 6; // approval box: title + command + cwd + hint + borders(2)
export const MIN_MESSAGE_H = 3; // keep at least one content line + breathing room

export const HEADROOM = 1; // the spare row that keeps us off Ink's direct-write path
export const SLASH_MAX_ROWS = 8; // visible command rows in the slash menu
export const MENU_CHROME_H = 3; // slash menu: borders(2) + hint(1)
export const SLASH_GAP_H = 1; // spacer between the open slash menu and the prompt box
// settings: title(1) + hint(1) + borders(2), plus SETTINGS_ROWS option rows.
// Windowed against the budget like every other popup rather than assumed —
// a hardcoded 12 was one of the three ways a frame reached stdout.rows.
export const SETTINGS_CHROME_H = 4;
/** Option rows the /settings menu renders (see SettingsMenu). */
export const SETTINGS_ROWS = 8;
export const MODELS_CHROME_H = 4; // models: title + hint + borders
export const THEME_CHROME_H = 5; // theme: title + subtitle + hint + borders
// login: title + subtitle + hint + borders, plus the two scroll notices its
// model stage can add once a fetched list outgrows the screen (the list length
// isn't known up front, so both are always reserved).
export const LOGIN_CHROME_H = 7;
export const SCROLL_NOTICE_H = 2; // "↑ n more…" + "↓ n more…" rows on a scrolling list

/** Task-panel rows visible at once; older tasks are trimmed with a notice. */
export const TODO_MAX_ROWS = 6;

/** The interactive popups that replace the prompt box. */
export type PopupKind = 'login' | 'models' | 'settings' | 'theme';

/** Non-list chrome (borders + title/subtitle/hint rows) per popup. */
export const POPUP_CHROME_H: Record<PopupKind, number> = {
  login: LOGIN_CHROME_H,
  models: MODELS_CHROME_H,
  settings: SETTINGS_CHROME_H,
  theme: THEME_CHROME_H,
};

/**
 * Smallest terminal the frame budget can hold on, measured rather than
 * guessed: the worst reachable stack is a pending approval (6) plus a queued
 * prompt (1) plus the tallest popup (/login, 8) on top of the fixed chrome —
 * banner (1) + message pane (3) + status bar (3) + headroom (1) = 23.
 *
 * Below this no combination can stay under the screen height, so
 * `tests/layout.test.ts` only asserts `totalHeight < rows` from here up and
 * checks graceful degradation (no negative or collapsed rows) below it.
 */
export const MIN_SUPPORTED_ROWS = 23;

/**
 * Everything about the frame that the height budget depends on. Row/list
 * COUNTS are passed in rather than imported so this module stays free of
 * Ink/React and the theme/provider registries, and so tests can sweep
 * arbitrary list lengths.
 */
export interface LayoutInput {
  /** Terminal height in rows (stdout.rows). */
  rows: number;
  /** Which popup is open, or null when the prompt box is showing. */
  modal: PopupKind | null;
  /** Is the slash-command menu open? */
  slashActive: boolean;
  /** Number of commands matching the current slash query. */
  slashMatches: number;
  /** Number of live todos (0 hides the task panel). */
  todoCount: number;
  /** Is a shell-approval decision pending? */
  approvalPending: boolean;
  /** Number of prompts queued behind a busy agent. */
  queueLength: number;
  /** Models offered by the active provider (/models). */
  modelsCount: number;
  /** Themes available (/theme). */
  themesCount: number;
  /** Providers available (/login). */
  providersCount: number;
}

/**
 * A windowed popup list.
 *
 * `cap` is the TOTAL number of rows the popup's list region may occupy —
 * scroll notices included, never added on top. That contract is what lets a
 * long list shrink to fit the screen without outgrowing its reservation;
 * `scrollWindow` spends it for you.
 */
export interface PopupList {
  /** Rows the list region may occupy in total. */
  cap: number;
  /** Rows reserved for the whole popup (list region + chrome). */
  height: number;
  /** Does the list need a scroll window? */
  scrolls: boolean;
}

/** The slice of a scrollable list to render, within a row budget. */
export interface ScrollWindow {
  /** Rows of actual list entries to render. */
  count: number;
  start: number;
  hasMoreUp: boolean;
  hasMoreDown: boolean;
  /** Total rows the window actually occupies, notices included. */
  rows: number;
}

/**
 * Window a scrollable list into at most `maxRows` rows IN TOTAL.
 *
 * The "↑ n more…" / "↓ n more…" notices come out of that budget rather than
 * stacking on top of it, so a trimmed list can never render taller than the
 * height the layout reserved for the popup — which is the whole class of bug
 * that put these frames on Ink's direct-write path.
 *
 * Both notices are charged whenever the list is trimmed (not just the side
 * currently in view) so the reservation is worst-case safe and `sel` moving
 * around can never change the popup's height.
 */
export function scrollWindow(listLength: number, sel: number, maxRows: number): ScrollWindow {
  const cap = Math.max(1, Math.min(maxRows, Math.max(0, listLength)));
  const scrolls = cap < listLength;
  // When the budget can't cover a row plus both notices, show the entries and
  // drop the notices — the alternative is honouring the notice count and
  // overflowing the reservation, which is the bug this module exists to stop.
  const count = scrolls ? Math.max(1, cap - SCROLL_NOTICE_H) : cap;
  const start = Math.max(
    0,
    Math.min(sel - Math.floor((count - 1) / 2), Math.max(0, listLength - count)),
  );
  const hasMoreUp = start > 0;
  const hasMoreDown = start + count < listLength;
  const rows = (hasMoreUp ? 1 : 0) + count + (hasMoreDown ? 1 : 0);
  // A tiny budget leaves no room for notices; render the entries alone.
  const noticeRoom = cap - count;
  return {
    count,
    start,
    hasMoreUp: noticeRoom >= 1 ? hasMoreUp : false,
    hasMoreDown: noticeRoom >= 2 ? hasMoreDown : false,
    rows: Math.min(rows, cap),
  };
}

/** The full height budget for one frame. */
export interface Layout {
  bannerH: number;
  /** Rows the task panel got — it yields when the screen is tight. */
  todoH: number;
  /**
   * `maxRows` to hand TodoPanel so it renders exactly `todoH` rows: the
   * number of task entries it may show, notices included. 0 means the panel
   * is suppressed entirely.
   */
  todoMaxRows: number;
  approvalH: number;
  queueH: number;
  /** Everything that is never an overlay, including the message-pane floor. */
  fixedChrome: number;
  /** Rows an open popup may spend. */
  modalBudget: number;
  /** Rows the slash menu may spend (a popup is not open at the same time). */
  menuBudget: number;
  slashRowCap: number;
  slashMenuH: number;
  slashGapH: number;
  promptH: number;
  modalH: number;
  messageHeight: number;
  modelsList: PopupList;
  themeList: PopupList;
  settingsList: PopupList;
  loginList: PopupList;
  /**
   * Rows the render tree actually occupies. Asserting `totalHeight < rows` is
   * the whole point of this module — it is what keeps Ink off its direct-write
   * path.
   */
  totalHeight: number;
  /** `rows - totalHeight`: 1 or more whenever the invariant holds. */
  spare: number;
  /** Is the frame strictly shorter than the terminal? */
  fits: boolean;
}

/**
 * The task panel's natural height: borders(2) + header(1) + one row per
 * visible task, plus an "▲ n earlier task(s) hidden" row when the list was
 * trimmed. Mirrors what TodoPanel actually renders. This is an upper bound —
 * the panel yields rows when the active overlay needs them.
 */
export function todoPanelHeight(todoCount: number, maxRows = TODO_MAX_ROWS): number {
  if (todoCount <= 0) return 0;
  const visible = Math.min(todoCount, maxRows);
  return visible + 3 + (todoCount > maxRows ? 1 : 0);
}

/**
 * Largest `maxRows` whose panel still fits in `available` rows, or 0 when not
 * even a one-task panel fits.
 *
 * Solved by measurement rather than arithmetic because the panel's height is
 * not linear in `maxRows`: trimming the list also *adds* the "▲ n earlier
 * task(s) hidden" notice. Computing it by hand (subtracting a notice row
 * assumed from the untrimmed count) got it wrong by one, and the panel then
 * rendered taller than the budget reserved for it.
 */
export function fitTodoPanel(todoCount: number, available: number): number {
  if (todoCount <= 0 || available <= 0) return 0;
  let best = 0;
  for (let maxRows = Math.min(todoCount, TODO_MAX_ROWS); maxRows >= 1; maxRows--) {
    if (todoPanelHeight(todoCount, maxRows) <= available) {
      best = maxRows;
      break;
    }
  }
  return best;
}

/**
 * Smallest number of rows each popup can occupy: its fixed chrome plus one
 * list row. Used to reserve space before the task panel is sized.
 */
export function popupMinHeight(modal: PopupKind): number {
  return POPUP_CHROME_H[modal] + 1;
}

/**
 * Compute every row reservation for one frame. Pure: same input, same output,
 * no terminal required.
 *
 * The banner is decided by MEASUREMENT, not by a fixed row threshold: the
 * full art block is used whenever the rest of the frame still fits under the
 * screen, and falls back to the compact header otherwise. A threshold created
 * a cliff — at 26 rows the banner grew by 6 and pushed an approval prompt
 * plus a popup off the bottom, so 23-25-row terminals fitted while 26-27-row
 * ones did not.
 */
export function computeLayout(input: LayoutInput): Layout {
  const full = buildLayout(input, BANNER_H);
  return full.fits ? full : buildLayout(input, BANNER_COMPACT_H);
}

function buildLayout(input: LayoutInput, bannerH: number): Layout {
  const { rows } = input;

  // The approval prompt replaces the input box visually but still costs rows.
  const approvalH = input.approvalPending ? APPROVAL_H : 0;
  const queueH = input.queueLength > 0 ? 1 : 0;

  // A popup replaces the prompt box, so it supersedes the slash menu: the
  // menu belongs to the prompt and must not stack on top of a modal. The same
  // goes for a pending approval — the agent is blocked on a y/a/n decision,
  // so browsing commands underneath it serves no purpose. Both are reachable
  // at once in principle (the menu stays browsable while the agent is busy,
  // so an approval can land under an open menu), so the budget handles the
  // combination rather than assuming it away.
  const slashShown =
    input.slashActive && input.modal === null && !input.approvalPending;

  // Chrome that is never an overlay: the headroom (the whole point), banner,
  // status bar, approval/queue notices, and the message pane's floor. The
  // task panel is deliberately NOT counted here — it is the one element that
  // yields, so it is sized from whatever the overlay leaves behind.
  const baseChrome =
    HEADROOM + bannerH + STATUS_H + approvalH + queueH + MIN_MESSAGE_H;

  // Rows the overlay needs before the task panel is considered. The slash menu
  // sits ON TOP of the prompt box, so it reserves both; a popup replaces the
  // prompt, so it reserves only its own chrome + one list row.
  const overlayReserve =
    input.modal !== null
      ? popupMinHeight(input.modal)
      : slashShown
        ? PROMPT_H + MENU_CHROME_H + 1 + SLASH_GAP_H
        : PROMPT_H;

  // The task panel takes what is left, up to its natural height. On a
  // comfortable terminal this is always the full panel; on a cramped one it
  // shrinks, and below that it disappears entirely rather than pushing the
  // frame onto Ink's direct-write path.
  const todoRoom = Math.max(0, rows - baseChrome - overlayReserve);
  // The panel may only show what it was granted, and trimming it adds a
  // "▲ n earlier task(s) hidden" row — so solve for the row count that
  // actually fits rather than deriving it arithmetically (see fitTodoPanel).
  const todoMaxRows = fitTodoPanel(input.todoCount, todoRoom);
  const todoH = todoMaxRows > 0 ? todoPanelHeight(input.todoCount, todoMaxRows) : 0;

  // Rows an overlay may use while the message pane keeps its floor: whatever
  // is never an overlay comes off first.
  const fixedChrome = baseChrome + todoH;
  // A popup is drawn INSTEAD of the prompt box, so the prompt's rows are
  // available to it; the slash menu sits above a prompt that stays visible.
  const modalBudget = Math.max(2, rows - fixedChrome);
  const menuBudget = Math.max(2, rows - fixedChrome - PROMPT_H);

  // Slash menu = borders + hint + up to SLASH_MAX_ROWS commands, plus the
  // gap that separates it from the prompt box.
  const slashRowCap = Math.max(
    1,
    Math.min(SLASH_MAX_ROWS, menuBudget - MENU_CHROME_H - SLASH_GAP_H),
  );
  const slashMenuH = slashShown
    ? Math.min(input.slashMatches, slashRowCap) + MENU_CHROME_H
    : 0;
  const slashGapH = slashShown ? SLASH_GAP_H : 0;

  // Popup sizing. `cap` is the whole budget for the list region (scroll
  // notices included, see scrollWindow) so the popup's reserved height can
  // never exceed what it actually renders — under-reserving is exactly what
  // put these frames on Ink's direct-write path before.
  const popupList = (listLength: number, chrome: number): PopupList => {
    const room = Math.max(1, modalBudget - chrome);
    if (listLength <= room) {
      return { cap: listLength, height: listLength + chrome, scrolls: false };
    }
    return { cap: room, height: room + chrome, scrolls: true };
  };
  const modelsList = popupList(input.modelsCount, MODELS_CHROME_H);
  const themeList = popupList(input.themesCount, THEME_CHROME_H);
  const settingsList = popupList(SETTINGS_ROWS, SETTINGS_CHROME_H);
  // /login's second stage fetches its model list, so the two scroll-notice
  // rows are baked into its chrome (LOGIN_CHROME_H) rather than derived —
  // which means it sizes itself through the very same helper as the others
  // (an earlier hand-rolled copy could disagree with `modalH`).
  const loginList = popupList(input.providersCount, LOGIN_CHROME_H);
  const modalH =
    input.modal === 'login'
      ? loginList.height
      : input.modal === 'models'
        ? modelsList.height
        : input.modal === 'settings'
          ? settingsList.height
          : input.modal === 'theme'
            ? themeList.height
            : 0;
  const promptH = input.modal !== null ? modalH : PROMPT_H;

  const messageHeight = Math.max(
    MIN_MESSAGE_H,
    rows -
      HEADROOM -
      bannerH -
      STATUS_H -
      promptH -
      slashMenuH -
      slashGapH -
      todoH -
      approvalH -
      queueH,
  );

  // What the render tree actually occupies: banner + message pane + the
  // bottom stack (tasks, slash menu, queue, approval, prompt-or-popup) +
  // status bar.
  const totalHeight =
    bannerH +
    messageHeight +
    todoH +
    slashMenuH +
    slashGapH +
    queueH +
    approvalH +
    promptH +
    STATUS_H;

  return {
    bannerH,
    todoH,
    todoMaxRows,
    approvalH,
    queueH,
    fixedChrome,
    modalBudget,
    menuBudget,
    slashRowCap,
    slashMenuH,
    slashGapH,
    promptH,
    modalH,
    messageHeight,
    modelsList,
    themeList,
    settingsList,
    loginList,
    totalHeight,
    spare: rows - totalHeight,
    fits: totalHeight < rows,
  };
}
