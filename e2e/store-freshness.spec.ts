import { test, expect, Page } from '@playwright/test';
import * as http from 'http';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import { agendaPanel, createNotebook, createTodo, setCockpitTextSetting, PANEL_REFRESH_TIMEOUT } from './helpers';

/**
 * Cockpit 2.7, phase 4: with the note store serving every view, a change reaches the panel through Joplin's change feed - the
 * `events` route the store drains - and no longer through the search index. These specs hold the panel to the two routes a change
 * can take, against a genuine Joplin, with the default profile (no criteria, nothing typed, no overview note), which is exactly a
 * view the store serves once it is ready:
 *
 *  - a change to the note OPEN in the editor fires onNoteChange, whose debounced poll drains the feed and renders once. That is
 *    measured first, while the refresh interval is still Joplin's default 60 s, so no periodic tick can be what delivers it;
 *  - a change to a note that is NOT open - a rename, a trash, a create, all made over Joplin's REST data API as any outside client
 *    would - fires no event at all. Only the periodic tick's poll can see it, so the refresh interval is set to its minimum (1 s:
 *    setupTimer in src/core/timer.ts reads anything below 1 as the default) and each change must show within two intervals. Before
 *    2.7 such a change waited for Joplin's own search index, seconds later, and then for the tick after that.
 *
 * The data API is this throwaway profile's clipper server, on a port no other spec uses, as in type-flip.spec.ts. Cockpit's refresh
 * interval lives in Joplin's database, not in settings.json, so it cannot be preset: it is set through the Options screen. The store's
 * readiness, and that every view is one the store serves (so the triggers take their phase 4 paths), are read from Cockpit's own plugin
 * window, where Cockpit publishes CockpitNoteStore and CockpitTriggers on the global (the perf spec reads CockpitInstrument the same way).
 */
test.describe('Note store freshness (desktop)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const book = `Cockpit Fresh ${stamp}`;
  // Off Joplin's 41184 default and off every other spec's port (41197, 41198, 41199, 41207, 41213-41215).
  const API_TOKEN = `cockpit-e2e-fresh-${stamp}`;
  const API_PORT = 41216;
  // The smallest refresh interval Cockpit honours, in seconds, and the budget an outside change has to show within.
  const REFRESH_INTERVAL_S = 1;
  const TWO_INTERVALS_MS = 2 * REFRESH_INTERVAL_S * 1000;
  // What the note-change path gets: its 250 ms debounce, the drain, one render - well inside this, and far inside the 60 s tick.
  const NOTE_CHANGE_BUDGET_MS = 3_000;
  // The store is built after the first paint (a 2 s timeout, then one walk of the listing); a cold, busy machine gets room.
  const STORE_READY_TIMEOUT_MS = 180_000;
  let folderID = '';
  let intervalSet = false;

  test.beforeAll(async () => {
    intervalSet = false;
    joplin = await launchJoplin({
      settings: { 'clipperServer.autoStart': true, 'api.token': API_TOKEN, 'api.port': API_PORT },
    });
    const { win } = joplin;
    await createNotebook(win, book);
    await apiReady(win);
    const folders = await apiJson('GET', '/folders?fields=id,title&limit=100');
    const folder = (folders.items || []).find((item: { title: string }) => item.title === book);
    if (!folder) throw new Error(`the notebook "${book}" is not in the data API's folder list`);
    folderID = folder.id;
    await waitForStoreReady();
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  /** One request to Joplin's data API, with this profile's token. */
  function apiRequest(method: string, urlPath: string, body?: unknown): Promise<{ status: number; text: string }> {
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
          response.on('end', () => resolve({ status: response.statusCode || 0, text }));
        }
      );
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  /** A request that must succeed; answers the parsed JSON (null for an empty body). */
  async function apiJson(method: string, urlPath: string, body?: unknown): Promise<any> {
    const got = await apiRequest(method, urlPath, body);
    if (got.status < 200 || got.status > 299) throw new Error(`${method} ${urlPath} refused: ${got.status} ${got.text.slice(0, 300)}`);
    return got.text ? JSON.parse(got.text) : null;
  }

  /** Wait until OUR Joplin answers with OUR token, so no change is lost to a not-yet-started server. */
  async function apiReady(win: Page): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        if ((await apiRequest('GET', '/folders?limit=1')).status === 200) return;
      } catch {
        /* not up yet */
      }
      await win.waitForTimeout(1000);
    }
    throw new Error('Joplin data API never answered on 127.0.0.1:' + API_PORT);
  }

  /**
   * A question asked in Cockpit's own plugin window: every page is asked, and the one whose global holds Cockpit's handles answers.
   * null while no page does (the plugin has not loaded yet).
   */
  async function askPlugin(question: 'storeReady' | 'allViewsStoreServed'): Promise<boolean | null> {
    for (const page of joplin.browser.contexts().flatMap((context) => context.pages())) {
      const answer = await Promise.race([
        page
          .evaluate(async (asked) => {
            const scope = globalThis as any;
            if (asked === 'storeReady') return scope.CockpitNoteStore ? !!scope.CockpitNoteStore.isReady() : null;
            return scope.CockpitTriggers ? !!(await scope.CockpitTriggers.allConsumersStoreServed()) : null;
          }, question)
          .catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ]);
      if (answer !== null) return answer;
    }
    return null;
  }

  /**
   * The store is ready, AND the triggers take their store-served paths: every view is one the store answers. Without the second half these
   * specs would pass on phase 3's code as well, whose search and reconcile paths deliver the same changes, only later.
   */
  async function waitForStoreReady(): Promise<void> {
    await expect.poll(() => askPlugin('storeReady'), { timeout: STORE_READY_TIMEOUT_MS, intervals: [500, 1000, 2000] }).toBe(true);
    expect(await askPlugin('allViewsStoreServed')).toBe(true);
  }

  /** The refresh interval at its minimum, once per Joplin instance (a retry's beforeAll starts a fresh one). */
  async function ensureMinimumInterval(win: Page): Promise<void> {
    if (intervalSet) return;
    await setCockpitTextSetting(win, 'Panel refresh interval (seconds)', String(REFRESH_INTERVAL_S));
    intervalSet = true;
    // The Options screen covered the main window: wait for the panel to be back, and for the store to still be serving.
    await agendaPanel(win);
    await waitForStoreReady();
  }

  /** The row the panel draws for an id, of either kind, and its title; null when there is none. */
  async function rowOf(win: Page, id: string): Promise<{ kind: 'todo' | 'note'; title: string } | null> {
    try {
      const panel = await agendaPanel(win);
      return await panel.evaluate((noteId) => {
        const todo = document.querySelector(`.todo[data-todo-id="${noteId}"]`);
        const note = document.querySelector(`.todo[data-note-id="${noteId}"]`);
        const row = todo || note;
        if (!row) return null;
        const title = row.querySelector('.todo-title');
        return { kind: todo ? 'todo' : 'note', title: (title && title.textContent ? title.textContent : '').trim() };
      }, id);
    } catch {
      // The panel was being replaced while it was read: no observation.
      return null;
    }
  }

  /** How long until `settled` holds for the id's row, sampled every 50 ms; throws when the budget runs out. */
  async function timeUntil(
    win: Page,
    id: string,
    settled: (row: { kind: 'todo' | 'note'; title: string } | null) => boolean,
    budgetMs: number,
    what: string
  ): Promise<number> {
    const started = Date.now();
    let last: { kind: 'todo' | 'note'; title: string } | null = null;
    while (Date.now() - started < budgetMs) {
      last = await rowOf(win, id);
      if (settled(last)) return Date.now() - started;
      await win.waitForTimeout(50);
    }
    throw new Error(`${what} did not show within ${budgetMs} ms (last seen ${JSON.stringify(last)})`);
  }

  /** A note or to-do made over REST, and seen in the panel before the spec measures anything else about it. */
  async function createOverRest(win: Page, title: string, isTodo: boolean): Promise<string> {
    const created = await apiJson('POST', '/notes', { title, parent_id: folderID, is_todo: isTodo ? 1 : 0 });
    await expect.poll(async () => (await rowOf(win, created.id)) !== null, { timeout: PANEL_REFRESH_TIMEOUT }).toBe(true);
    return created.id;
  }

  test('a flip made over REST of the to-do open in the editor reaches its new section within a couple of seconds, through onNoteChange', async () => {
    const { win } = joplin;
    const title = `fresh-flip-${stamp}`;
    // Created through the GUI, so it is the note open in the editor - the one Joplin announces changes to.
    const id = await createTodo(win, title);
    await expect.poll(async () => (await rowOf(win, id))?.kind, { timeout: PANEL_REFRESH_TIMEOUT }).toBe('todo');

    const put = await apiRequest('PUT', `/notes/${id}`, { is_todo: 0 });
    expect(put.status).toBe(200);
    const elapsed = await timeUntil(win, id, (row) => row?.kind === 'note', NOTE_CHANGE_BUDGET_MS, 'the flipped to-do in the Notes section');
    // eslint-disable-next-line no-console
    console.log(`[store-freshness] REST flip of the open to-do, via onNoteChange: in its new section after ${elapsed} ms`);
  });

  test('with the refresh interval at its minimum, a note renamed over REST - not open, so no event announces it - shows its new title within two intervals', async () => {
    const { win } = joplin;
    await ensureMinimumInterval(win);
    const id = await createOverRest(win, `fresh-rename-${stamp}`, false);
    const renamed = `fresh-renamed-${stamp}`;

    await apiJson('PUT', `/notes/${id}`, { title: renamed });
    const elapsed = await timeUntil(win, id, (row) => row?.title === renamed, TWO_INTERVALS_MS, 'the new title');
    // eslint-disable-next-line no-console
    console.log(`[store-freshness] REST rename of a note not open: new title after ${elapsed} ms`);
  });

  test('a note trashed over REST leaves the panel within two intervals', async () => {
    const { win } = joplin;
    await ensureMinimumInterval(win);
    const id = await createOverRest(win, `fresh-trash-${stamp}`, false);

    const trashed = await apiRequest('DELETE', `/notes/${id}`);
    expect(trashed.status).toBe(200);
    const elapsed = await timeUntil(win, id, (row) => row === null, TWO_INTERVALS_MS, 'the trashed note leaving the panel');
    // eslint-disable-next-line no-console
    console.log(`[store-freshness] REST trash of a note not open: gone after ${elapsed} ms`);
  });

  test('a to-do created over REST appears within two intervals', async () => {
    const { win } = joplin;
    await ensureMinimumInterval(win);
    // An anchor made first and seen, so the interval is known to be running before the create is timed.
    await createOverRest(win, `fresh-anchor-${stamp}`, false);

    const created = await apiJson('POST', '/notes', { title: `fresh-created-${stamp}`, parent_id: folderID, is_todo: 1 });
    const elapsed = await timeUntil(win, created.id, (row) => row?.kind === 'todo', TWO_INTERVALS_MS, 'the created to-do');
    // eslint-disable-next-line no-console
    console.log(`[store-freshness] REST create of a to-do: in the panel after ${elapsed} ms`);
  });
});
