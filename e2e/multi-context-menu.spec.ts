import { test, expect, Page, Frame } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  agendaPanel,
  createNotebook,
  createTodo,
  setAlarm,
  waitForPanelTodo,
  waitForPanelTodoGone,
  panelTodoTitles,
  PANEL_REFRESH_TIMEOUT,
} from './helpers';

/**
 * Real-app cover for the multi-select note context menu (desktop).
 *
 * The bug: Cockpit draws its own row context menu (Joplin's native one is unreachable from a plugin webview).
 * With SEVERAL rows Ctrl/Shift-selected the menu still acted on ONE note. The fix makes every action that CAN
 * apply to many act on the WHOLE selection (greying out the single-only ones), so a batch is done in one go.
 *
 * These specs drive the panel's REAL handlers deterministically: a plain mousedown to seed the selection then
 * Ctrl-mousedowns to extend it (exactly what onTodoRowMouseDown consumes), a contextmenu event to open the
 * menu Cockpit builds (#noteContextMenu on the panel body), and a click on the chosen item - the same path a
 * user's right-click-then-click takes. The two capable actions the owner asked to prove are exercised end to
 * end against genuine Joplin: multi-delete (both gone, the third intact) and multi-move (both re-parented).
 */
test.describe('Multi-select context menu (desktop)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const source = `Cockpit MMenu ${stamp}`;
  const dest = `Cockpit MDest ${stamp}`;

  // Delete fixtures: select A+B, delete, C must remain.
  const DA = `mm-del-A-${stamp}`;
  const DB = `mm-del-B-${stamp}`;
  const DC = `mm-del-C-${stamp}`;
  // Move fixtures: select both, move to `dest`.
  const MA = `mm-move-A-${stamp}`;
  const MB = `mm-move-B-${stamp}`;

  // A local Date today at HH:00 - any clock time today lands the to-do in the "Today" group, so it is visible.
  const todayAt = (hour: number) => {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    return d;
  };

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    const { win } = joplin;
    // The destination notebook first, so it exists as an option in the notebook picker.
    await createNotebook(win, dest);
    // The source notebook holds every fixture to-do (createTodo creates in the active notebook).
    await createNotebook(win, source);
    for (const [title, hour] of [
      [DA, 8], [DB, 9], [DC, 10], [MA, 11], [MB, 12],
    ] as [string, number][]) {
      await createTodo(win, title);
      await setAlarm(win, todayAt(hour));
    }
    await waitForPanelTodo(win, DA);
    await waitForPanelTodo(win, MB);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  /**
   * Build a fresh multi-selection over `markers` (a plain press on the first row clears any stale selection and
   * selects it, Ctrl-presses on the rest extend it - the file-manager rule) and open Cockpit's context menu on
   * the LAST selected row. Returns the menu's item labels and which actions render disabled, for assertions.
   */
  async function multiSelectAndOpenMenu(
    markers: string[]
  ): Promise<{ labels: string[]; disabled: string[] }> {
    const panel = await agendaPanel(joplin.win);
    return panel.evaluate((mk) => {
      const rowByMarker = (m: string) =>
        (Array.from(document.querySelectorAll('.todo[data-todo-id]')) as HTMLElement[]).find(
          (r) => (r.textContent || '').includes(m)
        );
      let last: HTMLElement | null = null;
      mk.forEach((m, index) => {
        const row = rowByMarker(m)!;
        // The first press is plain (clears any leftover selection from a previous test and selects this row);
        // the rest are Ctrl-presses that add to the set.
        row.dispatchEvent(new MouseEvent('mousedown', { button: 0, ctrlKey: index > 0, bubbles: true }));
        last = row;
      });
      // A contextmenu on the last selected row opens the menu (onTodoContextMenu -> showNoteContextMenu).
      last!.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true }));
      const menu = document.getElementById('noteContextMenu')!;
      const buttons = Array.from(menu.querySelectorAll('.context-menu-item')) as HTMLElement[];
      return {
        labels: buttons.map((b) => (b.textContent || '').trim()),
        disabled: buttons
          .filter((b) => b.classList.contains('-disabled'))
          .map((b) => b.dataset.action || ''),
      };
    }, markers);
  }

  /** Click the open context menu's item whose data-action matches (the menu persists across evaluate calls). */
  async function clickMenuAction(action: string): Promise<void> {
    const panel = await agendaPanel(joplin.win);
    await panel.evaluate((a) => {
      const menu = document.getElementById('noteContextMenu')!;
      const button = menu.querySelector(`.context-menu-item[data-action="${a}"]`) as HTMLElement;
      button.click();
    }, action);
  }

  /** The notebook title shown on a to-do row's notebook pill, or null. */
  async function notebookOf(win: Page, marker: string): Promise<string | null> {
    const panel = await agendaPanel(win);
    return panel.evaluate((m) => {
      const rows = Array.from(document.querySelectorAll('.todo[data-todo-id]')) as HTMLElement[];
      const row = rows.find((r) => (r.textContent || '').includes(m));
      if (!row) return null;
      const pill = row.querySelector('.todo-notebook');
      return pill ? (pill.textContent || '').trim() : null;
    }, marker);
  }

  /** The iframe hosting Cockpit's notebook picker dialog, identified by its folderId select. */
  async function notebookPickerFrame(win: Page): Promise<Frame> {
    const has = async () => {
      for (const frame of win.frames()) {
        if (await frame.locator('select[name="folderId"]').count().catch(() => 0)) return true;
      }
      return false;
    };
    await expect.poll(has, { timeout: 30_000 }).toBe(true);
    for (const frame of win.frames()) {
      if (await frame.locator('select[name="folderId"]').count().catch(() => 0)) return frame;
    }
    throw new Error('notebook picker dialog not found');
  }

  /**
   * Outside dismissal. The menu is drawn by Cockpit, so it is not dismissed by the window manager the way a native
   * menu is - and the panel is an IFRAME, so a click in the main editor never reaches the panel's document. It used
   * to stay open on top of the editor. It now closes on the panel window's own blur and on a press anywhere in the
   * main window (panelWebview.js). Driven with REAL input on both ends: a right click on a row opens the menu, a
   * click on Joplin's note title field - in the main window, outside the panel iframe - must close it.
   *
   * Declared FIRST in this file so it runs against the intact fixtures: the specs below delete and move to-dos, and
   * a moved note leaves the selected notebook's list, which can leave the editor showing no note (and no title field).
   */
  test('a click outside the panel closes the custom context menu', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    const title = panel.locator('.todo[data-todo-id]', { hasText: DC }).first().locator('.todo-title');
    await title.scrollIntoViewIfNeeded();
    await title.click({ button: 'right' });
    await expect(panel.locator('#noteContextMenu')).toHaveCount(1);

    await win.locator('input.title-input').click();
    await expect
      .poll(async () => panel.locator('#noteContextMenu').count(), { timeout: 15_000 })
      .toBe(0);
  });

  test('deleting a multi-selection removes every selected to-do, leaving the unselected one', async () => {
    const { win } = joplin;
    const menu = await multiSelectAndOpenMenu([DA, DB]);
    // The menu counts the selection and greys out the single-only Open (shown, not hidden).
    expect(menu.labels).toContain('Delete 2 notes');
    expect(menu.disabled).toContain('open');

    await clickMenuAction('delete');

    // Both selected to-dos leave the panel (they went to the trash); the third, unselected one stays.
    await waitForPanelTodoGone(win, DA);
    await waitForPanelTodoGone(win, DB);
    expect((await panelTodoTitles(win)).some((t) => t.includes(DC))).toBe(true);
  });

  test('moving a multi-selection re-parents every selected to-do to the picked notebook', async () => {
    const { win } = joplin;
    // Precondition: both move fixtures start in the source notebook.
    expect(await notebookOf(win, MA)).toBe(source);
    expect(await notebookOf(win, MB)).toBe(source);

    const menu = await multiSelectAndOpenMenu([MA, MB]);
    expect(menu.labels).toContain('Move 2 to notebook...');

    await clickMenuAction('moveToFolder');

    // The move opens Cockpit's notebook picker (a plugin dialog webview): pick the destination and confirm.
    const picker = await notebookPickerFrame(win);
    await picker.locator('select[name="folderId"]').selectOption({ label: dest });
    await win.locator('button:has-text("OK")').last().click();

    // Both selected to-dos now live in the destination notebook (their row's notebook pill reads `dest`).
    await expect
      .poll(async () => notebookOf(win, MA), { timeout: PANEL_REFRESH_TIMEOUT, intervals: [1500, 2500, 4000] })
      .toBe(dest);
    await expect
      .poll(async () => notebookOf(win, MB), { timeout: PANEL_REFRESH_TIMEOUT, intervals: [1500, 2500, 4000] })
      .toBe(dest);
  });
});
