import { test, expect, Frame } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  agendaPanel,
  createNote,
  createNotebook,
  createProfile,
  createTodo,
  executePluginCommand,
  panelToastVisible,
  panelTodoTitles,
  selectProfile,
  setCockpitTextSetting,
  waitForPanelTodo,
  PANEL_REFRESH_TIMEOUT,
} from './helpers';

/**
 * The two commands Cockpit registers for ANOTHER PLUGIN to call, driven in the real app the way that plugin
 * calls them: the Whereabouts notebook chip runs `cockpit.filterByNotebook(folderId)` on a left click and
 * `cockpit.revealNote(noteId)` on a double click, both with a plain id string.
 *
 * Reaching them needs an argument, and the command palette (the only in-app trigger a spec could otherwise
 * click) passes none. So this file - alone in the suite - launches Joplin with `--env dev`, which is what makes
 * the app publish its own `window.joplin.commandService` to the renderer; `executePluginCommand` then goes
 * through the very CommandService entry point a plugin's `joplin.commands.execute` lands in. Everything else
 * about the instance is the harness's ordinary throwaway profile with this plugin loaded from ./dist.
 */
test.describe('Commands for other plugins (the Whereabouts contract)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const alphaNotebook = `Cockpit Alpha ${stamp}`;
  const betaNotebook = `Cockpit Beta ${stamp}`;
  const alphaTodo = `AlphaTask${stamp}`;
  const betaTodo = `BetaTask${stamp}`;
  const plainNote = `PlainNote${stamp}`;
  const todosOnlyProfile = `Tasks only ${stamp}`;
  let alphaId = '';
  let betaTodoId = '';
  let plainNoteId = '';

  /** The notebook id the panel's own dropdown would filter by for a notebook of this name. */
  async function notebookIdByName(panel: Frame, name: string): Promise<string> {
    return await panel.evaluate((wanted) => {
      const rows = Array.from(document.querySelectorAll('#notebookMenu .dropdown-item[data-notebook-row]'));
      for (const row of rows) {
        const label = (row.querySelector('.dropdown-label')?.textContent || '').trim();
        if (label === wanted || label.endsWith(`/ ${wanted}`)) {
          const found = /'notebookFilterChanged', '([^']*)'/.exec(row.getAttribute('onclick') || '');
          if (found) return found[1];
        }
      }
      return '';
    }, name);
  }

  /** Which notebook the panel's filter control currently names. */
  async function currentNotebookLabel(panel: Frame): Promise<string> {
    return await panel.evaluate(() => {
      const toggle = document.querySelector('#filterRow .dropdown .dropdown-toggle .dropdown-toggle-label');
      return (toggle?.textContent || '').trim();
    });
  }

  test.beforeAll(async () => {
    joplin = await launchJoplin({ envDev: true });
    const { win } = joplin;
    await createNotebook(win, alphaNotebook); // becomes the selected notebook...
    await createTodo(win, alphaTodo); // ...so these two are created inside it
    plainNoteId = await createNote(win, plainNote);
    await createNotebook(win, betaNotebook);
    betaTodoId = await createTodo(win, betaTodo);
    await waitForPanelTodo(win, alphaTodo);
    await waitForPanelTodo(win, betaTodo);
    const panel = await agendaPanel(win);
    await expect
      .poll(async () => notebookIdByName(panel, alphaNotebook), { timeout: PANEL_REFRESH_TIMEOUT })
      .not.toBe('');
    alphaId = await notebookIdByName(panel, alphaNotebook);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('cockpit.filterByNotebook points the panel at a notebook, and "" clears it again', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    await executePluginCommand(win, 'cockpit.filterByNotebook', alphaId);
    await expect
      .poll(async () => (await panelTodoTitles(win)).some((title) => title.includes(betaTodo)), {
        timeout: PANEL_REFRESH_TIMEOUT,
      })
      .toBe(false);
    expect((await panelTodoTitles(win)).some((title) => title.includes(alphaTodo))).toBe(true);
    expect(await currentNotebookLabel(panel)).toContain(alphaNotebook);

    // "" is the same clear the dropdown's own "All notebooks" row performs.
    await executePluginCommand(win, 'cockpit.filterByNotebook', '');
    await waitForPanelTodo(win, betaTodo);
    expect(await currentNotebookLabel(panel)).toBe('All notebooks');
  });

  test('cockpit.revealNote switches the filter to the note\'s notebook and flashes its row', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    // Start filtered to the OTHER notebook, so the revealed note cannot be on screen.
    await executePluginCommand(win, 'cockpit.filterByNotebook', alphaId);
    await expect
      .poll(async () => (await panelTodoTitles(win)).some((title) => title.includes(betaTodo)), {
        timeout: PANEL_REFRESH_TIMEOUT,
      })
      .toBe(false);

    // The flash is deliberately short (~1.5s), so it is watched for rather than polled for: the panel's own
    // document survives a render (setHtml replaces the content inside it), so one observer spans the reveal.
    await panel.evaluate((id) => {
      (window as any).__revealFlash = false;
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          const target = record.target as HTMLElement;
          if (!target.classList || !target.classList.contains('-revealed')) continue;
          if (target.dataset.todoId === id || target.dataset.noteId === id) (window as any).__revealFlash = true;
        }
      });
      observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
    }, betaTodoId);

    await executePluginCommand(win, 'cockpit.revealNote', betaTodoId);
    await waitForPanelTodo(win, betaTodo);
    expect(await currentNotebookLabel(panel)).toContain(betaNotebook);
    // The marker the render carries, and the flash the webview raised from it.
    expect(
      await panel.evaluate(() => document.querySelector('.todos')?.getAttribute('data-reveal-note') || '')
    ).toBe(betaTodoId);
    expect(await panel.evaluate(() => (window as any).__revealFlash === true)).toBe(true);
  });

  test('cockpit.revealNote pins a plain note as a peek row when the profile cannot list it', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    // A to-dos-only profile: no notebook filter can ever make a regular note appear in it.
    await createProfile(win, { name: todosOnlyProfile, showNotes: false, showNoDue: true });
    await selectProfile(win, todosOnlyProfile);
    await expect
      .poll(async () => (await panelTodoTitles(win)).some((title) => title.includes(plainNote)), {
        timeout: PANEL_REFRESH_TIMEOUT,
      })
      .toBe(false);

    await executePluginCommand(win, 'cockpit.revealNote', plainNoteId);
    await expect
      .poll(
        async () =>
          panel.evaluate(
            (id) => !!document.querySelector(`.outside-results .todo[data-note-id="${id}"]`),
            plainNoteId
          ),
        { timeout: PANEL_REFRESH_TIMEOUT }
      )
      .toBe(true);
    expect(
      await panel.evaluate(() => (document.querySelector('.outside-results-heading')?.textContent || '').trim())
    ).toContain('Revealed - outside current filters');
  });

  /**
   * The owner's report, end to end. A chip click naming a notebook the user has EXCLUDED in Cockpit's settings
   * used to point the filter at it: the dropdown could not mark a row it does not list, so its label fell back to
   * "All notebooks" while the search really was narrowed to a notebook the exclusion then emptied - and New to-do
   * saw a non-empty filter and created straight into the excluded notebook without asking.
   *
   * Declared LAST in the file on purpose: it excludes one of the fixtures' own notebooks, which the cases above
   * still need.
   */
  test('cockpit.filterByNotebook refuses an excluded notebook, and New to-do still asks where to create', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    // The id has to be read while the notebook is still listed - excluding it takes its row out of the dropdown.
    const betaId = await notebookIdByName(panel, betaNotebook);
    expect(betaId).not.toBe('');
    // Back to "All notebooks" first, which is where the owner's report starts: the two cases above leave the
    // filter pointed at alphaNotebook, and BOTH halves below are about a filter that is empty - the label the
    // refusal must leave alone, and the create that has no notebook of its own and therefore asks.
    await executePluginCommand(win, 'cockpit.filterByNotebook', '');

    await setCockpitTextSetting(win, 'Excluded notebooks', betaNotebook);
    await expect
      .poll(async () => panelTodoTitles(win).then((titles) => titles.includes(betaTodo)), {
        timeout: PANEL_REFRESH_TIMEOUT,
      })
      .toBe(false);

    await executePluginCommand(win, 'cockpit.filterByNotebook', betaId);

    // The filter is left exactly where it was, and the user is told why rather than left with an empty panel.
    await expect.poll(async () => panelToastVisible(win), { timeout: 20_000 }).toBe(true);
    // A FRESH frame handle: the Options visit above unmounts the panel webview and Joplin mounts a new one on the
    // way back, so the `panel` captured at the top of this case is detached by now and every call on it throws.
    // The helpers that take `win` re-find the frame themselves, which is why only these two lines need it.
    const livePanel = await agendaPanel(win);
    expect(await currentNotebookLabel(livePanel)).toBe('All notebooks');
    // ...and because the filter really is empty, the create asks: the picker dialog opens instead of a note
    // appearing silently inside the excluded notebook.
    await livePanel.locator('#profileControls button[title="New to-do"]').click();
    const pickerShowing = async () => {
      for (const frame of win.frames()) {
        if (await frame.locator('.picker-filter').count().catch(() => 0)) return true;
      }
      return false;
    };
    await expect.poll(pickerShowing, { timeout: 30_000 }).toBe(true);
    await win.locator('button:has-text("Cancel")').last().click();
  });
});
