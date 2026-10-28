import { test, expect, Page } from '@playwright/test';
import * as http from 'http';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import * as fs from 'fs';
import * as path from 'path';
import {
  agendaPanel,
  createNotebook,
  selectedProfileName,
  PANEL_REFRESH_TIMEOUT,
  PANEL_IFRAME,
  activateJoplinMenuItem,
  dockCockpitPanelLeft,
  setJoplinWindowSize,
} from './helpers';

/**
 * Real-app cover for the header's quick filters (2.10, docs/BRIEF-2.10-quick-filters.md): the four one-press buttons
 * that took the sort picker's place in the second header row. One completed to-do and three notes - one with an open
 * checkbox inside, one with all of its checkboxes ticked, one with none - are seeded through Joplin's own data API
 * (the clipper server is preset on the throwaway profile, as type-flip.spec.ts does), because only the data API can
 * write a body in one step. Each button is then released and pressed again, and the rows are read back: what it hides,
 * that nothing else moves, the pressed state on the button, and the profile picker's "view changed" asterisk.
 *
 * The harness suite (npm test) pins the semantics row by row and the cost of the checkbox scan; this proves the same
 * buttons do it in genuine Joplin, against bodies Joplin itself stored.
 */
test.describe('Quick filters (desktop)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const book = `Cockpit QFilter ${stamp}`;
  const profileName = 'All todo and notes';

  // Joplin's own data API on this throwaway profile, on a port no other spec uses.
  const API_TOKEN = `cockpit-e2e-${stamp}`;
  const API_PORT = 41218;

  // The seeded items, by key. The completed to-do has no checkboxes inside, so "Items without checkboxes" hides it too.
  const FIXTURES: Record<string, { title: string; body: string; is_todo: number; todo_completed?: number }> = {
    open: { title: `qf-open-${stamp}`, body: 'Steps\n\n- [x] first\n- [ ] second\n', is_todo: 0 },
    done: { title: `qf-done-${stamp}`, body: 'Steps\n\n- [x] first\n- [x] second\n', is_todo: 0 },
    plain: { title: `qf-plain-${stamp}`, body: 'No checkboxes in this one.\n', is_todo: 0 },
    completed: { title: `qf-completed-${stamp}`, body: 'Finished.\n', is_todo: 1, todo_completed: Date.now() },
  };
  const ALL = Object.keys(FIXTURES).sort();
  // What releasing each button hides; pressing it again brings exactly that back.
  const HIDES: Array<[string, string[]]> = [
    ['completedTodos', ['completed']],
    ['openCheckboxes', ['open']],
    ['doneCheckboxes', ['done']],
    ['noCheckboxes', ['completed', 'plain']],
  ];
  const ids: Record<string, string> = {};
  // QF_SHOTS=<dir>: Joplin dark, and a last case that docks the panel and captures it with the filters pressed and with one released.
  const SHOTS_DIR = process.env.QF_SHOTS || '';

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    joplin = await launchJoplin({
      settings: {
        'clipperServer.autoStart': true,
        'api.token': API_TOKEN,
        'api.port': API_PORT,
        ...(SHOTS_DIR ? { theme: 2, themeAutoDetect: false, 'editor.migration': 1, richTextBannerDismissed: true } : {}),
      },
    });
    const { win } = joplin;
    await createNotebook(win, book);
    await apiReady(win);
    const folderId = await folderIdByTitle(book);
    for (const [key, fixture] of Object.entries(FIXTURES)) {
      const made = await apiRequest('POST', `/notes?token=${API_TOKEN}`, { ...fixture, parent_id: folderId });
      if (made.status !== 200) throw new Error(`the data API refused ${key}: ${made.status} ${made.text}`);
      ids[key] = JSON.parse(made.text).id;
    }
    // The fresh profile shows everything, completed to-dos and notes included, so all four are drawn once Joplin has them.
    await expect.poll(() => drawnKeys(win), { timeout: PANEL_REFRESH_TIMEOUT }).toEqual(ALL);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  /** One request to Joplin's data API. */
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

  /** Wait for the clipper server to answer before anything is seeded through it. */
  async function apiReady(win: Page): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        if ((await apiRequest('GET', '/ping')).status === 200) return;
      } catch {
        /* not up yet */
      }
      await win.waitForTimeout(1000);
    }
    throw new Error('Joplin data API never answered on 127.0.0.1:' + API_PORT);
  }

  /** The id of the notebook the GUI just created. */
  async function folderIdByTitle(title: string): Promise<string> {
    const got = await apiRequest('GET', `/folders?token=${API_TOKEN}&limit=100`);
    if (got.status !== 200) throw new Error(`the data API refused the folder list: ${got.status} ${got.text}`);
    const found = (JSON.parse(got.text).items || []).find((folder: any) => folder.title === title);
    if (!found) throw new Error(`no notebook titled ${title} in the data API's folder list`);
    return found.id;
  }

  /** The keys of the seeded items the panel draws right now, as a to-do row or a Notes row, sorted. */
  async function drawnKeys(win: Page): Promise<string[]> {
    const panel = await agendaPanel(win);
    const seeded = Object.entries(ids);
    const drawn = await panel.evaluate(
      (pairs) => pairs.filter(([, id]) => document.querySelector(`.todo[data-todo-id="${id}"], .todo[data-note-id="${id}"]`)).map(([key]) => key),
      seeded
    );
    return drawn.sort();
  }

  /** The aria-pressed state of one quick-filter button. */
  async function pressedState(win: Page, filter: string): Promise<string | null> {
    const panel = await agendaPanel(win);
    return panel.locator(`#quickFilters .quick-filter[data-filter="${filter}"]`).getAttribute('aria-pressed');
  }

  /** How many checkbox-scan status lines (#checkboxScan, "Reading the checkboxes inside N notes…") the panel shows right now. */
  async function scanLineCount(win: Page): Promise<number> {
    const panel = await agendaPanel(win);
    return panel.locator('#checkboxScan').count();
  }

  /** Which of the given items (key -> note id) the panel draws right now, sorted. */
  async function drawnOf(win: Page, items: Record<string, string>): Promise<string[]> {
    const panel = await agendaPanel(win);
    const drawn = await panel.evaluate(
      (pairs) => pairs.filter(([, id]) => document.querySelector(`.todo[data-todo-id="${id}"], .todo[data-note-id="${id}"]`)).map(([key]) => key),
      Object.entries(items)
    );
    return drawn.sort();
  }

  async function pressFilter(win: Page, filter: string): Promise<void> {
    const panel = await agendaPanel(win);
    await panel.locator(`#quickFilters .quick-filter[data-filter="${filter}"]`).click();
  }

  test('the second header row holds the four buttons, all pressed, and no sort picker', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    const filters = await panel.locator('#filterRow #quickFilters .quick-filter').evaluateAll((buttons) =>
      buttons.map((button) => [button.getAttribute('data-filter'), button.getAttribute('aria-pressed')])
    );
    expect(filters).toEqual([
      ['completedTodos', 'true'],
      ['openCheckboxes', 'true'],
      ['doneCheckboxes', 'true'],
      ['noCheckboxes', 'true'],
    ]);
    expect(await panel.locator('#sortMenu').count()).toBe(0);
    expect(await panel.locator('button[onclick="onSortDirectionClicked()"]').count()).toBe(0);
    expect(await selectedProfileName(win)).toBe(profileName);
  });

  for (const [filter, hidden] of HIDES) {
    test(`releasing "${filter}" hides ${hidden.join(' and ')}, and pressing it again brings ${hidden.length > 1 ? 'them' : 'it'} back`, async () => {
      const { win } = joplin;
      await pressFilter(win, filter);
      await expect.poll(() => pressedState(win, filter), { timeout: 20_000 }).toBe('false');
      await expect.poll(() => drawnKeys(win), { timeout: 30_000 }).toEqual(ALL.filter((key) => !hidden.includes(key)));
      // A checkbox filter's scan status line is transient: once every row is judged it is gone, never left standing.
      await expect.poll(() => scanLineCount(win), { timeout: 30_000 }).toBe(0);
      // The view no longer matches the profile, which says so.
      await expect.poll(() => selectedProfileName(win), { timeout: 20_000 }).toBe(`${profileName}*`);

      await pressFilter(win, filter);
      await expect.poll(() => pressedState(win, filter), { timeout: 20_000 }).toBe('true');
      await expect.poll(() => drawnKeys(win), { timeout: 30_000 }).toEqual(ALL);
      expect(await scanLineCount(win)).toBe(0);
      await expect.poll(() => selectedProfileName(win), { timeout: 20_000 }).toBe(profileName);
    });
  }

  test('the three checkbox buttons released together leave the list empty, and the profile marked', async () => {
    const { win } = joplin;
    for (const filter of ['openCheckboxes', 'doneCheckboxes', 'noCheckboxes']) {
      await pressFilter(win, filter);
      await expect.poll(() => pressedState(win, filter), { timeout: 20_000 }).toBe('false');
    }
    await expect.poll(() => drawnKeys(win), { timeout: 30_000 }).toEqual([]);
    await expect.poll(() => selectedProfileName(win), { timeout: 20_000 }).toBe(`${profileName}*`);
    for (const filter of ['openCheckboxes', 'doneCheckboxes', 'noCheckboxes']) {
      await pressFilter(win, filter);
      await expect.poll(() => pressedState(win, filter), { timeout: 20_000 }).toBe('true');
    }
    await expect.poll(() => drawnKeys(win), { timeout: 30_000 }).toEqual(ALL);
    await expect.poll(() => selectedProfileName(win), { timeout: 20_000 }).toBe(profileName);
  });
  /**
   * The scan's own path, on rows Cockpit has never counted: notes that arrive while a checkbox filter is released have no counts, so they are
   * unread - left out, read, then judged - rather than drawn by default. And a row counted before is judged again once its body changes
   * (the counts cache is stamped with user_updated_time): a note whose last checkbox is unticked moves from "all done" to "open".
   */
  test('notes added or edited while a checkbox filter is released are read and judged by their bodies', async () => {
    const { win } = joplin;
    const folderId = await folderIdByTitle(book);
    await pressFilter(win, 'noCheckboxes');
    await expect.poll(() => pressedState(win, 'noCheckboxes'), { timeout: 20_000 }).toBe('false');
    await expect.poll(() => drawnKeys(win), { timeout: 30_000 }).toEqual(['done', 'open']);

    const added: Record<string, string> = {};
    const bodies: Record<string, string> = { addedOpen: '- [ ] a\n', addedDone: '- [x] b\n', addedPlain: 'Nothing to tick.\n' };
    for (const [key, body] of Object.entries(bodies)) {
      const made = await apiRequest('POST', `/notes?token=${API_TOKEN}`, { title: `qf-${key}-${stamp}`, body, is_todo: 0, parent_id: folderId });
      if (made.status !== 200) throw new Error(`the data API refused ${key}: ${made.status} ${made.text}`);
      added[key] = JSON.parse(made.text).id;
    }
    // The two with checkboxes come in once read; the plain one is read and stays out, and no status line is left standing.
    await expect.poll(() => drawnOf(win, added), { timeout: PANEL_REFRESH_TIMEOUT }).toEqual(['addedDone', 'addedOpen']);
    await expect.poll(() => scanLineCount(win), { timeout: 30_000 }).toBe(0);
    // Held for a while, so a late repaint that would let the plain note in is caught.
    await win.waitForTimeout(5_000);
    expect(await drawnOf(win, added)).toEqual(['addedDone', 'addedOpen']);
    expect(await drawnKeys(win)).toEqual(['done', 'open']);

    // Pressed again, the plain one (and the original plain note and completed to-do) come back.
    await pressFilter(win, 'noCheckboxes');
    await expect.poll(() => pressedState(win, 'noCheckboxes'), { timeout: 20_000 }).toBe('true');
    await expect.poll(() => drawnOf(win, added), { timeout: 30_000 }).toEqual(['addedDone', 'addedOpen', 'addedPlain']);
    await expect.poll(() => drawnKeys(win), { timeout: 30_000 }).toEqual(ALL);

    // "All done" released hides the done notes; unticking the box in one of them moves it to "open", and it comes back.
    await pressFilter(win, 'doneCheckboxes');
    await expect.poll(() => pressedState(win, 'doneCheckboxes'), { timeout: 20_000 }).toBe('false');
    await expect.poll(() => drawnOf(win, added), { timeout: 30_000 }).toEqual(['addedOpen', 'addedPlain']);
    const edited = await apiRequest('PUT', `/notes/${added.addedDone}?token=${API_TOKEN}`, { body: '- [ ] b\n' });
    if (edited.status !== 200) throw new Error(`the data API refused the edit: ${edited.status} ${edited.text}`);
    await expect.poll(() => drawnOf(win, added), { timeout: PANEL_REFRESH_TIMEOUT }).toEqual(['addedDone', 'addedOpen', 'addedPlain']);
    expect(await drawnKeys(win)).toEqual(['completed', 'open', 'plain']);
    await expect.poll(() => scanLineCount(win), { timeout: 30_000 }).toBe(0);

    await pressFilter(win, 'doneCheckboxes');
    await expect.poll(() => pressedState(win, 'doneCheckboxes'), { timeout: 20_000 }).toBe('true');
    await expect.poll(() => drawnKeys(win), { timeout: 30_000 }).toEqual(ALL);
    await expect.poll(() => selectedProfileName(win), { timeout: 20_000 }).toBe(profileName);
  });
  // Opt-in (QF_SHOTS=<dir>): the panel docked left in Joplin's dark theme, captured with all four filters pressed and with "Items without
  // checkboxes" released, for a look at the two button states. Not an assertion of the look; the cases above prove the behaviour.
  test('captures the panel with the filters pressed and with one released', async () => {
    test.skip(!SHOTS_DIR, 'screenshots only with QF_SHOTS=<dir>');
    const { win } = joplin;
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await setJoplinWindowSize(win, 1600, 1000);
    await activateJoplinMenuItem(win, /^Toggle sidebar$/);
    await win.waitForTimeout(1200);
    await activateJoplinMenuItem(win, /^Toggle note list$/);
    await win.waitForTimeout(1500);
    expect(await dockCockpitPanelLeft(win, PANEL_IFRAME)).toBe(true);
    await expect.poll(() => drawnKeys(win), { timeout: 30_000 }).toEqual(ALL);
    await win.mouse.move(1500, 900);
    await win.waitForTimeout(1500);
    await win.locator(PANEL_IFRAME).screenshot({ path: path.join(SHOTS_DIR, 'quick-filters-all-pressed.png') });

    await pressFilter(win, 'noCheckboxes');
    await expect.poll(() => pressedState(win, 'noCheckboxes'), { timeout: 20_000 }).toBe('false');
    await expect.poll(() => drawnKeys(win), { timeout: 30_000 }).toEqual(['done', 'open']);
    await expect.poll(() => scanLineCount(win), { timeout: 30_000 }).toBe(0);
    // Off the button, so the capture shows the released state rather than its hover.
    await win.mouse.move(1500, 900);
    await win.waitForTimeout(1500);
    await win.locator(PANEL_IFRAME).screenshot({ path: path.join(SHOTS_DIR, 'quick-filters-no-checkboxes-released.png') });

    await pressFilter(win, 'noCheckboxes');
    await expect.poll(() => pressedState(win, 'noCheckboxes'), { timeout: 20_000 }).toBe('true');
  });
});
