import { test, expect, Frame } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  agendaPanel,
  createNote,
  createNotebook,
  createTodo,
  editCurrentProfile,
  selectCalendarDay,
  setAlarm,
  waitForPanelTodo,
  PANEL_REFRESH_TIMEOUT,
} from './helpers';

/**
 * Notes on dates (2.11), driven through the real panel and the real profile editor: with "Show each note on the day it was created" ticked,
 * a note made in the spec is drawn among the to-dos on the day it was created - under Today in the interval list, in today's section of the
 * week planner, in the selected day's list under the month grid - and with both switches off it is back in the Notes section.
 */
test.describe('Notes on dates', () => {
  let joplin: JoplinInstance;
  const todoTitle = 'Dated to-do';
  const noteTitle = 'Dated note';

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    const { win } = joplin;
    await createNotebook(win, 'Agenda E2E');
    await createTodo(win, todoTitle);
    // Due at midday today: under Today in the interval list whatever time the suite runs at, and in today's week and month cells.
    const dueToday = new Date();
    dueToday.setHours(12, 0, 0, 0);
    await setAlarm(win, dueToday);
    await createNote(win, noteTitle);
    await waitForPanelTodo(win, noteTitle);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  /** The heading of the group the note's row is drawn in: the nearest h2 before it in the list, or null. */
  async function headingOfNote(frame: Frame, title: string): Promise<string | null> {
    return frame.evaluate((wanted) => {
      const row = Array.from(document.querySelectorAll('.todo[data-note-id]')).find((el) =>
        (el.querySelector('.todo-title')?.textContent || '').includes(wanted)
      );
      let el = row ? row.previousElementSibling : null;
      while (el && el.tagName !== 'H2') el = el.previousElementSibling;
      return el ? (el.textContent || '').trim() : null;
    }, title);
  }

  test('both switches off: the note is in the Notes section, as before', async () => {
    const panel = await agendaPanel(joplin.win);
    await expect(panel.locator('.notes-section .todo.-note', { hasText: noteTitle })).toHaveCount(1, { timeout: PANEL_REFRESH_TIMEOUT });
  });

  test('created switch on, interval: the note is under Today, after the day\'s to-do', async () => {
    const { win } = joplin;
    await editCurrentProfile(win, { notesOnCreated: true });
    const panel = await agendaPanel(win);
    await expect(panel.locator('.notes-section')).toHaveCount(0, { timeout: PANEL_REFRESH_TIMEOUT });
    await expect.poll(() => headingOfNote(panel, noteTitle), { timeout: PANEL_REFRESH_TIMEOUT }).toBe('Today');
    const order = await panel.evaluate(([todo, note]) => {
      const titles = Array.from(document.querySelectorAll('.todos .todo-title')).map((el) => el.textContent || '');
      return [titles.findIndex((t) => t.includes(todo)), titles.findIndex((t) => t.includes(note))];
    }, [todoTitle, noteTitle]);
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(order[1]).toBeGreaterThan(order[0]);
  });

  test('week planner: the note is a card in today\'s section', async () => {
    const { win } = joplin;
    await editCurrentProfile(win, { displayFormat: 'week' });
    const panel = await agendaPanel(win);
    await expect(panel.locator('.week-day.-today .todo.-note.-card', { hasText: noteTitle })).toHaveCount(1, { timeout: PANEL_REFRESH_TIMEOUT });
    await expect(panel.locator('.week-day.-today .todo.-card', { hasText: todoTitle })).toHaveCount(1);
  });

  test('month: today carries a note dot, and the selected day lists the note', async () => {
    const { win } = joplin;
    await editCurrentProfile(win, { displayFormat: 'month' });
    const panel = await agendaPanel(win);
    await expect(panel.locator('.calendar-day.-today .calendar-dot.-note')).toHaveCount(1, { timeout: PANEL_REFRESH_TIMEOUT });
    await selectCalendarDay(win, new Date().getDate());
    await expect(panel.locator('.calendar-selected .todo.-note', { hasText: noteTitle })).toHaveCount(1, { timeout: PANEL_REFRESH_TIMEOUT });
    await expect(panel.locator('.calendar-selected .todo', { hasText: todoTitle })).toHaveCount(1);
  });

  test('both switches off again: the note is back in the Notes section', async () => {
    const { win } = joplin;
    await editCurrentProfile(win, { displayFormat: 'interval', notesOnCreated: false });
    const panel = await agendaPanel(win);
    await expect(panel.locator('.notes-section .todo.-note', { hasText: noteTitle })).toHaveCount(1, { timeout: PANEL_REFRESH_TIMEOUT });
    expect(await headingOfNote(panel, noteTitle)).toBe('Notes');
  });
});
