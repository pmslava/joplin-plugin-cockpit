import { test, expect, Page, Frame } from '@playwright/test';
import * as http from 'http';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  agendaPanel,
  createNotebook,
  createTodo,
  editCurrentProfile,
  setCockpitCheckboxes,
  waitForPanelTodo,
  PANEL_REFRESH_TIMEOUT,
} from './helpers';

/**
 * The selected day (2.11, docs/BRIEF-2.11-dates-pins-drag.md section 3), in a real Joplin desktop, on the week planner.
 *
 * With "New to-do: due on the selected day" off - how every install starts - a click on a week-day heading selects nothing. Turned on through the
 * Options screen, the same click marks that day's section -selected (today keeps -today), the New to-do button creates a to-do due on that day at
 * the day start time (09:00 by default), and a right-click on the heading opens the panel's heading menu, whose "New to-do due <day>…" creates
 * another one due then. Jot is NOT installed here, so that item takes the fallback - Cockpit's own create, after telling the user once that Jot is
 * missing. That notice is a native modal on desktop (showMessageBoxSync, which would block the main process and this spec with it), so the spec
 * answers it in place: the renderer's bridge proxy is the one the plugin API calls, and `--env dev` publishes it as window.joplin.bridge.
 * The created to-dos' dues are read back through Joplin's own data API, not from the panel.
 */
test.describe('The selected day (desktop, week planner)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const book = `Cockpit SelDay ${stamp}`;
  const seededTodo = `SelDaySeed${stamp}`;
  const API_TOKEN = `cockpit-e2e-${stamp}`;
  const API_PORT = 41221;
  const SETTING_LABEL = 'New to-do: due on the selected day';
  let folderId = '';
  const seen = new Set<string>();

  function apiRequest(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = http.request(
        {
          host: '127.0.0.1',
          port: API_PORT,
          method,
          path,
          headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
        },
        (response) => {
          let text = '';
          response.on('data', (chunk) => (text += chunk));
          response.on('end', () => resolve({ status: response.statusCode || 0, text }));
        }
      );
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  /** The to-dos of the spec's notebook as Joplin stores them: id and due. */
  async function todosInBook(): Promise<{ id: string; todo_due: number }[]> {
    const got = await apiRequest('GET', `/folders/${folderId}/notes?token=${API_TOKEN}&fields=id,is_todo,todo_due&limit=100`);
    if (got.status !== 200) throw new Error(`the data API refused the notebook's notes: ${got.status} ${got.text}`);
    return (JSON.parse(got.text).items || []).filter((n: any) => n.is_todo).map((n: any) => ({ id: n.id, todo_due: Number(n.todo_due || 0) }));
  }

  /** The due of the one to-do that appeared in the notebook since the last call (polled: the create lands a beat after the click). */
  async function dueOfNewTodo(): Promise<number> {
    let fresh: { id: string; todo_due: number }[] = [];
    await expect
      .poll(async () => {
        fresh = (await todosInBook()).filter((n) => !seen.has(n.id));
        return fresh.length;
      }, { timeout: 30_000 })
      .toBe(1);
    seen.add(fresh[0].id);
    return fresh[0].todo_due;
  }

  /** The week planner's day keys in order, and which of them is today. */
  async function weekDays(frame: Frame): Promise<{ keys: string[]; today: string }> {
    return frame.evaluate(() => {
      const sections = Array.from(document.querySelectorAll('section.week-day'));
      const keys = sections.map((s) => s.getAttribute('data-drop') || '');
      const today = sections.find((s) => s.classList.contains('-today'));
      return { keys, today: today ? today.getAttribute('data-drop') || '' : '' };
    });
  }

  /** A day of the week on screen other than today: the next one, or the one before on the week's last day. */
  async function otherDay(win: Page): Promise<string> {
    const frame = await agendaPanel(win);
    await expect(frame.locator('section.week-day')).toHaveCount(7, { timeout: PANEL_REFRESH_TIMEOUT });
    const { keys, today } = await weekDays(frame);
    const at = keys.indexOf(today);
    expect(at).toBeGreaterThanOrEqual(0);
    return keys[at + 1 < keys.length ? at + 1 : at - 1];
  }

  const dayStart = (key: string) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d, 9, 0, 0, 0).getTime();
  };

  /** Point the panel at the spec's notebook (as jot-integration.spec.ts does), so a create needs no picker. */
  async function filterPanelTo(win: Page, notebook: string): Promise<void> {
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
            await panel.locator('#notebookMenu .dropdown-item', { hasText: notebook }).locator('.dropdown-label').first().click({ timeout: 5_000 });
          } catch {
            /* a repaint took the menu away mid-click; try again */
          }
          return nowOn();
        },
        { timeout: PANEL_REFRESH_TIMEOUT, intervals: [800, 1500, 2500] }
      )
      .toBe(notebook);
  }

  test.beforeAll(async () => {
    joplin = await launchJoplin({
      envDev: true,
      settings: { 'clipperServer.autoStart': true, 'api.token': API_TOKEN, 'api.port': API_PORT },
    });
    const { win } = joplin;
    await expect.poll(async () => (await apiRequest('GET', '/ping').catch(() => ({ status: 0 }))).status, { timeout: 60_000 }).toBe(200);
    await createNotebook(win, book);
    await createTodo(win, seededTodo);
    await waitForPanelTodo(win, seededTodo);
    const folders = await apiRequest('GET', `/folders?token=${API_TOKEN}&limit=100`);
    folderId = (JSON.parse(folders.text).items || []).find((f: any) => f.title === book).id;
    for (const n of await todosInBook()) seen.add(n.id);
    await editCurrentProfile(win, { displayFormat: 'week' });
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('setting off (the default): a click on a week-day heading selects nothing', async () => {
    const { win } = joplin;
    const day = await otherDay(win);
    const panel = await agendaPanel(win);
    await panel.locator(`section.week-day[data-drop="${day}"] > h2`).click();
    await win.waitForTimeout(2_000);
    await expect(panel.locator('section.week-day.-selected')).toHaveCount(0);
    await expect(panel.locator('section.week-day > h2[onclick]')).toHaveCount(0);
  });

  test('setting on: a click on a week-day heading selects that day, beside today, and New to-do is due on it at the day start', async () => {
    const { win } = joplin;
    await setCockpitCheckboxes(win, { [SETTING_LABEL]: true });
    await filterPanelTo(win, book);
    const day = await otherDay(win);
    const panel = await agendaPanel(win);
    await panel.locator(`section.week-day[data-drop="${day}"] > h2`).click();
    await expect(panel.locator(`section.week-day[data-drop="${day}"]`)).toHaveClass(/(^|\s)-selected(\s|$)/, { timeout: PANEL_REFRESH_TIMEOUT });
    await expect(panel.locator('section.week-day.-selected')).toHaveCount(1);
    await expect(panel.locator('section.week-day.-today')).not.toHaveClass(/-selected/);

    await panel.locator('button.create-button[aria-label="New to-do"]').click();
    expect(await dueOfNewTodo()).toBe(dayStart(day));
  });

  test('the heading menu: a right-click on the day\'s heading offers "New to-do due <day>…", which (Jot absent) creates a to-do due that day', async () => {
    const { win } = joplin;
    // Answer the one-time "Jot is not installed" notice in place, and keep what it said.
    await win.evaluate(() => {
      const debug = (window as any).joplin;
      debug.__messageBoxes = [];
      debug.bridge.showMessageBox = (message: string) => {
        debug.__messageBoxes.push(message);
        return 0;
      };
    });
    const day = await otherDay(win);
    const panel = await agendaPanel(win);
    await panel.locator(`section.week-day[data-drop="${day}"] > h2`).click({ button: 'right' });
    const menu = panel.locator('#noteContextMenu');
    await expect(menu).toBeVisible({ timeout: 10_000 });
    const item = menu.locator('.context-menu-item[data-action="newTodoDue"]');
    await expect(item).toHaveText(/^New to-do due .+…$/);
    await item.click();
    expect(await dueOfNewTodo()).toBe(dayStart(day));
    const boxes = await win.evaluate(() => (window as any).joplin.__messageBoxes as string[]);
    expect(boxes.length).toBe(1);
    expect(boxes[0]).toContain('Jot plugin');
  });

  test('setting off again: the week-day headings take no click and carry no -selected', async () => {
    const { win } = joplin;
    await setCockpitCheckboxes(win, { [SETTING_LABEL]: false });
    const day = await otherDay(win);
    const panel = await agendaPanel(win);
    await expect(panel.locator('section.week-day.-selected')).toHaveCount(0, { timeout: PANEL_REFRESH_TIMEOUT });
    await panel.locator(`section.week-day[data-drop="${day}"] > h2`).click();
    await win.waitForTimeout(2_000);
    await expect(panel.locator('section.week-day.-selected')).toHaveCount(0);
  });
});
