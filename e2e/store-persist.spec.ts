import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { launchJoplin, closeJoplin, createProfile, JoplinInstance, PLUGIN_ID } from './launch';
import { agendaPanel, createNote, createNotebook, PANEL_REFRESH_TIMEOUT } from './helpers';

/**
 * Cockpit 2.7.1: on desktop the note store saves its mirror to a file in the plugin's data directory and restores it at the next launch,
 * before the first paint, instead of walking the listing (PERSISTENCE in src/core/noteStore.ts, the file in src/core/noteStoreFile.ts).
 * These specs hold the two launches to it against a genuine Joplin, on ONE profile directory that each launch reuses:
 *
 *  - the first launch builds the store and saves it; a note made over REST reaches the file through the drain a GUI-made note triggers;
 *    then, with the file on disk, that note is renamed and a to-do created over REST - nothing announces either (neither is the open note,
 *    and the periodic tick is a minute away), so the store never hears of them in that session - and Joplin is killed (closeJoplin);
 *  - the second launch must restore the file (storeRestore.restored, read from Cockpit's instrument in its plugin window), replay the two
 *    rows, show the renamed note and the created to-do in the panel, and have read no listing page beyond the completeness count;
 *  - the third launch finds the file corrupted, must not restore it (reason "unparsable file"), and builds the store as before.
 *
 * Where the file is: Joplin gives each plugin <profile>/plugin-data/<plugin id> (pluginDataDir in 3.6.14's BaseApplication, plus the
 * plugin's id in PluginService), and the store's file is noteStore.v1.json there. The data API is this profile's clipper server, on a port
 * no other spec uses, as in store-freshness.spec.ts.
 */
test.describe('Note store persistence (desktop)', () => {
  test.describe.configure({ mode: 'serial' });

  let joplin: JoplinInstance | null = null;
  let profileDir = '';
  const stamp = Date.now();
  const book = `Cockpit Persist ${stamp}`;
  // Off Joplin's 41184 default and off every other spec's port (41197, 41198, 41199, 41207, 41213-41216).
  const API_TOKEN = `cockpit-e2e-persist-${stamp}`;
  const API_PORT = 41217;
  // The build runs two seconds after the first paint and walks the listing; a cold, busy machine gets room.
  const STORE_READY_TIMEOUT_MS = 180_000;
  // A drain's save waits out a 5 s debounce (saveDelayMs in src/core/noteStore.ts).
  const SAVE_TIMEOUT_MS = 60_000;
  let folderID = '';
  let renamedID = '';
  let createdID = '';
  const renamedTitle = `persist-renamed-${stamp}`;
  const createdTitle = `persist-created-${stamp}`;

  const storeFile = () => path.join(profileDir, 'plugin-data', PLUGIN_ID, 'noteStore.v1.json');

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
    else if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
    joplin = null;
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

  /** Wait until OUR Joplin answers with OUR token. */
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
   * What Cockpit's own plugin window says: its note store's readiness and the instrument's snapshot (src/core/instrument.ts), whose
   * storeRestore and storeSave records are the saved store's. Every page is asked; the one whose global holds Cockpit's handles answers.
   * null while no page does.
   */
  async function askPlugin(): Promise<{ ready: boolean; totals: any } | null> {
    if (!joplin) return null;
    for (const page of joplin.browser.contexts().flatMap((context) => context.pages())) {
      const answer = await Promise.race([
        page
          .evaluate(() => {
            const scope = globalThis as any;
            if (!scope.CockpitNoteStore || !scope.CockpitInstrument) return null;
            return { ready: !!scope.CockpitNoteStore.isReady(), totals: scope.CockpitInstrument.snapshot() };
          })
          .catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ]);
      if (answer !== null) return answer;
    }
    return null;
  }

  async function waitForStoreReady(): Promise<void> {
    await expect.poll(async () => (await askPlugin())?.ready ?? null, { timeout: STORE_READY_TIMEOUT_MS, intervals: [500, 1000, 2000] }).toBe(true);
  }

  /** The ids the saved file holds, or null while there is no file that parses. */
  function savedIds(): string[] | null {
    try {
      return JSON.parse(fs.readFileSync(storeFile(), 'utf8')).notes.map((note: { id: string }) => note.id);
    } catch {
      return null;
    }
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
      return null;
    }
  }

  async function launch(): Promise<Page> {
    joplin = await launchJoplin({ profileDir });
    await apiReady(joplin.win);
    return joplin.win;
  }

  async function close(): Promise<void> {
    if (joplin) await closeJoplin(joplin, { keepProfile: true });
    joplin = null;
  }

  test('a relaunch restores the saved store before the first paint: the changes made while it was closed show, and no listing page is read beyond the count', async () => {
    profileDir = createProfile(true, { 'clipperServer.autoStart': true, 'api.token': API_TOKEN, 'api.port': API_PORT });
    let win = await launch();
    await createNotebook(win, book);
    const folders = await apiJson('GET', '/folders?fields=id,title&limit=100');
    const folder = (folders.items || []).find((item: { title: string }) => item.title === book);
    if (!folder) throw new Error(`the notebook "${book}" is not in the data API's folder list`);
    folderID = folder.id;
    await waitForStoreReady();
    await expect.poll(() => savedIds() !== null, { timeout: SAVE_TIMEOUT_MS }).toBe(true);
    expect(fs.existsSync(storeFile() + '.tmp')).toBe(false);

    // A note made over REST, then one made in the GUI: the GUI's note change drains the feed, which brings both, and the drain's save puts
    // them in the file.
    renamedID = (await apiJson('POST', '/notes', { title: `persist-before-${stamp}`, parent_id: folderID })).id;
    await createNote(win, `persist-open-${stamp}`);
    await expect.poll(() => (savedIds() || []).includes(renamedID), { timeout: SAVE_TIMEOUT_MS }).toBe(true);
    const savedCount = (await askPlugin())?.totals.storeSave.count;
    expect(savedCount).toBeGreaterThan(0);

    // With the file on disk: a rename and a create nothing announces, and Joplin killed straight after.
    await apiJson('PUT', `/notes/${renamedID}`, { title: renamedTitle });
    createdID = (await apiJson('POST', '/notes', { title: createdTitle, parent_id: folderID, is_todo: 1 })).id;
    expect((savedIds() || []).includes(createdID)).toBe(false);
    await close();

    win = await launch();
    // The restore runs before the first paint, so it has decided by the time the plugin's window answers; poll until it does.
    await expect
      .poll(async () => {
        const asked = await askPlugin();
        return asked ? asked.totals.storeRestore.attempted || asked.totals.storeRestore.reason !== null : null;
      }, { timeout: PANEL_REFRESH_TIMEOUT })
      .toBe(true);
    const answer = (await askPlugin())!;
    const restore = answer.totals.storeRestore;
    // eslint-disable-next-line no-console
    console.log(`[store-persist] warm start: ${JSON.stringify(restore)}; saves in the first session: ${savedCount}`);
    expect(restore.restored).toBe(true);
    expect(restore.reason).toBeNull();
    expect(restore.replayRows).toBeGreaterThanOrEqual(2);
    expect(answer.ready).toBe(true);
    await expect.poll(async () => (await rowOf(win, renamedID))?.title, { timeout: PANEL_REFRESH_TIMEOUT }).toBe(renamedTitle);
    await expect.poll(async () => (await rowOf(win, createdID))?.kind, { timeout: PANEL_REFRESH_TIMEOUT }).toBe('todo');
    const totals = (await askPlugin())!.totals;
    // eslint-disable-next-line no-console
    console.log(`[store-persist] warm start's data calls so far: listing ${totals.listing}, search ${totals.search}, events ${totals.events}, get ${totals.get}`);
    // The completeness count reads one page of the bare listing, two at an exact multiple of 100; nothing else reads it on a restored store.
    expect(totals.listing).toBeLessThanOrEqual(2);
    await close();
  });

  test('a corrupted file is not restored: it is removed, the store is built as before, and saved again', async () => {
    expect(fs.existsSync(storeFile())).toBe(true);
    fs.writeFileSync(storeFile(), '{ "format": 1, "notes": [ this is not JSON');
    const win = await launch();
    await waitForStoreReady();
    const totals = (await askPlugin())!.totals;
    // eslint-disable-next-line no-console
    console.log(`[store-persist] corrupted file: ${JSON.stringify(totals.storeRestore)}`);
    expect(totals.storeRestore.restored).toBe(false);
    expect(totals.storeRestore.reason).toBe('unparsable file');
    await expect.poll(async () => (await rowOf(win, renamedID))?.title, { timeout: PANEL_REFRESH_TIMEOUT }).toBe(renamedTitle);
    await expect.poll(() => (savedIds() || []).includes(createdID), { timeout: SAVE_TIMEOUT_MS }).toBe(true);
  });
});
