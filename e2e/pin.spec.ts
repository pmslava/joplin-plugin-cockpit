import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  agendaPanel,
  createNotebook,
  createProfile,
  createTodo,
  panelHeadings,
  selectProfile,
  selectedProfileName,
  setAlarm,
  waitForPanelTodo,
  PANEL_REFRESH_TIMEOUT,
} from './helpers';

/**
 * Cockpit 2.11's Pin, in a real Joplin desktop with the setting at its default (Cockpit's Pinned section).
 *
 * The owner: "Pinned notes show in the section Pinned above Overdue ... Pinned notes/todos should be visible on all profiles, independently from
 * profile." Driven with real input from the panel: a right-click on the row opens Cockpit's row menu, whose Pin item sits right after Quick edit…;
 * the click pins the to-do, and the panel draws a "Pinned" heading above "Overdue" with the row under it. A second profile whose criteria match
 * nothing still shows the Pinned section; back on the first one, a right-click on the pinned row offers Unpin, and the section goes.
 */
test.describe('Pin (desktop)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const notebook = `Cockpit Pin ${stamp}`;
  const task = `PinTask${stamp}`;
  const emptyProfile = `Nothing ${stamp}`;
  let firstProfile = '';

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    const { win } = joplin;
    await createNotebook(win, notebook);
    await createTodo(win, task);
    // Due yesterday, so the to-do sits in Overdue.
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(10, 0, 0, 0);
    await setAlarm(win, yesterday);
    await waitForPanelTodo(win, task);
    firstProfile = await selectedProfileName(win);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  /** The titles of the rows the Pinned section draws, in order. */
  async function pinnedTitles(): Promise<string[]> {
    const panel = await agendaPanel(joplin.win);
    return (await panel.locator('.pinned-section .todo-title').allTextContents()).map((t) => t.trim());
  }

  /** Right-click the title of the first row matching `scope` that holds the task, and answer the menu's Pin item's text. */
  async function openRowMenu(scope: string): Promise<string> {
    const panel = await agendaPanel(joplin.win);
    const rowTitle = panel.locator(`${scope} .todo[data-todo-id]`, { hasText: task }).first().locator('.todo-title');
    await rowTitle.scrollIntoViewIfNeeded();
    await rowTitle.click({ button: 'right' });
    const menu = panel.locator('#noteContextMenu');
    await expect(menu).toHaveCount(1);
    const actions = await menu
      .locator('.context-menu-item')
      .evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.action || ''));
    expect(actions.slice(0, 3)).toEqual(['open', 'quickEdit', 'pin']);
    return ((await menu.locator('.context-menu-item[data-action="pin"]').textContent()) || '').trim();
  }

  async function clickPin(): Promise<void> {
    const panel = await agendaPanel(joplin.win);
    await panel.locator('#noteContextMenu .context-menu-item[data-action="pin"]').click();
  }

  test('Pin from the row menu draws a "Pinned" heading above "Overdue" with the row', async () => {
    expect(await panelHeadings(joplin.win)).not.toContain('Pinned');
    expect(await openRowMenu('.todos')).toBe('Pin');
    await clickPin();
    await expect.poll(async () => (await panelHeadings(joplin.win))[0], { timeout: PANEL_REFRESH_TIMEOUT }).toBe('Pinned');
    const headings = await panelHeadings(joplin.win);
    expect(headings.indexOf('Overdue')).toBeGreaterThan(0);
    const pinned = await pinnedTitles();
    expect(pinned.length).toBe(1);
    expect(pinned[0]).toContain(task);
    // The same to-do is still listed in Overdue, and both of its rows are marked pinned for the menu.
    const panel = await agendaPanel(joplin.win);
    expect(await panel.locator('.todo[data-todo-id][data-pinned="1"]', { hasText: task }).count()).toBe(2);
  });

  test('a profile that lists none of the to-dos still shows the Pinned section', async () => {
    await createProfile(joplin.win, { name: emptyProfile, searchCriteria: `nomatch${stamp}` });
    await expect.poll(async () => (await panelHeadings(joplin.win)).includes('Overdue'), { timeout: PANEL_REFRESH_TIMEOUT }).toBe(false);
    expect((await panelHeadings(joplin.win))[0]).toBe('Pinned');
    const pinned = await pinnedTitles();
    expect(pinned.length).toBe(1);
    expect(pinned[0]).toContain(task);
  });

  test('Unpin from the pinned row takes the section away', async () => {
    await selectProfile(joplin.win, firstProfile);
    await expect.poll(async () => (await panelHeadings(joplin.win)).includes('Overdue'), { timeout: PANEL_REFRESH_TIMEOUT }).toBe(true);
    expect(await openRowMenu('.pinned-section')).toBe('Unpin');
    await clickPin();
    await expect.poll(async () => (await panelHeadings(joplin.win)).includes('Pinned'), { timeout: PANEL_REFRESH_TIMEOUT }).toBe(false);
    expect(await pinnedTitles()).toEqual([]);
    await waitForPanelTodo(joplin.win, task);
    const panel = await agendaPanel(joplin.win);
    expect(await panel.locator('[data-pinned]').count()).toBe(0);
  });
});
