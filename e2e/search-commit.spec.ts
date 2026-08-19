import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import { agendaPanel, createNote, createNotebook, PANEL_REFRESH_TIMEOUT } from './helpers';

/**
 * Committing the Cockpit search on Enter.
 *
 * Joplin's Electron webview does not fire the search field's change/search events on Enter (only on
 * blur or the clear button), so Cockpit commits the search explicitly on the Enter keydown. This spec
 * proves that in the genuine GUI: with the panel filtered to one notebook, a committed search whose
 * text matches only a note in ANOTHER notebook leaves the filtered view empty and surfaces that note in
 * the read-only "results outside current filters" peek. The peek can only appear if the Enter actually
 * committed the search, so its appearance is the end-to-end evidence that the commit fired.
 */
test.describe('Search commit on Enter', () => {
  let joplin: JoplinInstance;
  // A single distinctive token that exists only in the target note's title, so the search matches it and
  // nothing else in the throwaway profile.
  const marker = `Zqxpeek${Date.now()}`;
  const noteTitle = `${marker} outside-filter note`;
  const filterNotebook = `Cockpit Search Filter A ${Date.now()}`;
  const targetNotebook = `Cockpit Search Target B ${Date.now()}`;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    const { win } = joplin;
    // Two notebooks: the panel is filtered to the first; the searched-for note lives in the second.
    await createNotebook(win, filterNotebook);
    await createNotebook(win, targetNotebook); // becomes the selected notebook...
    await createNote(win, noteTitle); // ...so the new note is created inside it.
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('pressing Enter commits the search and surfaces an out-of-filter note in the peek', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);

    // Filter the panel to the first notebook. Its row lives in the always-in-DOM notebook menu once the
    // panel's notebook map has picked up the freshly created notebooks (the folder poll refreshes it), so
    // wait for the row before opening the menu and clicking it.
    await expect
      .poll(
        async () =>
          panel
            .locator('#notebookMenu .dropdown-item .dropdown-label', { hasText: filterNotebook })
            .count(),
        { timeout: PANEL_REFRESH_TIMEOUT }
      )
      .toBeGreaterThan(0);
    await panel.locator('.dropdown-toggle[onclick*="notebookMenu"]').click();
    await expect(panel.locator('#notebookMenu')).toBeVisible();
    await panel
      .locator('#notebookMenu .dropdown-item', { hasText: filterNotebook })
      .locator('.dropdown-label')
      .first()
      .click();

    // Focus the Cockpit search input, type text matching only the note in the second notebook, and commit
    // with Enter. Re-committing on each poll tick re-runs the unfiltered peek search as soon as Joplin's
    // search index has caught up, rather than waiting on the panel's slow periodic refresh; if the Enter
    // never committed (the bug this fixes), the peek would never appear and this poll would time out.
    const search = panel.locator('#searchFilter');
    await expect
      .poll(
        async () => {
          await search.click();
          await search.fill(marker);
          await search.press('Enter');
          await win.waitForTimeout(1200);
          return panel.locator('.outside-results .todo-title', { hasText: marker }).count();
        },
        { timeout: PANEL_REFRESH_TIMEOUT, intervals: [1500, 2500, 4000] }
      )
      .toBeGreaterThan(0);

    // The peek section renders with its heading and the out-of-filter note's row.
    const peek = panel.locator('.outside-results');
    await expect(peek).toBeVisible();
    await expect(peek).toContainText('Results outside current filters');
    await expect(peek.locator('.todo-title', { hasText: marker })).toBeVisible();
  });
});
