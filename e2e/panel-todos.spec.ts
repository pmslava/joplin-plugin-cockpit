import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  agendaPanel,
  checkPanelTodo,
  clickPanelTodo,
  createNotebook,
  createTodo,
  editCurrentProfile,
  isSelectedTodoComplete,
  panelHeadings,
  panelTodoTitles,
  selectNote,
  setAlarm,
  waitForPanelTodo,
  waitForPanelTodoGone,
  PANEL_REFRESH_TIMEOUT,
} from './helpers';

/**
 * The core of what Agenda does: show the to-dos that match the current profile, grouped by when
 * they are due, and let the user tick them off and open them straight from the panel.
 */
test.describe('Panel to-do list', () => {
  let joplin: JoplinInstance;
  const overdueTitle = 'Overdue task';
  const todayTitle = 'Today task';
  const noDueTitle = 'Someday task';

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    const { win } = joplin;
    await createNotebook(win, 'Agenda E2E');

    await createTodo(win, overdueTitle);
    await setAlarm(win, new Date(Date.now() - 26 * 3600 * 1000));

    await createTodo(win, todayTitle);
    await setAlarm(win, new Date(Date.now() + 2 * 3600 * 1000));

    // Left without an alarm on purpose: the default profile must not show it.
    await createTodo(win, noDueTitle);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('to-dos with a due date appear in the panel', async () => {
    const { win } = joplin;
    await waitForPanelTodo(win, todayTitle);
    await waitForPanelTodo(win, overdueTitle);
  });

  test('to-dos are grouped by when they are due, in chronological order', async () => {
    const headings = await panelHeadings(joplin.win);
    expect(headings).toEqual(['Overdue', 'Today']);

    const titles = await panelTodoTitles(joplin.win);
    expect(titles.findIndex((t) => t.includes(overdueTitle))).toBeLessThan(
      titles.findIndex((t) => t.includes(todayTitle))
    );
  });

  test('the due time is shown alongside the title', async () => {
    const titles = await panelTodoTitles(joplin.win);
    const today = titles.find((t) => t.includes(todayTitle))!;
    // The interval format prefixes to-dos due today with their time, e.g. "6:20 PM - Today task".
    expect(today).toMatch(/\d{1,2}:\d{2}.*-\s*Today task/);
  });

  test('to-dos without a due date are hidden by default', async () => {
    expect((await panelTodoTitles(joplin.win)).some((t) => t.includes(noDueTitle))).toBe(false);
  });

  test('enabling "show without due dates" reveals them', async () => {
    const { win } = joplin;
    await editCurrentProfile(win, { showNoDue: true });
    await waitForPanelTodo(win, noDueTitle);
    expect(await panelHeadings(win)).toContain('No Due Date');

    await editCurrentProfile(win, { showNoDue: false });
    await waitForPanelTodoGone(win, noDueTitle);
  });

  test('clicking a to-do in the panel opens it in the editor', async () => {
    const { win } = joplin;
    // Move the selection elsewhere first so the click has something to change.
    await selectNote(win, noDueTitle);
    await clickPanelTodo(win, overdueTitle);

    await expect
      .poll(async () => win.locator('input.title-input').inputValue(), { timeout: 30_000 })
      .toBe(overdueTitle);
  });

  test('ticking a to-do in the panel completes it in Joplin and drops it from the list', async () => {
    const { win } = joplin;
    await checkPanelTodo(win, todayTitle);

    await selectNote(win, todayTitle);
    await expect.poll(() => isSelectedTodoComplete(win), { timeout: 30_000 }).toBe(true);

    // The default profile hides completed to-dos, so it should leave the panel by itself.
    await waitForPanelTodoGone(win, todayTitle);
  });

  test('a profile that shows completed to-dos lists it again', async () => {
    const { win } = joplin;
    await editCurrentProfile(win, { showCompleted: true });
    await waitForPanelTodo(win, todayTitle);

    const panel = await agendaPanel(win);
    await expect(
      panel.locator('.todo', { hasText: todayTitle }).locator('.todo-checkbox')
    ).toBeChecked({ timeout: PANEL_REFRESH_TIMEOUT });
  });
});
