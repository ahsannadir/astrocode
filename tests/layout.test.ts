/**
 * Height-budget tests for the TUI frame (src/tui/layout.ts).
 *
 * Ink's onRender takes a direct-write path whenever the rendered frame is
 * >= stdout.rows:
 *
 *     stdout.write(clearTerminal + fullStaticOutput + output)
 *
 * That path bypasses log-update's state, so the next frame — identical to
 * what log-update believes is on screen — emits zero bytes and the UI sits
 * frozen until some later frame differs. That is the Esc-in-/settings freeze:
 * only the WIDTH is set on Ink's root Yoga node, so the frame height is
 * exactly what these components add up to.
 *
 * The invariant under test is therefore:
 *
 *     computeLayout(state).totalHeight < state.rows
 *
 * for every terminal size and every popup/menu/panel combination. Pure
 * arithmetic, so this runs in milliseconds with no terminal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLayout,
  scrollWindow,
  todoPanelHeight,
  popupMinHeight,
  MIN_SUPPORTED_ROWS,
  BANNER_H,
  BANNER_COMPACT_H,
  STATUS_H,
  PROMPT_H,
  APPROVAL_H,
  MIN_MESSAGE_H,
  HEADROOM,
  SETTINGS_ROWS,
  SCROLL_NOTICE_H,
  POPUP_CHROME_H,
  type LayoutInput,
  type PopupKind,
} from '../src/tui/layout.js';

const POPUPS: (PopupKind | null)[] = [null, 'login', 'models', 'settings', 'theme'];

/** Realistic + adversarial list lengths: OpenRouter's catalog is huge. */
const MODELS_COUNTS = [0, 1, 3, 12, 40, 400];
const THEME_COUNTS = [1, 12];
const PROVIDER_COUNTS = [1, 8];

/** Task-panel sizes around the trim threshold, plus the empty case. */
const TODO_COUNTS = [0, 1, 5, 6, 7, 20];
const QUEUE_LENGTHS = [0, 1, 5];
const SLASH_MATCH_COUNTS = [0, 1, 3, 8, 40];

/** Terminal heights to sweep: sub-minimum through a very tall window. */
const ROWS = Array.from({ length: 121 }, (_, i) => i + 1);

function describeState(s: LayoutInput): string {
  return (
    `rows=${s.rows} modal=${s.modal} slash=${s.slashActive}(${s.slashMatches}) ` +
    `todos=${s.todoCount} approval=${s.approvalPending} queue=${s.queueLength} ` +
    `models=${s.modelsCount} themes=${s.themesCount} providers=${s.providersCount}`
  );
}

test('frame height stays strictly below the terminal row count in every state', () => {
  const failures: string[] = [];
  let checked = 0;
  for (const rows of ROWS) {
    if (rows < MIN_SUPPORTED_ROWS) continue;
    for (const modal of POPUPS) {
      for (const slashActive of [false, true]) {
        for (const slashMatches of SLASH_MATCH_COUNTS) {
          for (const todoCount of TODO_COUNTS) {
            for (const approvalPending of [false, true]) {
              for (const queueLength of QUEUE_LENGTHS) {
                for (const modelsCount of MODELS_COUNTS) {
                  const state: LayoutInput = {
                    rows,
                    modal,
                    slashActive,
                    slashMatches,
                    todoCount,
                    approvalPending,
                    queueLength,
                    modelsCount,
                    themesCount: THEME_COUNTS[THEME_COUNTS.length - 1],
                    providersCount: PROVIDER_COUNTS[PROVIDER_COUNTS.length - 1],
                  };
                  const l = computeLayout(state);
                  checked++;
                  // The one row that matters: >= rows would hit the
                  // direct-write path and freeze the next identical frame.
                  if (!l.fits) {
                    failures.push(
                      `${describeState(state)} → totalHeight=${l.totalHeight} ` +
                        `(over by ${l.totalHeight - rows})`,
                    );
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 100_000, `expected a broad sweep, only checked ${checked}`);
  assert.deepEqual(failures.slice(0, 10), [], `${failures.length} states overflow`);
});

test('the sweep really is exhaustive over sizes and popup kinds', () => {
  // Guards the loop above against silently skipping a dimension.
  assert.ok(ROWS.filter((r) => r >= MIN_SUPPORTED_ROWS).length > 90);
  assert.equal(POPUPS.length, 5);
  assert.ok(MODELS_COUNTS.includes(400), 'must cover a very long model list');
});

test('sub-minimum terminals degrade instead of producing nonsense rows', () => {
  for (let rows = 1; rows < MIN_SUPPORTED_ROWS; rows++) {
    for (const modal of POPUPS) {
      const l = computeLayout({
        rows,
        modal,
        slashActive: true,
        slashMatches: 40,
        todoCount: 20,
        approvalPending: true,
        queueLength: 5,
        modelsCount: 400,
        themesCount: 12,
        providersCount: 8,
      });
      // Every reservation must stay finite and non-negative — the layout may
      // overflow a terminal too small to host the chrome, but it must remain
      // coherent rather than producing negative or NaN row counts.
      // `spare` is the exception: it is the overflow diagnostic itself, so a
      // negative value is exactly how a too-small terminal is reported.
      for (const [name, value] of Object.entries(l)) {
        if (typeof value !== 'number') continue;
        assert.ok(Number.isFinite(value), `${name} not finite at rows=${rows}: ${value}`);
        if (name === 'spare' || name === 'totalHeight') continue;
        assert.ok(value >= 0, `${name} negative at rows=${rows}: ${value}`);
      }
      assert.ok(l.messageHeight >= MIN_MESSAGE_H);
      // The task panel must disappear rather than go negative.
      assert.ok(l.todoMaxRows >= 0);
      // Every popup still gets at least one row.
      assert.ok(l.modelsList.cap >= 1 && l.themeList.cap >= 1 && l.settingsList.cap >= 1);
    }
  }
});

test('MIN_SUPPORTED_ROWS is the measured threshold, not a guess', () => {
  // Find the smallest height at which EVERY state fits. The constant must
  // equal it: if this shifts, the comment on MIN_SUPPORTED_ROWS needs
  // updating, because the guarantee would no longer be the measured floor.
  let smallestFitting = Infinity;
  for (let rows = 1; rows <= 80; rows++) {
    let allFit = true;
    for (const modal of POPUPS) {
      for (const approvalPending of [false, true]) {
        for (const queueLength of QUEUE_LENGTHS) {
          for (const todoCount of TODO_COUNTS) {
            const l = computeLayout({
              rows,
              modal,
              slashActive: true,
              slashMatches: 40,
              todoCount,
              approvalPending,
              queueLength,
              modelsCount: 400,
              themesCount: 12,
              providersCount: 8,
            });
            if (!l.fits) allFit = false;
          }
        }
      }
    }
    if (allFit) {
      smallestFitting = rows;
      break;
    }
  }
  assert.equal(MIN_SUPPORTED_ROWS, smallestFitting);
  // And it must actually be the boundary, not merely sufficient.
  const below = computeLayout({
    rows: MIN_SUPPORTED_ROWS - 1,
    modal: 'login',
    slashActive: false,
    slashMatches: 0,
    todoCount: 0,
    approvalPending: true,
    queueLength: 1,
    modelsCount: 400,
    themesCount: 12,
    providersCount: 8,
  });
  assert.equal(below.fits, false, 'one row below the floor must not claim to fit');
});

test('a popup never reserves more than the modal budget', () => {
  // The settings menu used to hardcode its height at 12 rows regardless of the
  // budget, which put frames straight onto the direct-write path.
  for (let rows = MIN_SUPPORTED_ROWS; rows <= 120; rows++) {
    for (const modal of ['login', 'models', 'settings', 'theme'] as PopupKind[]) {
      const l = computeLayout({
        rows,
        modal,
        slashActive: false,
        slashMatches: 0,
        todoCount: 0,
        approvalPending: false,
        queueLength: 0,
        modelsCount: 400,
        themesCount: 12,
        providersCount: 8,
      });
      // The reservation the frame spends must be exactly the popup's own
      // list + chrome — a second, hand-rolled height formula here is exactly
      // how /settings ended up reserving 12 rows while rendering 13.
      const list =
        modal === 'login'
          ? l.loginList
          : modal === 'models'
            ? l.modelsList
            : modal === 'settings'
              ? l.settingsList
              : l.themeList;
      assert.equal(l.modalH, list.height, `${modal} reservation drifted from its list`);
      assert.ok(l.modalH >= popupMinHeight(modal), `${modal} shrank below its chrome`);
      assert.ok(l.promptH === l.modalH);
    }
  }
});

test('settings budget tracks its real row count, windowed like every other popup', () => {
  const l = computeLayout({
    rows: 40,
    modal: 'settings',
    slashActive: false,
    slashMatches: 0,
    todoCount: 0,
    approvalPending: false,
    queueLength: 0,
    modelsCount: 10,
    themesCount: 12,
    providersCount: 8,
  });
  // Room to spare → the whole menu, at its true height (chrome + 8 rows).
  assert.equal(l.settingsList.cap, SETTINGS_ROWS);
  assert.equal(l.settingsList.height, SETTINGS_ROWS + POPUP_CHROME_H.settings);
  assert.equal(l.modalH, SETTINGS_ROWS + POPUP_CHROME_H.settings);

  // Squeezed → the list is windowed and stays inside the budget.
  const tight = computeLayout({
    rows: MIN_SUPPORTED_ROWS,
    modal: 'settings',
    slashActive: false,
    slashMatches: 0,
    todoCount: 0,
    approvalPending: true,
    queueLength: 1,
    modelsCount: 10,
    themesCount: 12,
    providersCount: 8,
  });
  assert.ok(tight.settingsList.scrolls, 'settings should window when squeezed');
  assert.ok(tight.settingsList.cap < SETTINGS_ROWS);
  assert.ok(tight.settingsList.height <= tight.modalBudget);
});

test('the task panel yields rows to the active overlay', () => {
  const base = {
    slashActive: false,
    slashMatches: 0,
    todoCount: 20,
    approvalPending: false,
    queueLength: 0,
    modelsCount: 10,
    themesCount: 12,
    providersCount: 8,
  };
  const roomy = computeLayout({ ...base, rows: 60, modal: null });
  const squeezed = computeLayout({ ...base, rows: 30, modal: null });
  assert.ok(roomy.todoH >= squeezed.todoH, 'panel should shrink on a shorter terminal');
  assert.ok(
    squeezed.todoH === todoPanelHeight(20, squeezed.todoMaxRows),
    'granted height must match what the panel will render',
  );

  // No room at all → the panel is suppressed rather than pushing the frame over.
  const crushed = computeLayout({ ...base, rows: MIN_SUPPORTED_ROWS, modal: 'login' });
  assert.ok(crushed.todoMaxRows >= 0);
  assert.ok(crushed.fits);
});

test('a popup supersedes the slash menu and an approval prompt', () => {
  // The menu belongs to the prompt box; neither a popup nor a blocking
  // approval leaves room for it underneath.
  const both = computeLayout({
    rows: 40,
    modal: 'theme',
    slashActive: true,
    slashMatches: 10,
    todoCount: 0,
    approvalPending: false,
    queueLength: 0,
    modelsCount: 10,
    themesCount: 12,
    providersCount: 8,
  });
  assert.equal(both.slashMenuH, 0);
  assert.equal(both.slashGapH, 0);

  const approval = computeLayout({
    rows: 40,
    modal: null,
    slashActive: true,
    slashMatches: 10,
    todoCount: 0,
    approvalPending: true,
    queueLength: 0,
    modelsCount: 10,
    themesCount: 12,
    providersCount: 8,
  });
  assert.equal(approval.slashMenuH, 0);
});

test('the banner falls back to the compact header whenever the art does not fit', () => {
  const compact = computeLayout({
    rows: MIN_SUPPORTED_ROWS,
    modal: 'login',
    slashActive: false,
    slashMatches: 0,
    todoCount: 0,
    approvalPending: true,
    queueLength: 1,
    modelsCount: 400,
    themesCount: 12,
    providersCount: 8,
  });
  assert.equal(compact.bannerH, BANNER_COMPACT_H);
  assert.ok(compact.fits);

  // A tall, empty terminal gets the full art block.
  const full = computeLayout({
    rows: 60,
    modal: null,
    slashActive: false,
    slashMatches: 0,
    todoCount: 0,
    approvalPending: false,
    queueLength: 0,
    modelsCount: 10,
    themesCount: 12,
    providersCount: 8,
  });
  assert.equal(full.bannerH, BANNER_H);
  assert.ok(full.fits);
});

test('banner choice is monotonic in terminal height', () => {
  // A fixed row threshold used to create a cliff: the art block grew at 26
  // rows and pushed an approval prompt plus a popup off the bottom, so
  // 23-25-row terminals fitted while 26-27-row ones did not. The banner may
  // now only GROW as the terminal grows, and only while the frame still fits.
  let previous = BANNER_COMPACT_H;
  for (let rows = MIN_SUPPORTED_ROWS; rows <= 120; rows++) {
    const l = computeLayout({
      rows,
      modal: 'login',
      slashActive: false,
      slashMatches: 0,
      todoCount: 20,
      approvalPending: true,
      queueLength: 1,
      modelsCount: 400,
      themesCount: 12,
      providersCount: 8,
    });
    assert.ok(l.fits, `rows=${rows} overflowed`);
    assert.ok(l.bannerH >= previous, `banner shrank at rows=${rows}`);
    assert.ok(
      l.bannerH === BANNER_H || l.bannerH === BANNER_COMPACT_H,
      `banner must be one of the two sizes, got ${l.bannerH}`,
    );
    previous = l.bannerH;
  }
  // And on a tall, quiet terminal it does reach the full art block.
  assert.equal(previous, BANNER_H);
});

test('the message pane never drops below its floor', () => {
  for (let rows = MIN_SUPPORTED_ROWS; rows <= 120; rows++) {
    for (const modal of POPUPS) {
      const l = computeLayout({
        rows,
        modal,
        slashActive: true,
        slashMatches: 40,
        todoCount: 20,
        approvalPending: true,
        queueLength: 3,
        modelsCount: 400,
        themesCount: 12,
        providersCount: 8,
      });
      assert.ok(l.messageHeight >= MIN_MESSAGE_H);
      // MessageArea renders inside the border, so it needs the pane minus 2.
      assert.ok(l.messageHeight - 2 >= 1);
    }
  }
});

test('headroom is what keeps us off the direct-write path', () => {
  // Sanity-check the constant the whole module exists for: a frame exactly
  // `rows` tall is the failure, one shorter is the fix.
  assert.equal(HEADROOM, 1);
  const l = computeLayout({
    rows: 32,
    modal: 'theme',
    slashActive: false,
    slashMatches: 0,
    todoCount: 0,
    approvalPending: false,
    queueLength: 0,
    modelsCount: 10,
    themesCount: 12,
    providersCount: 8,
  });
  assert.ok(l.totalHeight < 32);
  assert.ok(l.spare >= 1);
});

test('totalHeight matches the sum of the rendered blocks', () => {
  // Guards against the reported total drifting from what the render tree
  // actually spends — that drift is what hid the original bug.
  for (let rows = MIN_SUPPORTED_ROWS; rows <= 80; rows++) {
    for (const modal of POPUPS) {
      const l = computeLayout({
        rows,
        modal,
        slashActive: true,
        slashMatches: 12,
        todoCount: 4,
        approvalPending: true,
        queueLength: 2,
        modelsCount: 30,
        themesCount: 12,
        providersCount: 8,
      });
      const sum =
        l.bannerH + // <Box height={bannerH}>
        l.messageHeight + // bordered message pane
        (l.todoMaxRows > 0 ? todoPanelHeight(4, l.todoMaxRows) : 0) +
        l.slashMenuH +
        l.slashGapH +
        l.queueH +
        l.approvalH +
        l.promptH + // prompt box OR popup
        STATUS_H;
      assert.equal(l.totalHeight, sum, `mismatch at rows=${rows} modal=${modal}`);
    }
  }
});

test('prompt and status bars keep their reserved heights', () => {
  const l = computeLayout({
    rows: 32,
    modal: null,
    slashActive: false,
    slashMatches: 0,
    todoCount: 0,
    approvalPending: false,
    queueLength: 0,
    modelsCount: 10,
    themesCount: 12,
    providersCount: 8,
  });
  assert.equal(l.promptH, PROMPT_H);
  assert.equal(l.approvalH, 0);
  const withApproval = computeLayout({
    rows: 32,
    modal: null,
    slashActive: false,
    slashMatches: 0,
    todoCount: 0,
    approvalPending: true,
    queueLength: 0,
    modelsCount: 10,
    themesCount: 12,
    providersCount: 8,
  });
  assert.equal(withApproval.approvalH, APPROVAL_H);
});

test('scrollWindow keeps the list inside its row budget, notices included', () => {
  for (const listLength of [0, 1, 2, 5, 8, 12, 40, 400]) {
    for (const maxRows of [1, 2, 3, 4, 8, 20]) {
      for (const sel of [0, 1, 3, listLength - 1, listLength, listLength + 5]) {
        if (sel < 0) continue;
        const w = scrollWindow(listLength, sel, maxRows);
        assert.ok(w.rows <= Math.max(1, maxRows), `${w.rows} rows for budget ${maxRows}`);
        assert.ok(w.count >= 1);
        assert.ok(w.start >= 0);
        assert.ok(w.start + w.count <= Math.max(listLength, w.count));
        // Whatever is hidden must be announced by a notice, or the user has
        // no idea there are more entries. A budget too small to cover an entry
        // plus both notices drops the notices instead (overflowing the
        // reservation would put the frame on Ink's direct-write path), so the
        // guarantee only holds once the budget affords them.
        if (listLength > w.count && maxRows >= 1 + SCROLL_NOTICE_H) {
          assert.ok(
            w.hasMoreUp || w.hasMoreDown,
            `list=${listLength} sel=${sel} budget=${maxRows} hid ${listLength - w.count} entries silently`,
          );
        }
      }
    }
  }
});

test('scrollWindow never outgrows its budget, whatever the selection', () => {
  // Height may shrink as the selection approaches an end of the list (one
  // notice disappears), but it must NEVER exceed the reserved cap — that is
  // what would push the frame onto Ink's direct-write path.
  for (const listLength of [3, 12, 40, 400]) {
    for (const maxRows of [1, 2, 3, 4, 8, 20]) {
      for (let sel = 0; sel < listLength; sel++) {
        const w = scrollWindow(listLength, sel, maxRows);
        assert.ok(
          w.rows <= Math.max(1, maxRows),
          `list=${listLength} sel=${sel} budget=${maxRows} rendered ${w.rows} rows`,
        );
      }
    }
  }
});

test('scrollWindow never hides the selected entry', () => {
  for (const listLength of [12, 40, 400]) {
    for (const maxRows of [1, 3, 8]) {
      for (let sel = 0; sel < listLength; sel++) {
        const w = scrollWindow(listLength, sel, maxRows);
        assert.ok(
          sel >= w.start && sel < w.start + w.count,
          `sel=${sel} outside window [${w.start}, ${w.start + w.count})`,
        );
      }
    }
  }
});

test('a scrolling list reserves room for both notices', () => {
  // Both notices are charged whenever the list is trimmed, not just the side
  // currently in view — otherwise a reservation would be wrong half the time.
  const w = scrollWindow(40, 20, 5);
  assert.equal(w.count, 5 - SCROLL_NOTICE_H);
  assert.equal(w.rows, w.count + SCROLL_NOTICE_H);
  assert.equal(w.hasMoreUp, true);
  assert.equal(w.hasMoreDown, true);
});

test('a list that fits gets no notices and its full height', () => {
  const w = scrollWindow(4, 0, 8);
  assert.equal(w.count, 4);
  assert.equal(w.rows, 4);
  assert.equal(w.hasMoreUp, false);
  assert.equal(w.hasMoreDown, false);
});

test('todoPanelHeight matches what TodoPanel renders', () => {
  assert.equal(todoPanelHeight(0), 0);
  // borders(2) + header(1) + entries, plus a trim notice past the cap.
  assert.equal(todoPanelHeight(1), 4);
  assert.equal(todoPanelHeight(3), 6);
  for (const count of [0, 1, 5, 6, 7, 20]) {
    for (const maxRows of [1, 2, 6]) {
      const h = todoPanelHeight(count, maxRows);
      const visible = Math.min(count, maxRows);
      assert.equal(h, count === 0 ? 0 : visible + 3 + (count > maxRows ? 1 : 0));
    }
  }
});

test('every popup can shrink to a single row without exceeding its budget', () => {
  for (let rows = MIN_SUPPORTED_ROWS; rows <= 80; rows++) {
    for (const modal of ['login', 'models', 'settings', 'theme'] as PopupKind[]) {
      const l = computeLayout({
        rows,
        modal,
        slashActive: false,
        slashMatches: 0,
        todoCount: 0,
        approvalPending: true,
        queueLength: 1,
        modelsCount: 400,
        themesCount: 12,
        providersCount: 8,
      });
      const list =
        modal === 'login'
          ? l.loginList
          : modal === 'models'
            ? l.modelsList
            : modal === 'settings'
              ? l.settingsList
              : l.themeList;
      assert.ok(list.cap >= 1, `${modal} has no room for a row at rows=${rows}`);
      assert.ok(
        list.height <= l.modalBudget || list.height <= popupMinHeight(modal),
        `${modal} reserved ${list.height} > budget ${l.modalBudget} at rows=${rows}`,
      );
    }
  }
});

test('the layout is pure — same input, same output', () => {
  const state: LayoutInput = {
    rows: 33,
    modal: 'models',
    slashActive: false,
    slashMatches: 0,
    todoCount: 7,
    approvalPending: true,
    queueLength: 2,
    modelsCount: 137,
    themesCount: 12,
    providersCount: 8,
  };
  assert.deepEqual(computeLayout(state), computeLayout(state));
  assert.deepEqual(computeLayout({ ...state }), computeLayout(state));
});
