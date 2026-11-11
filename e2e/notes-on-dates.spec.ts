import { test, expect, Frame } from '@playwright/test';
import * as http from 'http';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  agendaPanel,
  calendarNavigate,
  calendarToday,
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
 *
 * The range read (section 7 of the brief): the week planner and the month read every note of the days they draw from the note store. A note
 * posted over Joplin's data API with its creation stamp a week back - as an import or another client would write it - is drawn in its day
 * after Previous, and in that month's grid and selected-day list, and not in the current week. The data API is this throwaway profile's
 * clipper server, on a port no other spec uses (as in store-freshness.spec.ts); the store's readiness is read from Cockpit's plugin window.
 */
test.describe('Notes on dates', () => {
  let joplin: JoplinInstance;
  const todoTitle = 'Dated to-do';
  const noteTitle = 'Dated note';
  const pastTitle = 'Made a week ago';
  // Off Joplin's 41184 default and off every other spec's port (41197-41199, 41207, 41213-41218, 41221, 41231).
  const API_TOKEN = `cockpit-e2e-dates-${Date.now()}`;
  const API_PORT = 41232;
  // The store is built after the first paint (a 2 s timeout, then one walk); a cold, busy machine gets room.
  const STORE_READY_TIMEOUT_MS = 180_000;

  test.beforeAll(async () => {
    joplin = await launchJoplin({
      settings: { 'clipperServer.autoStart': true, 'api.token': API_TOKEN, 'api.port': API_PORT },
    });
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

  /** One request to Joplin's data API, with this profile's token; answers the parsed JSON, and throws on a refusal. */
  function apiJson(method: string, urlPath: string, body?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = http.request(
        {
          host: '127.0.0.1',
          port: API_PORT,
          method,
          path: urlPath + (urlPath.includes('?') ? '&' : '?') + `token=${API_TOKEN}`,
          headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
        },
        (response) => {
          let text = '';
          response.on('data', (chunk) => (text += chunk));
          response.on('end', () => {
            const status = response.statusCode || 0;
            if (status < 200 || status > 299) reject(new Error(`${method} ${urlPath} refused: ${status} ${text.slice(0, 300)}`));
            else resolve(text ? JSON.parse(text) : null);
          });
        }
      );
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  /** Whether Cockpit's note store is ready, asked in every page until the one holding Cockpit's handle answers; null while none does. */
  async function storeReady(): Promise<boolean | null> {
    for (const page of joplin.browser.contexts().flatMap((context) => context.pages())) {
      const answer = await Promise.race([
        page.evaluate(() => {
          const scope = globalThis as any;
          return scope.CockpitNoteStore ? !!scope.CockpitNoteStore.isReady() : null;
        }).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ]);
      if (answer !== null) return answer;
    }
    return null;
  }

  /** The local YYYY-MM-DD of a date, as the panel's data-drop names a day. */
  function dayKey(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

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

  test('range read: a note created a week ago is in its day after Previous, in that month\'s grid and day list, and not in this week', async () => {
    const { win } = joplin;
    await expect.poll(() => storeReady(), { timeout: STORE_READY_TIMEOUT_MS, intervals: [500, 1000, 2000] }).toBe(true);
    const folders = await apiJson('GET', '/folders?fields=id,title&limit=100');
    const folder = (folders.items || []).find((item: { title: string }) => item.title === 'Agenda E2E');
    if (!folder) throw new Error('the notebook "Agenda E2E" is not in the data API\'s folder list');
    // A week back at 10:00, built from calendar parts: always a day of the previous week, whatever day the suite runs on.
    const now = new Date();
    const past = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7, 10, 0, 0, 0);
    await apiJson('POST', '/notes', { title: pastTitle, parent_id: folder.id, user_created_time: past.getTime(), user_updated_time: past.getTime() });
    await editCurrentProfile(win, { displayFormat: 'week' });
    const panel = await agendaPanel(win);
    await calendarNavigate(win, 'Previous');
    // An outside write reaches the store on its next drain (the periodic tick at the latest), and the tick's render draws the week on screen.
    await expect(panel.locator(`.week-day[data-drop="${dayKey(past)}"] .todo.-note.-card`, { hasText: pastTitle })).toHaveCount(1, { timeout: PANEL_REFRESH_TIMEOUT });
    await calendarNavigate(win, 'Next');
    await expect(panel.locator('.week-day.-today')).toHaveCount(1, { timeout: PANEL_REFRESH_TIMEOUT });
    await expect(panel.locator('.week-planner .todo.-note', { hasText: pastTitle })).toHaveCount(0);
    await editCurrentProfile(win, { displayFormat: 'month' });
    await calendarToday(win);
    if (past.getMonth() !== now.getMonth()) await calendarNavigate(win, 'Previous');
    const pastCell = panel
      .locator('.calendar-day:not(.-outside)')
      .filter({ has: panel.locator(`.calendar-day-number:text-is("${past.getDate()}")`) });
    await expect(pastCell.locator('.calendar-dot.-note')).toHaveCount(1, { timeout: PANEL_REFRESH_TIMEOUT });
    await selectCalendarDay(win, past.getDate());
    await expect(panel.locator('.calendar-selected .todo.-note', { hasText: pastTitle })).toHaveCount(1, { timeout: PANEL_REFRESH_TIMEOUT });
    await calendarToday(win);
  });

  test('both switches off again: the note is back in the Notes section', async () => {
    const { win } = joplin;
    await editCurrentProfile(win, { displayFormat: 'interval', notesOnCreated: false });
    const panel = await agendaPanel(win);
    await expect(panel.locator('.notes-section .todo.-note', { hasText: noteTitle })).toHaveCount(1, { timeout: PANEL_REFRESH_TIMEOUT });
    expect(await headingOfNote(panel, noteTitle)).toBe('Notes');
  });
});
