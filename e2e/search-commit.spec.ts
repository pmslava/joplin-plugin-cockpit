import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  agendaPanel,
  createNote,
  createNotebook,
  createTodo,
  selectedNoteId,
  PANEL_REFRESH_TIMEOUT,
} from './helpers';

/**
 * Rows of the panel's own list. The read-only "results outside current filters" peek renders inside the same
 * `.todos` container, so its rows are subtracted - otherwise a filtered-to-nothing view still counts as
 * non-empty and the assertions below would pass for the wrong reason.
 */
async function selectAllNotebooks(panel: import('@playwright/test').Frame): Promise<void> {
  await panel.locator('.dropdown-toggle[onclick*="notebookMenu"]').click();
  await expect(panel.locator('#notebookMenu')).toBeVisible();
  await panel.locator('#notebookMenu [data-notebook-all]').click();
}

/**
 * Put the panel into a known, genuinely unfiltered state: "All notebooks" AND no committed search. Tests in
 * this file run in order against one Joplin instance, and several of them leave a search committed, so a test
 * that needs a non-empty list has to clear BOTH filters or it starts from zero rows. The search is cleared
 * with an explicit Enter rather than by emptying the field, so this setup never depends on the auto-reset
 * that one of the tests is there to prove.
 */
async function resetToFullList(
  panel: import('@playwright/test').Frame,
  search: import('@playwright/test').Locator
): Promise<void> {
  await selectAllNotebooks(panel);
  await search.click();
  await search.press('Control+a');
  await search.press('Delete');
  await search.press('Enter');
  await expect
    .poll(async () => await listRowCount(panel), { timeout: PANEL_REFRESH_TIMEOUT, intervals: [500, 1500] })
    .toBeGreaterThan(0);
}

/** The visible titles of the panel's own list rows (the peek's rows excluded, as in listRowCount). */
async function panelTitles(panel: import('@playwright/test').Frame): Promise<string[]> {
  return await panel.evaluate(() => {
    const peek = new Set(Array.from(document.querySelectorAll('.outside-results .todo-title')));
    return Array.from(document.querySelectorAll('.todos .todo-title'))
      .filter((el) => !peek.has(el))
      .map((el) => (el.textContent || '').trim());
  });
}

async function listRowCount(panel: import('@playwright/test').Frame): Promise<number> {
  return await panel.evaluate(
    () =>
      document.querySelectorAll('.todos .todo').length -
      document.querySelectorAll('.outside-results .todo').length
  );
}

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
  // The peeked note's real Joplin id, so the peek-click check below can assert on the app's own selected
  // note (a click that opens it) and on the panel's selection (which must NOT gain it).
  let outsideNoteId = '';

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    const { win } = joplin;
    // Two notebooks: the panel is filtered to the first; the searched-for note lives in the second.
    await createNotebook(win, filterNotebook);
    await createNotebook(win, targetNotebook); // becomes the selected notebook...
    outsideNoteId = await createNote(win, noteTitle); // ...so the new note is created inside it.
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

    // The commit hands the caret straight back, so the user can keep typing into the query they just ran.
    // The re-render REPLACES the input, so this is not "focus was never lost" but "focus was put back on the
    // freshly rendered field": reconcile restores it after the host's setHtml has swapped the markup. It only
    // works because the removal-blur that swap fires is DEFERRED rather than taken for a departure - measured
    // on this build that blur arrives with its target still connected and with no relatedTarget, so before the
    // fix it ran leaveSearchField and every commit left activeElement on <body>.
    await expect(search).toBeFocused();
    // And the caret sits at the END of the committed value, not at 0 - continued typing appends to the query
    // instead of being injected in front of it.
    await expect
      .poll(
        async () =>
          await panel.evaluate(() => {
            const el = document.activeElement as HTMLInputElement | null;
            if (!el || el.id !== 'searchFilter') return null;
            return { start: el.selectionStart, end: el.selectionEnd, length: el.value.length };
          }),
        { timeout: 10_000, intervals: [300, 1000] }
      )
      .toEqual({ start: marker.length, end: marker.length, length: marker.length });

    /** A CLICK on a peek row OPENS it and selects NOTHING (MAJOR-1, 2.1.0). ***************************
     * The peek's rows are read-only: they are rendered without the selection `onmousedown` on purpose,
     * but they DO carry `onclick`, because opening them is the whole point of showing them. When the
     * click path gained a selection collapse (the shared onRowClicked), that collapse wrote a peek row
     * into `selectedRowIDs` - persisted module state that survives every render - and since a selection
     * drives the batch context menu, Delete / Move / Tags / Duplicate / Switch-type became reachable on
     * rows the user was shown read-only, from outside their filters and even from excluded notebooks.
     *
     * Proved on the LIVE selection rather than on the `-selected` class: the class is also painted for
     * the editor-tracking highlight, which a peek row legitimately gets once clicking it opens the note.
     ***************************************************************************************************/
    const before = await panel.evaluate(() => [...((window as any).selectedRowIDs || [])]);
    await peek.locator('.todo-title', { hasText: marker }).first().click();
    // The click did its real job: the editor moved onto the peeked note.
    await expect
      .poll(async () => await selectedNoteId(win), { timeout: 15_000, intervals: [500, 1500] })
      .toBe(outsideNoteId);
    // And the selection is untouched - not merely "does not contain the peek row", but unchanged.
    const after = await panel.evaluate(() => [...((window as any).selectedRowIDs || [])]);
    expect(after, 'a click on a read-only peek row must not enter the selection').toEqual(before);
    expect(after, 'and specifically must not have selected the peeked note').not.toContain(outsideNoteId);
  });

  /**
   * Multi-select in the token suggestion dropdown (1.9.8).
   *
   * The dropdown gained a Ctrl+click multi-select, an embedded filter box and an apply button. Two of
   * the fixes it needed are only observable in a real browser, which is why they are proved here rather
   * than by source shape: (1) the panel's capturing click listener used to count the suggestion list as
   * "outside" any `.dropdown` and close it on the click that follows a marking Ctrl+mousedown; (2) the
   * search field's blur handler used to tear the list down the moment focus moved into its own filter
   * box. Either bug makes the sequence below impossible.
   *
   * `notebook:` is used because this spec already creates two notebooks whose names contain spaces, so
   * the same run also proves the quoting and the "everything else in the query is preserved" rule.
   */
  test('Ctrl+click marks several suggestions and Enter inserts them all, preserving the rest of the query', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    const search = panel.locator('#searchFilter');
    const menu = panel.locator('#searchSuggestions');

    // Let the previous test's committed search finish re-rendering the panel, so its render cannot land
    // mid-sequence and close the list (a re-render replaces the panel markup, and with nothing marked yet
    // there is nothing for reconcile to carry across).
    await win.waitForTimeout(2_000);

    // Free text that must survive the apply untouched, then an incomplete notebook: token.
    //
    // Cleared and typed with the KEYBOARD, never `fill()`: Playwright's fill dispatches `change`, which this
    // field wires to onSearchFilterChanged - so a fill would COMMIT the search and the resulting re-render
    // would tear the list down again. A real user typing never fires `change` (Electron only fires it on blur
    // or the clear button, which is the whole reason Enter has to commit explicitly).
    //
    // The partial must also be ONE word: an unquoted Joplin token cannot span a space, so tokenAtCaret stops
    // at whitespace and a two-word partial opens no list at all. "Cockpit" is the common prefix of both
    // notebooks created above.
    //
    // Retried as a whole: the panel's periodic refresh can land at any moment, and a re-render closes an
    // open list when nothing is marked yet (with marks, reconcile carries them across - which is exactly
    // what this suite is here to exercise). Retyping is harmless and makes the open step deterministic.
    await expect
      .poll(
        async () => {
          if (await menu.count()) return true;
          await search.click();
          await search.press('Control+a');
          await search.press('Delete');
          // Emptying the field is itself a COMMIT: the previous test leaves a search committed, so the
          // auto-reset fires here and the host re-renders. That render has to land BEFORE the typing starts,
          // or it replaces the input mid-keystroke - and the panel now (correctly) carries the half-typed
          // draft across such a render instead of dropping it, so a race here corrupts the free text rather
          // than merely losing it and retrying. Settled once, here, rather than papered over with a retry.
          await win.waitForTimeout(2_000);
          await search.pressSequentially('any:1 milk notebook:Cockpit', { delay: 20 });
          return (await menu.count()) > 0;
        },
        { timeout: 30_000, intervals: [500, 1000, 2000] }
      )
      .toBe(true);

    // Both notebooks this spec created are offered.
    const filterRow = menu.locator('.dropdown-item', { hasText: filterNotebook });
    const targetRow = menu.locator('.dropdown-item', { hasText: targetNotebook });
    await expect(filterRow).toHaveCount(1);
    await expect(targetRow).toHaveCount(1);

    // The list's own furniture: a filter box, the hint at the bottom, and the apply button still hidden
    // because nothing is marked yet.
    await expect(menu.locator('.suggest-filter-input')).toBeVisible();
    await expect(menu.locator('.suggest-hint')).toContainText('select several');
    await expect(menu.locator('.suggest-apply')).toBeHidden();

    // Ctrl+click marks WITHOUT closing the list - the regression the capture click-closer used to cause.
    await filterRow.click({ modifiers: ['Control'] });
    await expect(menu).toBeVisible();
    await expect(filterRow).toHaveClass(/-marked/);
    await expect(menu.locator('.suggest-apply')).toBeVisible();

    await targetRow.click({ modifiers: ['Control'] });
    await expect(menu).toBeVisible();
    await expect(targetRow).toHaveClass(/-marked/);

    // The marks survive the embedded filter: typing in it hides one of the two marked rows (and reaching
    // for the box must not close the list - the focus-region fix), and clearing it brings the row back
    // still marked.
    const filterBox = menu.locator('.suggest-filter-input');
    await filterBox.click();
    await expect(menu).toBeVisible();
    await filterBox.fill('Target B');
    await expect(menu).toBeVisible();
    await expect(filterRow).toBeHidden();
    await expect(targetRow).toBeVisible();
    await filterBox.fill('');
    await expect(filterRow).toBeVisible();
    await expect(filterRow).toHaveClass(/-marked/, { timeout: 5_000 });
    await expect(targetRow).toHaveClass(/-marked/);

    // Enter applies every mark. The list closes, and the field holds the free text it started with plus
    // both notebook tokens, quoted because the names contain spaces.
    await filterBox.press('Enter');
    await expect(menu).toHaveCount(0);
    // Exact, because this is the whole point of the feature: the marked tokens replace ONLY the half-typed
    // fragment, in the order they were marked, quoted because the names contain spaces - and `any:1 milk`
    // comes back untouched. Trimmed because the host trims the committed search.
    const applied = (await search.inputValue()).trim();
    expect(applied).toBe(`any:1 milk notebook:"${filterNotebook}" notebook:"${targetNotebook}"`);
  });

  /**
   * The KEYBOARD route into the filter box, and the commit fallback around it.
   *
   * `change` fires on the search field whenever it loses focus with an edited value, and the filter box is
   * literally the field's next tab stop — so Tab is the route a mouse-driven test cannot see. Committing there
   * would run the half-typed query and re-render the panel out from under the interaction. The commit is
   * deferred instead, and must then FIRE once focus leaves the search region entirely, or the typed query would
   * be stranded uncommitted (and wiped, since leaving nulls the draft).
   *
   * "Did a commit happen" is read from `.todos[data-render-nonce]`: the host bumps it only on a real render,
   * after its markup-equality guard, so an unchanged nonce is a precise "no commit".
   */
  test('Tab into the filter box does not commit; leaving the region afterwards commits exactly once', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    const search = panel.locator('#searchFilter');
    const menu = panel.locator('#searchSuggestions');
    const nonce = async () =>
      await panel.locator('.todos').first().getAttribute('data-render-nonce');

    await win.waitForTimeout(2_000);
    await expect
      .poll(
        async () => {
          if (await menu.count()) return true;
          await search.click();
          await search.press('Control+a');
          await search.press('Delete');
          // As above: the previous test applied its tokens, which committed, so emptying the field auto-commits
          // a reset and re-renders. Let that render land before typing into the field it replaces.
          await win.waitForTimeout(2_000);
          await search.pressSequentially('notebook:Cockpit', { delay: 20 });
          return (await menu.count()) > 0;
        },
        { timeout: 30_000, intervals: [500, 1000, 2000] }
      )
      .toBe(true);

    // Mark a row, so the thing a stray commit would destroy actually exists.
    const row = menu.locator('.dropdown-item', { hasText: filterNotebook });
    await row.click({ modifiers: ['Control'] });
    await expect(row).toHaveClass(/-marked/);

    const before = await nonce();

    // TAB: focus moves field -> filter box. No commit, and the list and its marks survive.
    await search.press('Tab');
    await expect(panel.locator('.suggest-filter-input')).toBeFocused();
    await expect(menu).toBeVisible();
    await expect(row).toHaveClass(/-marked/);
    await win.waitForTimeout(1_500);
    expect(await nonce()).toBe(before);

    // M3: clicking back into the search field is a move within the search, not a dismissal - the list and the
    // marks must survive that too (Escape already hands the caret back the same way).
    await search.click();
    await expect(menu).toBeVisible();
    await expect(row).toHaveClass(/-marked/);
    await win.waitForTimeout(1_500);
    expect(await nonce()).toBe(before);

    // Now leave the search region for good. The click lands on the empty bottom of the list container rather
    // than on a row: the panel is filtered to a notebook that need not hold any to-dos, and a row click would
    // also open a note. Either way it is outside #searchRow, which is what ends the search interaction.
    const listBox = (await panel.locator('.todos').first().boundingBox())!;
    await win.mouse.click(listBox.x + 5, listBox.y + listBox.height - 5);
    await expect
      .poll(async () => await nonce(), { timeout: 15_000, intervals: [500, 1000, 2000] })
      .not.toBe(before);
    await expect(menu).toHaveCount(0);
    const afterFirst = await nonce();
    await win.waitForTimeout(2_500);
    expect(await nonce()).toBe(afterFirst); // exactly once - no second, late commit
  });

  /**
   * The search field's clear button (the native × of `input[type=search]`) fires the `search` event, which is
   * the other half of what was re-wired through the deferred commit. It presses on the FIELD, not into the
   * list, so it must still commit immediately.
   */
  test('the clear button still commits after the change/search re-wiring', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    const search = panel.locator('#searchFilter');

    const nonce = async () =>
      await panel.locator('.todos').first().getAttribute('data-render-nonce');

    // Start from "All notebooks": this test asserts the FULL LIST comes back, so it must not depend on
    // whichever notebook an earlier test left selected (which is what made it flaky).
    // A known unfiltered starting point, and with it the render settled: a render replaces the input, and one
    // landing mid-type swallows the rest of the keystrokes (which is what made this flaky).
    await win.waitForTimeout(2_000);
    await resetToFullList(panel, search);

    // Commit a distinctive search first, so the clear has something to undo.
    await search.click();
    await search.press('Control+a');
    await search.press('Delete');
    await search.pressSequentially('Zzqqxx-no-such-note', { delay: 10 });
    await search.press('Enter');
    await expect
      .poll(async () => await search.inputValue(), { timeout: 15_000, intervals: [500, 1500] })
      .toBe('Zzqqxx-no-such-note');
    await win.waitForTimeout(1_500);
    const before = await nonce();

    // A REAL click on the field's × (the UA ::-webkit-search-cancel-button). It is a narrow target inside the
    // input's shadow DOM, so the offset matters: ~14px in from the right edge lands on it, while the 9px this
    // test first used missed and silently cleared nothing. Clicking it for real also proves the × survives the
    // panel's own chrome, which a dispatched event could not.
    //
    // This is the case the deferred commit had to keep working: the × fires `search` while the FIELD still
    // holds focus, so the deferral must not mistake it for focus moving into the suggestion list and hold it.
    await search.click();
    const box = (await search.boundingBox())!;
    await win.mouse.click(box.x + box.width - 14, box.y + box.height / 2);

    await expect
      .poll(async () => await search.inputValue(), { timeout: 10_000, intervals: [300, 1000] })
      .toBe('');
    // A real render followed, which only a commit produces (the host bumps the nonce after its equality guard).
    await expect
      .poll(async () => await nonce(), { timeout: 20_000, intervals: [500, 1500] })
      .not.toBe(before);
    // And the panel is actually back to the unfiltered view - the thing the user wanted - not merely that an
    // event fired.
    await expect
      .poll(async () => await listRowCount(panel), { timeout: 20_000, intervals: [500, 1500] })
      .toBeGreaterThan(0);
  });

  /**
   * The × posts exactly ONE commit.
   *
   * Clicking the field's clear button fires THREE events: `input` (on which the empty-field auto-reset commits
   * ""), then `change` and `search` (which both reach the deferred commit with the same ""). So the webview
   * asked the host to commit the identical empty query up to three times, and the host's equality guard quietly
   * absorbed the extras. That equality IS the no-op case, so the duplicates are now dropped at source.
   *
   * Counted by wrapping `webviewApi.postMessage` in the panel - the only way to see posts the host would
   * otherwise collapse into one indistinguishable render. The counter lives on `window`, which survives the
   * desktop re-render (setHtml is an innerHTML swap inside the panel iframe).
   */
  test('the × asks the host to commit exactly once, not two or three times', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    const search = panel.locator('#searchFilter');

    await win.waitForTimeout(2_000);
    await resetToFullList(panel, search);

    // Commit something for the × to clear.
    await search.click();
    await search.press('Control+a');
    await search.press('Delete');
    await search.pressSequentially('Zzqqxx-clear-once', { delay: 10 });
    await search.press('Enter');
    await expect
      .poll(async () => await search.inputValue(), { timeout: 15_000, intervals: [500, 1500] })
      .toBe('Zzqqxx-clear-once');
    await win.waitForTimeout(1_500);

    // Start counting AFTER the commit has settled, so only the × 's own posts are seen.
    await panel.evaluate(() => {
      const api = (window as any).webviewApi;
      (window as any).__cockpitCommits = [];
      if (!api.__cockpitCounted) {
        const original = api.postMessage.bind(api);
        api.postMessage = (message: any) => {
          if (Array.isArray(message) && message[0] === 'searchFilterChanged') {
            (window as any).__cockpitCommits.push(String(message[1] ?? ''));
          }
          return original(message);
        };
        api.__cockpitCounted = true;
      }
    });

    // A REAL click on the UA cancel button (~14px in from the right edge - see the test above).
    await search.click();
    const box = (await search.boundingBox())!;
    await win.mouse.click(box.x + box.width - 14, box.y + box.height / 2);

    await expect
      .poll(async () => await search.inputValue(), { timeout: 10_000, intervals: [300, 1000] })
      .toBe('');
    // Give the deferred change/search commits (one tick each) and the render every chance to fire.
    await win.waitForTimeout(3_000);

    const commits = await panel.evaluate(() => (window as any).__cockpitCommits as string[]);
    expect(commits, 'the × must ask the host to commit the empty query exactly once').toEqual(['']);
  });

  /**
   * Emptying the field returns the panel to "all" on its own - no Enter.
   *
   * This is the second Pixel report. The input path never committed: `input` is the only event a backspace
   * fires, `change` waits for a blur and `search` for the ×, so the panel stayed filtered until the user
   * pressed Enter on an empty field. Non-obvious on desktop; on mobile there is no committing Enter on the
   * soft keyboard AND Android's WebView does not render the ×, so backspace was the only clear path and it
   * did nothing at all.
   *
   * Asserted on the ROW COUNT rather than on an event: what matters is that the full list comes back.
   */
  test('backspacing the field to empty returns the panel to the full list, without pressing Enter', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    const search = panel.locator('#searchFilter');

    // Start unfiltered, so there is a full list to come back to.
    await win.waitForTimeout(2_000);
    await resetToFullList(panel, search);

    // Filter everything away with a committed query.
    await search.click();
    await search.press('Control+a');
    await search.press('Delete');
    await search.pressSequentially('Zzqqxx-no-such-note', { delay: 10 });
    await search.press('Enter');
    await expect
      .poll(async () => await listRowCount(panel), { timeout: 20_000, intervals: [500, 1500] })
      .toBe(0);

    // Now empty it with the KEYBOARD only - a real Backspace, no Enter, no blur. `input` is the only event
    // this fires, which is exactly the path that used to commit nothing.
    await search.click();
    await search.press('Control+a');
    await search.press('Backspace');
    expect(await search.inputValue()).toBe('');

    // The full list must come back by itself.
    await expect
      .poll(async () => await listRowCount(panel), { timeout: 20_000, intervals: [500, 1500] })
      .toBeGreaterThan(0);
    // The field stays empty afterwards - the reset commits the empty query, it does not repopulate the field
    // from the committed value.
    expect(await search.inputValue()).toBe('');
    // And the caret stays in the field across the reset's re-render. The auto-reset commits while the user is
    // still typing in the field, so losing focus here would be the worst case of all: the next keystroke would
    // go nowhere. Same mechanism as the Enter commit above - the render's blur is deferred, so reconcile's
    // restore still sees searchFocused and hands the freshly rendered field the caret back.
    await expect(search).toBeFocused();
  });

  /**
   * The Escape chain on an open dropdown: marks first, then the filter text, then the list. Each step is
   * swallowed, so the press never reaches the panel's other Escape handlers (the context menu, the
   * notebook/profile dropdowns, or the bare-Escape selection collapse added in 1.9.7).
   */
  test('Escape unwinds the dropdown one step at a time: marks, then filter text, then the list', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    const search = panel.locator('#searchFilter');
    const menu = panel.locator('#searchSuggestions');

    // As above: settle the previous test's commit, then clear and type with the keyboard so nothing commits
    // and no re-render can close the list mid-sequence.
    await win.waitForTimeout(2_000);
    await expect
      .poll(
        async () => {
          if (await menu.count()) return true;
          await search.click();
          await search.press('Control+a');
          await search.press('Delete');
          await search.pressSequentially('notebook:Cockpit', { delay: 20 });
          return (await menu.count()) > 0;
        },
        { timeout: 30_000, intervals: [500, 1000, 2000] }
      )
      .toBe(true);

    const row = menu.locator('.dropdown-item', { hasText: filterNotebook });
    await row.click({ modifiers: ['Control'] });
    await expect(row).toHaveClass(/-marked/);

    const filterBox = menu.locator('.suggest-filter-input');
    await filterBox.click();
    await filterBox.fill('Filter A');
    await expect(menu).toBeVisible();

    // 1. Marks go, list stays.
    await filterBox.press('Escape');
    await expect(menu).toBeVisible();
    await expect(row).not.toHaveClass(/-marked/);
    await expect(menu.locator('.suggest-apply')).toBeHidden();

    // 2. Filter text goes, list still stays.
    await filterBox.press('Escape');
    await expect(menu).toBeVisible();
    await expect(filterBox).toHaveValue('');

    // 3. Only now does the list close - and the caret is handed back to the search field, whose text is
    //    untouched by the whole sequence.
    await filterBox.press('Escape');
    await expect(menu).toHaveCount(0);
    expect(await search.inputValue()).toBe('notebook:Cockpit');
    expect(await panel.evaluate(() => document.activeElement?.id)).toBe('searchFilter');
  });
  /**
   * `any:1` must union the user's terms WITHOUT dissolving Cockpit's own narrowing.
   *
   * Cockpit builds its searches by concatenating its own terms onto the user's criteria (`type:todo`,
   * `iscompleted:0`, `due:...`). Joplin's any:1 ORs every term in the string, so each of those became an
   * alternative instead of a constraint - and `type:todo` matches every to-do, so the filter collapsed and the
   * panel listed everything (Slava: "any:1 shows notes with none of the tags"). The fix keeps Cockpit's terms
   * out of such a query and applies them to the results instead.
   *
   * Two terms, three to-dos: exactly the union of the two must show. Before the fix the third showed too.
   */
  test('any:1 shows the union of the terms, and nothing else', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    const search = panel.locator('#searchFilter');

    const stamp = `${Date.now()}`;
    const alpha = `Anyalpha${stamp}`;
    const beta = `Anybeta${stamp}`;
    const gamma = `Anygamma${stamp}`;
    for (const title of [alpha, beta, gamma]) await createTodo(win, title);

    await win.waitForTimeout(2_000);
    await resetToFullList(panel, search);
    // All three must be indexed and visible before the union can mean anything.
    await expect
      .poll(async () => {
        const shown = await panelTitles(panel);
        return [alpha, beta, gamma].every((t) => shown.some((row) => row.includes(t)));
      }, { timeout: PANEL_REFRESH_TIMEOUT, intervals: [1000, 2000, 3000] })
      .toBe(true);

    // The union of two of them.
    await search.click();
    await search.press('Control+a');
    await search.press('Delete');
    await search.pressSequentially(`title:${alpha} title:${beta} any:1`, { delay: 5 });
    await search.press('Enter');

    await expect
      .poll(async () => {
        const shown = await panelTitles(panel);
        return {
          alpha: shown.some((r) => r.includes(alpha)),
          beta: shown.some((r) => r.includes(beta)),
          gamma: shown.some((r) => r.includes(gamma)),
        };
      }, { timeout: PANEL_REFRESH_TIMEOUT, intervals: [1000, 2000, 3000] })
      // gamma false is the regression: with Cockpit's type:todo OR-ed in, EVERY to-do matched.
      .toEqual({ alpha: true, beta: true, gamma: false });

    // EXACTLY the union, nothing else. The membership check above would still pass if the list also carried
    // unrelated rows, which is precisely the shape the bug had: everything matched.
    expect(await listRowCount(panel)).toBe(2);
  });

  /**
   * Keystrokes typed straight after a commit must survive the commit's own re-render.
   *
   * A commit nulls the webview's uncommitted draft, so a render landing afterwards repainted the freshly
   * rendered field from its server-rendered (committed) value - and anything typed in between went with it.
   * The fix snapshots the OUTGOING field on its removal-blur (the last instant that node can still be read)
   * and uses it as the restore's fallback. Only the real GUI can decide this: the loss depends on where the
   * render lands relative to the keystrokes, which no source-shape check can reproduce.
   *
   * The suffix is typed with NO wait after Enter, exactly the race the report describes.
   */
  test('typing immediately after a commit is not swallowed by the commit’s own re-render', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    const search = panel.locator('#searchFilter');

    await win.waitForTimeout(2_000);
    await resetToFullList(panel, search);

    const base = `Zqcommit${Date.now()}`;
    const suffix = 'xyz';

    await search.click();
    await search.press('Control+a');
    await search.press('Delete');
    await search.pressSequentially(base, { delay: 10 });
    await search.press('Enter');
    // No settle: the render is now in flight, and these characters land while it is.
    await search.pressSequentially(suffix, { delay: 10 });

    // Whatever the render did, every character the user typed is still in the field, in order, once.
    await expect
      .poll(async () => await search.inputValue(), { timeout: 15_000, intervals: [300, 1000, 2000] })
      .toBe(base + suffix);
    // And the caret is still in the field, so the NEXT keystroke goes somewhere.
    await expect(search).toBeFocused();
  });

  /**
   * A background re-render must not empty the dropdown's own filter box (Slava: "Sync is a very often thing
   * here"). The marks already rode across such a render; the filter text, its caret and where the focus sat
   * did not, so a sync landing mid-selection widened the list back out and yanked the caret to the field.
   *
   * The render is provoked deterministically by ticking a to-do from the MAIN window - a real note change,
   * which is what a sync landing looks like to the panel - rather than by waiting for one.
   */
  test('a re-render mid-selection keeps the dropdown filter text, its caret and the focus', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    const search = panel.locator('#searchFilter');
    const menu = panel.locator('#searchSuggestions');

    await win.waitForTimeout(2_000);
    await resetToFullList(panel, search);

    // Open a notebook: list (the notebooks this spec created share the "Cockpit" prefix) and narrow it.
    await expect
      .poll(
        async () => {
          if (await menu.count()) return true;
          await search.click();
          await search.press('Control+a');
          await search.press('Delete');
          await win.waitForTimeout(1_500);
          await search.pressSequentially('notebook:Cockpit', { delay: 20 });
          return (await menu.count()) > 0;
        },
        { timeout: 30_000, intervals: [500, 1000, 2000] }
      )
      .toBe(true);

    const filterBox = menu.locator('.suggest-filter-input');
    await filterBox.click();
    await filterBox.pressSequentially('Filter', { delay: 20 });
    const narrowed = await panel.locator('#searchSuggestions .dropdown-item:not([hidden])').count();
    expect(narrowed, 'the filter must actually narrow the list, or the assertion below is vacuous').toBeGreaterThan(0);

    // Force a real re-render the way a landing SYNC does: from the host, with no click and no focus change.
    // A click anywhere in the panel would run the capture click-closer and shut the list before the render,
    // and any interaction in the main window would blur the field - neither is what a background refresh is.
    // Posting the host message directly reproduces exactly the part that matters: setHtml replaces the markup
    // underneath a live interaction. The render nonce is the panel's own witness that it happened.
    const nonce = async () => await panel.locator('.todos').first().getAttribute('data-render-nonce');
    const before = await nonce();
    await panel.evaluate(() => (window as any).webviewApi.postMessage(['sortDirectionClicked']));
    await expect
      .poll(nonce, { timeout: PANEL_REFRESH_TIMEOUT, intervals: [500, 1500, 2500] })
      .not.toBe(before);

    // The list is back, still narrowed, with the text and the caret where the user left them.
    await expect(menu).toHaveCount(1);
    await expect
      .poll(async () => await panel.locator('#searchSuggestions .suggest-filter-input').inputValue(), {
        timeout: 15_000,
        intervals: [300, 1000],
      })
      .toBe('Filter');
    const state = await panel.evaluate(() => {
      const box = document.querySelector('#searchSuggestions .suggest-filter-input') as HTMLInputElement | null;
      return {
        focusedIsBox: document.activeElement === box,
        caret: box ? box.selectionStart : null,
        visible: document.querySelectorAll('#searchSuggestions .dropdown-item:not([hidden])').length,
      };
    });
    expect(state.focusedIsBox, 'the caret must stay in the box the user was narrowing with').toBe(true);
    expect(state.caret).toBe('Filter'.length);
    expect(state.visible, 'the list must still be narrowed, not widened back out').toBe(narrowed);

    // Leave the field (and put the sort direction back) so the next test starts clean.
    await panel.locator('#searchSuggestions .suggest-filter-input').press('Escape'); // filter text
    await panel.locator('#searchFilter').press('Escape'); // the list
    await panel.evaluate(() => (window as any).webviewApi.postMessage(['sortDirectionClicked']));
  });

});
