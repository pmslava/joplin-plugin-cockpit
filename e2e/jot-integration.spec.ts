import { test, expect, Page, Frame } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance, JOT_JPL } from './launch';
import {
  agendaPanel,
  createNote,
  createNotebook,
  createTodo,
  joplinMenuHasItem,
  selectedNoteId,
  setCockpitSetting,
  waitForPanelTodo,
  waitForPanelTodoGone,
  PANEL_REFRESH_TIMEOUT,
} from './helpers';

/**
 * Cockpit 2.8 calling Jot, in a real Joplin desktop with the released Jot plugin installed beside Cockpit the way a
 * user installs it (its .jpl in the profile's plugins folder; see launchJoplin's extraPlugins).
 *
 * Everything is driven from Cockpit's own panel with real input: a right-click on New to-do / New note (the
 * "right-click" setting's default is Jot), the row menu's Quick edit…, and a plain click on New note once the "click"
 * setting is switched to a new window through the Options screen, the only place that setting can be changed. Jot's
 * form is then answered as a user answers it - a title, then Enter - so what is proved is the whole round trip:
 * Cockpit's call reaches Jot with the right arguments (the form's heading, notebook and prefilled title show them),
 * Jot writes, and the row comes into the panel through the change feed Cockpit drains after Jot answers. The editor holds the plain note made last in beforeAll throughout; none of
 * these routes may move it, which is the point of Jot and of the new window alike.
 *
 * Jot's form is a plugin webview iframe (found by its #jotForm); its Create / Save / Cancel are Joplin's buttons in
 * the main window, and a closed dialog unmounts its iframe.
 */
test.describe('Calling Jot from the panel (desktop)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  // The notebook the panel gets filtered to. It holds the seeded to-do, and is NOT the one Joplin shows, so a form
  // that starts on it can only have been told to by Cockpit.
  const filteredBook = `Cockpit JotFiltered ${stamp}`;
  // Created last, so it is the notebook Joplin's sidebar shows: Jot's own default when Cockpit passes none.
  const shownBook = `Cockpit JotShown ${stamp}`;
  const seededTodo = `JotSeedTask${stamp}`;
  const plainNote = `JotPlainNote${stamp}`;
  let plainNoteId = '';

  test.beforeAll(async () => {
    joplin = await launchJoplin({ extraPlugins: [JOT_JPL] });
    const { win } = joplin;
    await createNotebook(win, filteredBook);
    await createTodo(win, seededTodo);
    await createNotebook(win, shownBook);
    plainNoteId = await createNote(win, plainNote); // made last => the editor's note for every case
    await waitForPanelTodo(win, seededTodo);
    // Jot must be running before the first right-click: a call that beats its startup is Cockpit's "Jot is not
    // installed" path, a native message box that would hang the case instead of failing it.
    await expect.poll(async () => joplinMenuHasItem(win, 'Jot…'), { timeout: 60_000 }).toBe(true);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  async function findJotFrame(win: Page): Promise<Frame | null> {
    for (const frame of win.frames()) {
      if (await frame.locator('#jotForm').count().catch(() => 0)) return frame;
    }
    return null;
  }

  /** Wait for Jot's form and return its frame, once Jot's script has wired it. */
  async function jotForm(win: Page): Promise<Frame> {
    await expect.poll(async () => (await findJotFrame(win)) != null, { timeout: 30_000 }).toBe(true);
    const frame = (await findJotFrame(win))!;
    await expect(frame.locator('#jotForm[data-jot-ready="1"]')).toHaveCount(1, { timeout: 10_000 });
    return frame;
  }

  async function jotFormOpen(win: Page): Promise<boolean> {
    return (await findJotFrame(win)) != null;
  }

  /**
   * What each open plugin dialog is: 'jot' for Jot's form, 'picker' for Cockpit's notebook picker, the frame's URL for
   * anything else. Joplin mounts a plugin dialog only while it is open, so this lists exactly what is on screen.
   */
  async function openDialogs(win: Page): Promise<string[]> {
    const found: string[] = [];
    for (const frame of win.frames()) {
      const element = await frame.frameElement().catch(() => null);
      if (!element) continue; // the main window's own frame
      const inDialog = await element.evaluate((el) => !!el.closest('.user-webview-dialog')).catch(() => false);
      if (!inDialog) continue;
      if (await frame.locator('#jotForm').count().catch(() => 0)) found.push('jot');
      else if (await frame.locator('.picker-filter').count().catch(() => 0)) found.push('picker');
      else found.push(frame.url());
    }
    return found;
  }

  /**
   * Point the panel at a notebook through its own dropdown. A poll rather than one pass, as in mobile-drag.spec.ts:
   * a panel repaint landing between opening the menu and choosing from it closes the menu with nothing chosen, so the
   * exit condition is the filter the panel actually holds (its `-current` item) and a lost click is simply retried.
   */
  async function filterPanelTo(win: Page, notebook: string): Promise<void> {
    await expect
      .poll(
        async () =>
          (await agendaPanel(win)).locator('#notebookMenu .dropdown-item .dropdown-label', { hasText: notebook }).count(),
        { timeout: PANEL_REFRESH_TIMEOUT }
      )
      .toBeGreaterThan(0);
    await expect
      .poll(
        async () => {
          const panel = await agendaPanel(win);
          const current = panel.locator('#notebookMenu .dropdown-item.-current .dropdown-label');
          const nowOn = async () => ((await current.count()) ? ((await current.first().textContent()) || '').trim() : '');
          if ((await nowOn()) === notebook) return notebook;
          try {
            if (!(await panel.locator('#notebookMenu').isVisible())) {
              await panel.locator('.dropdown-toggle[onclick*="notebookMenu"]').click({ timeout: 5_000 });
            }
            await panel
              .locator('#notebookMenu .dropdown-item', { hasText: notebook })
              .locator('.dropdown-label')
              .first()
              .click({ timeout: 5_000 });
          } catch {
            /* a repaint took the menu away mid-click; the next turn starts again from whatever is on screen */
          }
          return nowOn();
        },
        { timeout: PANEL_REFRESH_TIMEOUT, intervals: [800, 1500, 2500] }
      )
      .toBe(notebook);
  }

  /** The ids of the rows in the panel's Notes group, in display order. */
  async function notesGroupIds(win: Page): Promise<string[]> {
    const panel = await agendaPanel(win);
    return panel
      .locator('.notes-section .todo[data-note-id]')
      .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.noteId || ''));
  }

  /** Every page the CDP connection can see, in every context: a second Joplin window is one more of these. */
  function allPages(): Page[] {
    return joplin.browser.contexts().flatMap((context) => context.pages());
  }

  /** The editor still holds the note it had before the case, by id in the note list and by title in the editor. */
  async function editorKept(win: Page, noteId: string, title: string): Promise<void> {
    expect(await selectedNoteId(win)).toBe(noteId);
    await expect.poll(async () => win.locator('input.title-input').inputValue(), { timeout: 10_000 }).toBe(title);
  }

  test('a right-click on New to-do opens Jot\'s form, and a title plus Enter create without changing the editor\'s note', async () => {
    const { win } = joplin;
    const title = `JotNewTask${stamp}`;
    const editorNote = await selectedNoteId(win);
    expect(editorNote).toBe(plainNoteId);

    const panel = await agendaPanel(win);
    await panel.locator('button.create-button[aria-label="New to-do"]').click({ button: 'right' });

    const form = await jotForm(win);
    await expect(form.locator('#jotHeading')).toHaveText('New to-do');
    // Under "All notebooks" Cockpit passes no notebook, so Jot starts on its own default: the notebook Joplin shows.
    await expect(form.locator('#jotNotebook')).toHaveValue(shownBook);
    // ...and Cockpit never asked with its own picker first: Jot's form is the only dialog there is.
    expect(await openDialogs(win)).toEqual(['jot']);

    await form.locator('#jotTitle').fill(title);
    await win.keyboard.press('Enter');
    await expect.poll(async () => jotFormOpen(win), { timeout: 20_000 }).toBe(false);

    const savedAt = Date.now();
    await waitForPanelTodo(win, title);
    console.log(`[jot-integration] new to-do row ${Date.now() - savedAt} ms after Jot's form closed`);
    await editorKept(win, editorNote, plainNote);
  });

  test('filtered to a notebook, a right-click on New note opens Jot\'s form on that notebook, and the note is listed', async () => {
    const { win } = joplin;
    const title = `JotNewNote${stamp}`;
    await filterPanelTo(win, filteredBook);
    const editorNote = await selectedNoteId(win);

    const panel = await agendaPanel(win);
    await panel.locator('button.create-button[aria-label="New note"]').click({ button: 'right' });

    const form = await jotForm(win);
    await expect(form.locator('#jotHeading')).toHaveText('New note');
    // The panel's notebook, passed by Cockpit: Jot's own default would have been the notebook Joplin shows.
    await expect(form.locator('#jotNotebook')).toHaveValue(filteredBook);
    expect(await openDialogs(win)).toEqual(['jot']);

    await form.locator('#jotTitle').fill(title);
    await win.keyboard.press('Enter');
    await expect.poll(async () => jotFormOpen(win), { timeout: 20_000 }).toBe(false);

    const savedAt = Date.now();
    await expect
      .poll(
        async () => (await agendaPanel(win)).locator('.notes-section .todo[data-note-id]', { hasText: title }).count(),
        { timeout: PANEL_REFRESH_TIMEOUT }
      )
      .toBe(1);
    console.log(`[jot-integration] new note row ${Date.now() - savedAt} ms after Jot's form closed`);
    await editorKept(win, editorNote, plainNote);
  });

  test('Quick edit… renames a row without opening it', async () => {
    const { win } = joplin;
    const renamed = `JotRenamedTask${stamp}`;
    const editorNote = await selectedNoteId(win);

    const panel = await agendaPanel(win);
    const rowTitle = panel.locator('.todo[data-todo-id]', { hasText: seededTodo }).first().locator('.todo-title');
    await rowTitle.scrollIntoViewIfNeeded();
    await rowTitle.click({ button: 'right' });

    const menu = panel.locator('#noteContextMenu');
    await expect(menu).toHaveCount(1);
    const actions = await menu
      .locator('.context-menu-item')
      .evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.action || ''));
    expect(actions.slice(0, 2)).toEqual(['open', 'quickEdit']);
    const quickEdit = menu.locator('.context-menu-item[data-action="quickEdit"]');
    await expect(quickEdit).toHaveText('Quick edit…');
    await expect(quickEdit).not.toHaveClass(/-disabled/);
    await quickEdit.click();

    const form = await jotForm(win);
    await expect(form.locator('#jotHeading')).toHaveText('Edit to-do');
    await expect(form.locator('#jotTitle')).toHaveValue(seededTodo);
    await form.locator('#jotTitle').fill(renamed);
    await win.keyboard.press('Enter');
    await expect.poll(async () => jotFormOpen(win), { timeout: 20_000 }).toBe(false);

    const savedAt = Date.now();
    await waitForPanelTodo(win, renamed);
    console.log(`[jot-integration] renamed row ${Date.now() - savedAt} ms after Jot's form closed`);
    await waitForPanelTodoGone(win, seededTodo);
    await editorKept(win, editorNote, plainNote);
  });

  test('a click with the new-window value opens the new note in a second window, and the editor keeps its note', async () => {
    const { win } = joplin;
    await setCockpitSetting(win, 'New note and New to-do: click', 'newWindow');
    // A notebook in the filter, so the create has somewhere to go without asking with the picker.
    await filterPanelTo(win, filteredBook);
    const editorNote = await selectedNoteId(win);
    const rowsBefore = await notesGroupIds(win);
    const pagesBefore = allPages();

    // A fresh handle: the Options visit above unmounts the panel webview and Joplin mounts a new one on the way back.
    const panel = await agendaPanel(win);
    await panel.locator('button.create-button[aria-label="New note"]').click();

    await expect.poll(() => allPages().length, { timeout: 30_000 }).toBe(pagesBefore.length + 1);
    const newWindow = allPages().find((page) => !pagesBefore.includes(page))!;
    // A Joplin window with a note editor of its own, holding the new note - untitled, unlike the main window's note.
    // Joplin draws a second window from the main renderer into an about:blank page, so its editor is plain DOM there.
    await expect
      .poll(async () => newWindow.locator('input.title-input').inputValue({ timeout: 2_000 }).catch(() => null), {
        timeout: 30_000,
      })
      .toBe('');

    await expect
      .poll(async () => (await notesGroupIds(win)).filter((id) => !rowsBefore.includes(id)).length, {
        timeout: PANEL_REFRESH_TIMEOUT,
      })
      .toBe(1);
    await editorKept(win, editorNote, plainNote);

    // Closed here rather than left to closeJoplin, so the second window is this case's to clean up.
    await newWindow.close();
    await expect.poll(() => allPages().length, { timeout: 30_000 }).toBe(pagesBefore.length);
  });
});
