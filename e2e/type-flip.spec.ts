import { test, expect, Page } from '@playwright/test';
import * as http from 'http';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  agendaPanel,
  createNotebook,
  createProfile,
  createTodo,
  selectNote,
  selectProfile,
  waitForPanelTodo,
  PANEL_REFRESH_TIMEOUT,
} from './helpers';

/**
 * Real-app cover for switching an item between note and to-do type.
 *
 * The bug: the panel draws its to-dos and its NOTES group from two SEPARATE searches of Joplin's index, and that
 * index only catches up with an is_todo write seconds later. So a flip reached the panel at the reconcile lane's
 * 7s rung - and until then the item was drawn TWICE, once under a to-do heading and once under NOTES, because the
 * host-held overlay entry only ever spoke for ONE of the two lists.
 *
 * These specs measure the two things the fix promises, against genuine Joplin: the row is in its NEW section
 * within a budget far below the reconcile rungs (so no search can have put it there), and at no sampled moment is
 * it in both sections at once. Both directions go through Cockpit's own context menu; a third flip is made by
 * JOPLIN itself through its data API (the profile presets the clipper server), which reaches the panel only via
 * onNoteChange, with no Cockpit action involved.
 *
 * The last spec is a measurement rather than a promise. On a profile Cockpit CANNOT evaluate locally (it carries
 * searchCriteria, so no overlay entry is ever written for it) what the panel shows during the lag window is purely
 * what the index returned - which is how a search row's own is_todo can be judged. It records the timings it
 * observes and asserts only the invariant that holds either way: never both sections at once.
 */
test.describe('Type flip (desktop)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const book = `Cockpit TFlip ${stamp}`;
  // Flipped through Cockpit's own context menu, there and back.
  const OWN = `tf-own-${stamp}`;
  // Flipped through Joplin's data API, so the panel only learns of it through onNoteChange.
  const EXT = `tf-ext-${stamp}`;
  // The index-freshness probe. Its distinctive first word is what the probe profile's searchCriteria matches.
  const PROBE_WORD = `tflipprobe${stamp}`;
  const PROBE = `${PROBE_WORD} probe`;
  const PROBE_PROFILE = `TFlip probe ${stamp}`;
  let ownID = '';
  let extID = '';
  let probeID = '';

  // Joplin's own data API, enabled on this throwaway profile so a spec can change a note the way any external
  // client would. The port is off Joplin's 41184 default so a Joplin the developer happens to be running is
  // never talked to by mistake.
  const API_TOKEN = `cockpit-e2e-${stamp}`;
  const API_PORT = 41199;

  // Far below the reconcile lane's rungs ([1000, 3000, 7000, ...] ms, and the index needs seconds anyway), so a
  // row that has changed section inside it cannot have been placed there by a search.
  const INSTANT_BUDGET = 2_000;

  test.beforeAll(async () => {
    joplin = await launchJoplin({
      settings: { 'clipperServer.autoStart': true, 'api.token': API_TOKEN, 'api.port': API_PORT },
    });
    const { win } = joplin;
    await createNotebook(win, book);
    // No alarms: the default profile shows undated to-dos (and notes after them), so every fixture is visible in
    // both of its possible sections without any extra GUI steps.
    ownID = await createTodo(win, OWN);
    extID = await createTodo(win, EXT);
    probeID = await createTodo(win, PROBE);
    await waitForPanelTodo(win, OWN);
    await waitForPanelTodo(win, EXT);
    await apiReady(win);
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
          headers: payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {},
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

  /** Wait for the clipper server to answer, so a spec's flip is never lost to a not-yet-started service. */
  async function apiReady(win: Page): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const ping = await apiRequest('GET', '/ping');
        if (ping.status === 200) return;
      } catch {
        /* not up yet */
      }
      await win.waitForTimeout(1000);
    }
    throw new Error('Joplin data API never answered on 127.0.0.1:' + API_PORT);
  }

  /** Flip an item's type through JOPLIN's own API - the panel can only learn of this through onNoteChange. */
  async function flipViaJoplinApi(id: string, toTodo: boolean): Promise<void> {
    const put = await apiRequest('PUT', `/notes/${id}?token=${API_TOKEN}`, { is_todo: toTodo ? 1 : 0 });
    if (put.status !== 200) throw new Error(`the data API refused the flip: ${put.status} ${put.text}`);
  }

  /** How many rows the panel currently draws for the id, per section: a to-do row and a NOTES row are distinct. */
  async function placementOf(win: Page, id: string): Promise<{ todo: number; note: number }> {
    const panel = await agendaPanel(win);
    return panel.evaluate(
      (noteId) => ({
        todo: document.querySelectorAll(`.todo[data-todo-id="${noteId}"]`).length,
        note: document.querySelectorAll(`.todo[data-note-id="${noteId}"]`).length,
      }),
      id
    );
  }

  /** placementOf, but a sample taken while the panel is being replaced counts as no observation at all. */
  async function sample(win: Page, id: string): Promise<{ todo: number; note: number } | null> {
    try {
      return await placementOf(win, id);
    } catch {
      return null;
    }
  }

  /**
   * Sample the panel until the id is drawn exactly once in `want`'s section and not at all in the other, keeping
   * every moment it was seen in BOTH (the duplicate this whole fix is about). Returns how long that took.
   */
  async function settleInto(
    win: Page,
    id: string,
    want: 'todo' | 'note',
    budgetMs: number
  ): Promise<{ elapsed: number; duplicatedAt: number[] }> {
    const started = Date.now();
    const duplicatedAt: number[] = [];
    let last: { todo: number; note: number } | null = null;
    while (Date.now() - started < budgetMs) {
      last = await sample(win, id);
      if (last) {
        if (last.todo > 0 && last.note > 0) duplicatedAt.push(Date.now() - started);
        const other = want === 'todo' ? last.note : last.todo;
        if (last[want] === 1 && other === 0) return { elapsed: Date.now() - started, duplicatedAt };
      }
      await win.waitForTimeout(120);
    }
    throw new Error(
      `the row never settled into the ${want} section within ${budgetMs}ms ` +
        `(last seen ${JSON.stringify(last)}, duplicated at [${duplicatedAt.join(', ')}]ms)`
    );
  }

  /** Flip the row carrying `marker` through Cockpit's own row context menu, the way a user right-clicks it. */
  async function flipViaCockpitMenu(marker: string): Promise<void> {
    const panel = await agendaPanel(joplin.win);
    await panel.evaluate((m) => {
      const rows = Array.from(
        document.querySelectorAll('.todo[data-todo-id], .todo[data-note-id]')
      ) as HTMLElement[];
      const row = rows.find((r) => (r.textContent || '').includes(m));
      if (!row) throw new Error(`no panel row for ${m}`);
      // A press selects the row (what the menu acts on), then the contextmenu opens Cockpit's own menu.
      row.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      row.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true }));
      const menu = document.getElementById('noteContextMenu');
      if (!menu) throw new Error('the context menu did not open');
      const item = menu.querySelector('.context-menu-item[data-action="toggleType"]') as HTMLElement;
      if (!item) throw new Error('the menu has no toggleType item');
      item.click();
    }, marker);
  }

  /**
   * Put the row into the given section WITHOUT measuring, so no spec depends on the one before it: a Playwright
   * retry re-runs beforeAll against a brand-new profile, where every fixture is back to a freshly created to-do.
   */
  async function ensureIn(win: Page, id: string, marker: string, want: 'todo' | 'note'): Promise<void> {
    if ((await placementOf(win, id))[want] === 1) return;
    await flipViaCockpitMenu(marker);
    await settleInto(win, id, want, PANEL_REFRESH_TIMEOUT);
  }

  test('Cockpit\'s own toggle moves a to-do into NOTES at once, and never draws it twice', async () => {
    const { win } = joplin;
    await ensureIn(win, ownID, OWN, 'todo');
    expect(await placementOf(win, ownID)).toEqual({ todo: 1, note: 0 });

    await flipViaCockpitMenu(OWN);

    const settled = await settleInto(win, ownID, 'note', INSTANT_BUDGET);
    expect(settled.duplicatedAt).toEqual([]);
    // eslint-disable-next-line no-console
    console.log(`[type-flip] Cockpit toggle to-do -> note settled in ${settled.elapsed}ms`);
  });

  test('and back: the same toggle returns it to the to-do section at once, still only once', async () => {
    const { win } = joplin;
    // A no-op after the spec above, and the setup flip on a retry - either way this spec measures note -> to-do.
    await ensureIn(win, ownID, OWN, 'note');

    await flipViaCockpitMenu(OWN);

    const settled = await settleInto(win, ownID, 'todo', INSTANT_BUDGET);
    expect(settled.duplicatedAt).toEqual([]);
    // eslint-disable-next-line no-console
    console.log(`[type-flip] Cockpit toggle note -> to-do settled in ${settled.elapsed}ms`);
  });

  test('a flip made through Joplin\'s own API reaches the panel via onNoteChange, once, in the right section', async () => {
    const { win } = joplin;
    // Opened in the editor, which is the state a user's own edit happens in - and what makes Joplin notice an
    // outside change to this note promptly and tell its plugins about it (onNoteChange).
    await selectNote(win, EXT);
    await ensureIn(win, extID, EXT, 'todo');
    expect(await placementOf(win, extID)).toEqual({ todo: 1, note: 0 });

    await flipViaJoplinApi(extID, false);

    // A little more room than Cockpit's own path: this one starts with Joplin's event and a targeted note GET.
    const settled = await settleInto(win, extID, 'note', 3_000);
    expect(settled.duplicatedAt).toEqual([]);
    // eslint-disable-next-line no-console
    console.log(`[type-flip] Joplin's own API flip settled in ${settled.elapsed}ms`);
  });

  /**
   * The measurement, not a promise. On a searchCriteria profile no overlay entry is ever written (only a search
   * can decide that view's membership), so what the panel shows is purely what the index returned - which is how
   * a search row's own is_todo can be judged. If the flipped item leaves the to-do section at the lane's first
   * rung, the row the `type:todo` query returned already carried the NEW is_todo while the index still filed it
   * under the old type; if it only leaves seconds later, the payload was as stale as the index. Either way it
   * must never be in both sections at once.
   */
  test('index freshness probe: what a search row says about a just-flipped item', async () => {
    const { win } = joplin;
    await createProfile(win, { name: PROBE_PROFILE, searchCriteria: PROBE_WORD, showNoDue: true });
    await selectProfile(win, PROBE_PROFILE);
    await selectNote(win, PROBE);
    await expect
      .poll(async () => (await placementOf(win, probeID)).todo, { timeout: PANEL_REFRESH_TIMEOUT })
      .toBe(1);

    const started = Date.now();
    await flipViaJoplinApi(probeID, false);

    const duplicatedAt: number[] = [];
    let leftTodos = -1;
    // Wide enough to cover the reconcile lane's last rung (30s): on such a view nothing but a rung repaints the
    // panel, so the row leaves only at the first rung AFTER Joplin's own index has caught up with the flip.
    while (Date.now() - started < 45_000 && leftTodos < 0) {
      const seen = await sample(win, probeID);
      if (seen) {
        if (seen.todo > 0 && seen.note > 0) duplicatedAt.push(Date.now() - started);
        if (seen.todo === 0) leftTodos = Date.now() - started;
      }
      await win.waitForTimeout(150);
    }
    // eslint-disable-next-line no-console
    console.log(
      `[type-flip] searchCriteria profile (no overlay entry): the flipped item left the to-do section after ${leftTodos}ms`
    );
    expect(duplicatedAt).toEqual([]);
    expect(leftTodos).toBeGreaterThanOrEqual(0);
  });
});
