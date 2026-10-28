import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, createProfile as createJoplinProfile, JoplinInstance } from './launch';
import {
  agendaPanel,
  createNotebook,
  createProfile,
  createTodo,
  editCurrentProfile,
  openNewProfileEditor,
  panelTodoTitles,
  PANEL_REFRESH_TIMEOUT,
  profileControlsVisible,
  profileNames,
  saveViewEntryLabel,
  saveViewIntoCurrentProfile,
  selectProfile,
  selectedProfileIsModified,
  selectedProfileName,
  setAlarm,
  waitForPanelTodo,
  waitForPanelTodoGone,
} from './helpers';

/**
 * Profiles are the part of Agenda that changed most in the move to mobile: they used to live in an
 * sqlite3 database and now live in a plugin setting. These tests drive the profile editor through
 * the real GUI, and the last one restarts Joplin to prove the profiles are actually persisted.
 *
 * Deleting a profile is deliberately not covered: the confirmation is an Electron native message
 * box, which is outside the renderer and so cannot be driven by Playwright.
 */
test.describe('Profiles', () => {
  let joplin: JoplinInstance;
  let profileDir: string;
  const alphaTitle = 'Alpha task';
  const betaTitle = 'Beta task';
  const notebookName = 'Agenda E2E';

  test.beforeAll(async () => {
    profileDir = createJoplinProfile(true);
    joplin = await launchJoplin({ profileDir });
    const { win } = joplin;
    await createNotebook(win, notebookName);

    await createTodo(win, alphaTitle);
    await setAlarm(win, new Date(Date.now() + 2 * 3600 * 1000));

    await createTodo(win, betaTitle);
    await setAlarm(win, new Date(Date.now() + 3 * 3600 * 1000));

    await waitForPanelTodo(win, alphaTitle);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('a new profile can be created from the panel', async () => {
    const { win } = joplin;
    await createProfile(win, { name: 'Beta only', searchCriteria: 'Beta' });

    await expect
      .poll(() => profileNames(win), { timeout: 30_000 })
      .toEqual(expect.arrayContaining(['All todo and notes', 'Beta only']));
  });

  test('the new profile becomes selectable and its search criteria filters the list', async () => {
    const { win } = joplin;
    await selectProfile(win, 'Beta only');
    expect(await selectedProfileName(win)).toBe('Beta only');

    await waitForPanelTodo(win, betaTitle);
    await waitForPanelTodoGone(win, alphaTitle);
  });

  test('switching back to the other profile restores the full list', async () => {
    const { win } = joplin;
    await selectProfile(win, 'All todo and notes');
    await waitForPanelTodo(win, alphaTitle);
    await waitForPanelTodo(win, betaTitle);
  });

  test('the display format can be changed per profile', async () => {
    const { win } = joplin;
    await selectProfile(win, 'Beta only');
    await editCurrentProfile(win, { displayFormat: 'basic' });

    // The basic format groups nothing and shows the bare title, with no time prefix.
    await expect
      .poll(async () => (await panelTodoTitles(win)).includes(betaTitle), { timeout: 60_000 })
      .toBe(true);
  });

  test('profiles and the selected profile survive a restart of Joplin', async () => {
    await closeJoplin(joplin, { keepProfile: true });
    joplin = await launchJoplin({ profileDir });
    const { win } = joplin;

    await expect
      .poll(() => profileNames(win), { timeout: 60_000 })
      .toEqual(expect.arrayContaining(['All todo and notes', 'Beta only']));
    expect(await selectedProfileName(win)).toBe('Beta only');

    // Its settings survived too: still the 'Beta' search criteria from before the restart.
    await waitForPanelTodo(win, betaTitle);
    await waitForPanelTodoGone(win, alphaTitle);
  });

  test('the profile controls are shown in the panel', async () => {
    // Hiding them is driven by the "Toggle Profile Edit Mode" command, which on desktop is only
    // reachable from the Tools > Agenda menu and the command palette. Both are native Electron
    // menus, and synthetic key presses do not fire their accelerators, so the toggle itself is
    // covered by the harness suite (npm test) instead.
    expect(await profileControlsVisible(joplin.win)).toBe(true);
  });

  /**
   * "+ New profile..." is "save as" for the view on screen: the editor opens on the current profile with the
   * header's notebook, search and quick filters on top, the name focused and selected so typing replaces it, and
   * Create selects the new profile - so the dropdown names the view the panel is still showing. Since 2.10 the
   * sorting is no longer in the header (the quick filters took its place), so the form keeps the profile's own.
   */
  test('a new profile opens on the current view, and Create selects it with the view unchanged', async () => {
    const { win } = joplin;
    const savedName = 'Alpha in Agenda E2E';
    await selectProfile(win, 'All todo and notes');
    const panel = await agendaPanel(win);

    // The notebook filter, from the panel's own dropdown. The row's id is what the editor's select holds.
    const notebookRow = panel.locator('#notebookMenu .dropdown-item[data-notebook-row]', { hasText: notebookName });
    await expect.poll(async () => notebookRow.count(), { timeout: PANEL_REFRESH_TIMEOUT }).toBeGreaterThan(0);
    const notebookId = ((await notebookRow.first().getAttribute('onclick')) || '').match(/'notebookFilterChanged', '([^']+)'/)?.[1] || '';
    expect(notebookId).not.toBe('');
    await panel.locator('.dropdown-toggle[onclick*="notebookMenu"]').click();
    await expect(panel.locator('#notebookMenu')).toBeVisible();
    await notebookRow.locator('.dropdown-label').first().click();
    await expect(panel.locator('.dropdown-toggle[onclick*="notebookMenu"] .dropdown-toggle-label')).toHaveText(notebookName, { timeout: 20_000 });

    // A committed search matching one of the two to-dos.
    const search = panel.locator('#searchFilter');
    await search.click();
    await search.fill(alphaTitle);
    await search.press('Enter');
    await waitForPanelTodoGone(win, betaTitle);
    await waitForPanelTodo(win, alphaTitle);

    // A quick filter released, away from the default the template would show. "All checkboxes done" hides neither
    // to-do (they have no checkboxes inside), so the view keeps the row the checks below look for.
    const doneFilter = panel.locator('#quickFilters .quick-filter[data-filter="doneCheckboxes"]');
    await doneFilter.click();
    await expect(doneFilter).toHaveAttribute('aria-pressed', 'false', { timeout: 20_000 });
    await waitForPanelTodo(win, alphaTitle);

    const editor = await openNewProfileEditor(win);
    await expect(editor.locator('#notebookSelect')).toHaveValue(notebookId);
    await expect(editor.locator('#panelSearchInput')).toHaveValue(alphaTitle);
    await expect(editor.locator('#showDoneCheckboxesCheckbox')).not.toBeChecked();
    await expect(editor.locator('#showOpenCheckboxesCheckbox')).toBeChecked();
    await expect(editor.locator('#showNoCheckboxesCheckbox')).toBeChecked();
    // The sorting is the profile's own: the header no longer changes it.
    await expect(editor.locator('#sortFieldSelect')).toHaveValue('title');
    await expect(editor.locator('#sortDirectionSelect')).toHaveValue('asc');
    await expect(editor.locator('#nameInput')).toHaveValue('New Profile');
    // The name has the focus with all of its text selected, so typing replaces it.
    await expect
      .poll(
        () =>
          editor.evaluate(() => {
            const active = document.activeElement as HTMLInputElement | null;
            return active && active.id === 'nameInput'
              ? { start: active.selectionStart, end: active.selectionEnd, length: active.value.length }
              : { active: active ? active.id || active.tagName : null };
          }),
        { timeout: 10_000 }
      )
      .toEqual({ start: 0, end: 'New Profile'.length, length: 'New Profile'.length });

    await win.keyboard.type(savedName);
    await expect(editor.locator('#nameInput')).toHaveValue(savedName);
    await win.locator('button:has-text("Create")').last().click();

    await expect.poll(() => profileNames(win), { timeout: 30_000 }).toContain(savedName);
    await expect.poll(() => selectedProfileName(win), { timeout: 30_000 }).toBe(savedName);
    // The view is the one it was made from: still filtered to the notebook, the search and the released filter.
    const panelAfter = await agendaPanel(win);
    await expect(panelAfter.locator('#searchFilter')).toHaveValue(alphaTitle);
    await expect(panelAfter.locator('.dropdown-toggle[onclick*="notebookMenu"] .dropdown-toggle-label')).toHaveText(notebookName);
    await expect(panelAfter.locator('#quickFilters .quick-filter[data-filter="doneCheckboxes"]')).toHaveAttribute('aria-pressed', 'false');
    await waitForPanelTodo(win, alphaTitle);
    expect(await panelTodoTitles(win)).not.toContain(betaTitle);
    // Made from the view on screen, so the new profile's name carries no "view changed" asterisk.
    expect(await selectedProfileIsModified(win)).toBe(false);
  });

  /**
   * A header change the profile does not hold marks the picker's name with an asterisk - on the toggle only, the
   * rows keep the stored names - and picking the profile again returns to its saved view and drops the mark.
   */
  test('changing the view marks the profile name with an asterisk, and picking it again restores its saved view', async () => {
    const { win } = joplin;
    const profileName = 'All todo and notes';
    await selectProfile(win, profileName);
    await expect.poll(() => selectedProfileName(win), { timeout: 30_000 }).toBe(profileName);
    const panel = await agendaPanel(win);
    const notebookLabel = panel.locator('.dropdown-toggle[onclick*="notebookMenu"] .dropdown-toggle-label');
    await expect(notebookLabel).toHaveText('All notebooks', { timeout: 20_000 });
    await waitForPanelTodo(win, betaTitle);

    // Filter to the notebook from the panel's own dropdown: the view no longer matches the saved profile.
    await panel.locator('.dropdown-toggle[onclick*="notebookMenu"]').click();
    await expect(panel.locator('#notebookMenu')).toBeVisible();
    await panel
      .locator('#notebookMenu .dropdown-item[data-notebook-row]', { hasText: notebookName })
      .locator('.dropdown-label')
      .first()
      .click();
    await expect(notebookLabel).toHaveText(notebookName, { timeout: 20_000 });
    await expect.poll(() => selectedProfileName(win), { timeout: 20_000 }).toBe(`${profileName}*`);
    expect(await selectedProfileIsModified(win)).toBe(true);
    expect(await profileNames(win)).toContain(profileName);
    expect((await profileNames(win)).some((name) => name.endsWith('*'))).toBe(false);

    // Picking it again returns to its saved view: the plain name, and the list unfiltered.
    await selectProfile(win, profileName);
    await expect.poll(() => selectedProfileName(win), { timeout: 30_000 }).toBe(profileName);
    await expect(notebookLabel).toHaveText('All notebooks', { timeout: 20_000 });
    await waitForPanelTodo(win, alphaTitle);
    await waitForPanelTodo(win, betaTitle);
  });

  /**
   * The third way out of a marked view: "Save view into <name>" in the profile menu writes the header's notebook,
   * search and quick filters into the current profile (and the sorting it was applied with). Offered only while the view is marked; afterwards the name is plain,
   * the view stays, and a switch away and back finds it saved.
   */
  test('"Save view into" writes the marked view into the current profile', async () => {
    const { win } = joplin;
    const profileName = 'All todo and notes';
    await selectProfile(win, profileName);
    await expect.poll(() => selectedProfileName(win), { timeout: 30_000 }).toBe(profileName);
    expect(await saveViewEntryLabel(win)).toBeNull();

    const panel = await agendaPanel(win);
    const notebookLabel = panel.locator('.dropdown-toggle[onclick*="notebookMenu"] .dropdown-toggle-label');
    await panel.locator('.dropdown-toggle[onclick*="notebookMenu"]').click();
    await expect(panel.locator('#notebookMenu')).toBeVisible();
    await panel
      .locator('#notebookMenu .dropdown-item[data-notebook-row]', { hasText: notebookName })
      .locator('.dropdown-label')
      .first()
      .click();
    await expect(notebookLabel).toHaveText(notebookName, { timeout: 20_000 });
    await expect.poll(() => selectedProfileName(win), { timeout: 20_000 }).toBe(`${profileName}*`);
    await expect.poll(() => saveViewEntryLabel(win), { timeout: 20_000 }).toBe(`Save view into ${profileName}`);

    await saveViewIntoCurrentProfile(win);
    await expect.poll(() => selectedProfileName(win), { timeout: 30_000 }).toBe(profileName);
    expect(await saveViewEntryLabel(win)).toBeNull();
    await expect(notebookLabel).toHaveText(notebookName);
    await waitForPanelTodo(win, alphaTitle);

    // Away and back: the profile now carries the notebook.
    await selectProfile(win, 'Beta only');
    await expect.poll(() => selectedProfileName(win), { timeout: 30_000 }).toBe('Beta only');
    await selectProfile(win, profileName);
    await expect.poll(() => selectedProfileName(win), { timeout: 30_000 }).toBe(profileName);
    await expect(notebookLabel).toHaveText(notebookName, { timeout: 20_000 });
  });
});
