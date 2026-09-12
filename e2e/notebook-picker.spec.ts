import { test, expect, Page, Frame } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import { agendaPanel, createNotebook, waitForPanelTodo, PANEL_REFRESH_TIMEOUT } from './helpers';

/**
 * Real-app cover for Cockpit's notebook picker DIALOG (desktop).
 *
 * The dialog used to hold a native `<select name="folderId">`. On a vault with a hundred notebooks that cost it
 * two things: the open popup is a platform window, so its scrollbar stayed white over a dark theme and no
 * stylesheet could reach it, and there was no way to narrow the list. It is now a list Cockpit draws and themes
 * itself - `.picker-row` divs inside `.picker-list`, a `.picker-filter` box pinned above them, and a hidden
 * `folderId` input that carries the answer back as `formData.picker.folderId`.
 *
 * The harness pins the markup the plugin emits and unit-tests the pure filter/keyboard model; what it cannot do
 * is run the dialog's script. That is what this file is for: the box really narrows the rows in a real Joplin
 * dialog webview, and the row that is clicked really is the notebook the new to-do lands in.
 *
 * The route in is the panel's own "New to-do" button with the panel on "All notebooks" (Cockpit's default), which
 * is the flow that has no notebook of its own and therefore asks.
 */
test.describe('Notebook picker dialog (desktop)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const alpha = 'Picker Alpha';
  const beta = 'Picker Beta';
  const created = `pick-todo-${stamp}`;
  const enterCreated = `pick-enter-${stamp}`;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    const { win } = joplin;
    // Two notebooks whose paths differ in one word, so filtering on that word is a real narrowing. Beta FIRST,
    // so the notebook Joplin ends up showing - and therefore the row the picker pre-selects - is Alpha: picking
    // Beta below is then a genuine change, not the default answered by accident.
    await createNotebook(win, beta);
    await createNotebook(win, alpha);
    // The panel is left on "All notebooks" (Cockpit's default): that is precisely what makes the create ask.
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  /**
   * The iframe hosting the picker dialog, identified by its filter box plus the hidden input that carries the
   * answer back. Both are Cockpit's own markup, so neither can be confused with another plugin's dialog.
   */
  async function pickerFrame(win: Page): Promise<Frame> {
    const isPicker = async (frame: Frame) =>
      (await frame.locator('.picker-filter').count().catch(() => 0)) > 0 &&
      (await frame.locator('input[name="folderId"]').count().catch(() => 0)) > 0;
    const has = async () => {
      for (const frame of win.frames()) if (await isPicker(frame)) return true;
      return false;
    };
    await expect.poll(has, { timeout: 30_000 }).toBe(true);
    for (const frame of win.frames()) if (await isPicker(frame)) return frame;
    throw new Error('notebook picker dialog not found');
  }

  /** Whether any frame is still showing the picker dialog. A closed Joplin dialog unmounts its webview. */
  async function pickerIsOpen(win: Page): Promise<boolean> {
    for (const frame of win.frames()) {
      if (await frame.locator('.picker-filter').count().catch(() => 0)) return true;
    }
    return false;
  }

  /** Click the panel's "New to-do" button and wait for the picker dialog it opens. */
  async function openPickerFromNewTodo(win: Page): Promise<Frame> {
    const panel = await agendaPanel(win);
    await panel.locator('#profileControls button[title="New to-do"]').click();
    return pickerFrame(win);
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

  test('the picker opens with a filter box and a drawn row for every notebook', async () => {
    const { win } = joplin;
    const picker = await openPickerFromNewTodo(win);

    await expect(picker.locator('.picker-filter')).toBeVisible();
    // The native dropdown this replaced must be gone - it is the whole reason for the rework.
    expect(await picker.locator('select[name="folderId"]').count()).toBe(0);

    const rows = picker.locator('.picker-row:not([hidden])');
    await expect(rows).toHaveCount(2, { timeout: 10_000 });
    await expect(rows.filter({ hasText: alpha })).toHaveCount(1);
    await expect(rows.filter({ hasText: beta })).toHaveCount(1);

    // The notebook the app is showing starts selected, so a bare OK commits it without any further input.
    await expect(picker.locator('.picker-row.-selected')).toHaveText(alpha);

    await win.locator('button:has-text("Cancel")').last().click();
  });

  test('typing in the filter narrows the list to the matching notebook', async () => {
    const { win } = joplin;
    const picker = await openPickerFromNewTodo(win);

    await picker.locator('.picker-filter').fill('beta');

    // Case-insensitive substring of the full path: "Picker Beta" survives, "Picker Alpha" does not.
    const visible = picker.locator('.picker-row:not([hidden])');
    await expect(visible).toHaveCount(1, { timeout: 10_000 });
    await expect(visible.first()).toHaveText(beta);
    // The narrowed-away row is still in the document, just hidden - the filter shows and hides, it never rebuilds.
    await expect(picker.locator('.picker-row')).toHaveCount(2);

    await win.locator('button:has-text("Cancel")').last().click();
  });

  test('the new to-do is created in the notebook picked in the dialog', async () => {
    const { win } = joplin;
    const picker = await openPickerFromNewTodo(win);

    await picker.locator('.picker-filter').fill('beta');
    const visible = picker.locator('.picker-row:not([hidden])');
    await expect(visible).toHaveCount(1, { timeout: 10_000 });
    await visible.first().click();
    await win.locator('button:has-text("OK")').last().click();

    // Cockpit creates the to-do and opens it, with focus in the title field - so the title can simply be typed,
    // exactly as the createTodo helper does after Joplin's own "New to-do".
    await win.waitForTimeout(1500);
    await win.keyboard.type(created);
    await win.waitForTimeout(1500);

    await waitForPanelTodo(win, created);
    await expect
      .poll(async () => notebookOf(win, created), { timeout: PANEL_REFRESH_TIMEOUT, intervals: [1500, 2500, 4000] })
      .toBe(beta);
  });

  /**
   * The keyboard route, which is the one a vault with a hundred notebooks actually uses: type a few letters and
   * press Enter, without touching the list or the OK button.
   *
   * It also covers the two things that make that route correct. The picker pre-selects the notebook the app is
   * showing, so the case types the OTHER notebook: that HIDES the pre-selection, and the selection has to follow
   * the filter or Enter would commit a notebook that is no longer on screen. Which notebook is pre-selected is
   * read from the dialog rather than assumed, because a retry runs in a fresh worker whose beforeAll leaves the
   * app on a different notebook than the case above does. And Enter must accept the dialog exactly once: Joplin
   * answers a submit inside the dialog document with the OK button, so a second submit (the browser's own
   * implicit one) would close it twice over.
   */
  test('typing and pressing Enter picks the typed notebook and accepts the dialog', async () => {
    const { win } = joplin;
    const picker = await openPickerFromNewTodo(win);

    // The pre-selection is whatever notebook the app is showing; the case types the other one, so the typed
    // filter always hides the pre-selected row.
    const preselected = ((await picker.locator('.picker-row.-selected').textContent()) || '').trim();
    expect([alpha, beta]).toContain(preselected);
    const target = preselected === alpha ? beta : alpha;

    await picker.locator('.picker-filter').fill(target === alpha ? 'alp' : 'bet');
    const visible = picker.locator('.picker-row:not([hidden])');
    await expect(visible).toHaveCount(1, { timeout: 10_000 });
    // The selection followed the filter: it is on the one row still showing, not on the hidden pre-selection.
    await expect(picker.locator('.picker-row.-selected')).toHaveText(target);

    await picker.locator('.picker-filter').press('Enter');

    // Accepted, and gone - no click on a row, no click on OK.
    await expect.poll(async () => pickerIsOpen(win), { timeout: 20_000 }).toBe(false);

    await win.waitForTimeout(1500);
    await win.keyboard.type(enterCreated);
    await win.waitForTimeout(1500);

    await waitForPanelTodo(win, enterCreated);
    await expect
      .poll(async () => notebookOf(win, enterCreated), { timeout: PANEL_REFRESH_TIMEOUT, intervals: [1500, 2500, 4000] })
      .toBe(target);
  });
});
