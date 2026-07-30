import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  agendaPanel,
  calendarNavigate,
  calendarTitle,
  calendarToday,
  calendarWeekdayHeadings,
  createNotebook,
  createTodo,
  editCurrentProfile,
  selectCalendarDay,
  selectedDayTodos,
  setAlarm,
  waitForPanelTodo,
  weekPlannerDays,
  PANEL_REFRESH_TIMEOUT,
} from './helpers';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The calendar views, driven through the real panel: a month grid whose days carry a dot per to-do,
 * and a week planner listing each day's to-dos in place.
 */
test.describe('Calendar views', () => {
  let joplin: JoplinInstance;
  const todayTitle = 'Calendar task';

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    const { win } = joplin;
    await createNotebook(win, 'Agenda E2E');
    await createTodo(win, todayTitle);
    await setAlarm(win, new Date(Date.now() + 3 * 3600 * 1000));
    await waitForPanelTodo(win, todayTitle);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('the month format renders a grid of whole weeks', async () => {
    const { win } = joplin;
    await editCurrentProfile(win, { displayFormat: 'month' });

    const panel = await agendaPanel(win);
    await expect(panel.locator('.calendar-grid')).toBeVisible({ timeout: PANEL_REFRESH_TIMEOUT });

    expect(await calendarWeekdayHeadings(win)).toHaveLength(7);
    const cells = await panel.locator('.calendar-day-button').count();
    expect(cells % 7).toBe(0);
    expect(cells).toBeGreaterThanOrEqual(28);
    expect(cells).toBeLessThanOrEqual(42);
  });

  test('today is marked and the to-do shows as a dot', async () => {
    const panel = await agendaPanel(joplin.win);
    await expect(panel.locator('.calendar-day.-today')).toHaveCount(1);
    await expect(panel.locator('.calendar-dot').first()).toBeVisible();

    // Captured so the layout can be eyeballed after a change.
    const outDir = path.join(__dirname, '..', 'test-results');
    fs.mkdirSync(outDir, { recursive: true });
    await joplin.win.screenshot({ path: path.join(outDir, 'month-calendar.png') });
  });

  test('navigating changes the month and today returns to it', async () => {
    const { win } = joplin;
    const startTitle = await calendarTitle(win);

    await calendarNavigate(win, 'Next');
    const nextTitle = await calendarTitle(win);
    expect(nextTitle).not.toBe(startTitle);

    await calendarNavigate(win, 'Previous');
    expect(await calendarTitle(win)).toBe(startTitle);

    await calendarNavigate(win, 'Previous');
    await calendarToday(win);
    expect(await calendarTitle(win)).toBe(startTitle);
  });

  test('selecting a day lists its to-dos and selecting it again hides them', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    const today = new Date().getDate();

    await selectCalendarDay(win, today);
    await expect(panel.locator('.calendar-selected')).toBeVisible({ timeout: PANEL_REFRESH_TIMEOUT });
    expect((await selectedDayTodos(win)).some((t) => t.includes(todayTitle))).toBe(true);

    await selectCalendarDay(win, today);
    await expect(panel.locator('.calendar-selected')).toHaveCount(0);
  });

  test('the week planner lists seven days with the to-do in place', async () => {
    const { win } = joplin;
    await editCurrentProfile(win, { displayFormat: 'week' });

    const panel = await agendaPanel(win);
    await expect(panel.locator('.week-planner')).toBeVisible({ timeout: PANEL_REFRESH_TIMEOUT });
    expect(await weekPlannerDays(win)).toHaveLength(7);

    await expect(panel.locator('.week-day.-today')).toHaveCount(1);
    await expect(
      panel.locator('.week-day', { hasText: todayTitle }).locator('.todo-checkbox')
    ).toHaveCount(1);

    // Captured so the layout can be eyeballed after a change.
    const outDir = path.join(__dirname, '..', 'test-results');
    fs.mkdirSync(outDir, { recursive: true });
    await win.screenshot({ path: path.join(outDir, 'week-planner.png') });
  });

  test('the week planner navigates a week at a time', async () => {
    const { win } = joplin;
    const startTitle = await calendarTitle(win);

    await calendarNavigate(win, 'Next');
    expect(await calendarTitle(win)).not.toBe(startTitle);

    await calendarToday(win);
    expect(await calendarTitle(win)).toBe(startTitle);
  });

  test('switching back to a list format restores the grouped list', async () => {
    const { win } = joplin;
    await editCurrentProfile(win, { displayFormat: 'interval' });

    const panel = await agendaPanel(win);
    await expect(panel.locator('.calendar-grid')).toHaveCount(0, { timeout: PANEL_REFRESH_TIMEOUT });
    await waitForPanelTodo(win, todayTitle);
  });
});
