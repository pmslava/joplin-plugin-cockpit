import { test, expect, Page } from '@playwright/test';
import * as http from 'http';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import { agendaPanel, createNotebook, waitForPanelTodo, PANEL_REFRESH_TIMEOUT } from './helpers';

/**
 * Regression cover for the first drag of a session (2.11).
 *
 * The report (desktop, the Interval list, a row dragged into the gap between two rows): "Drag of element to put
 * between other elements almost never works from the first attempt. Only on second one."
 *
 * Every other drag spec dispatches the HTML5 drag sequence inside the panel frame, which is deterministic but skips
 * exactly what a first attempt differs in: the real press moves keyboard focus from Joplin's main window into the
 * panel's iframe, and focus leaving the main document fires `blur` there. The cross-frame selection-drag passthrough
 * (onPanelSelectionDragProbe in panelWebview.js) listens for that blur on the PARENT window as one of its end-of-drag
 * restores, and its restore also clears the "the press began inside the panel" flag - so the panel's OWN press, the
 * moment it took focus, looked like a foreign selection drag, and the drag's first pointermove made the panel's
 * iframe pointer-events:none before the drag had even started. Nothing in the panel could be dropped on. The second
 * attempt worked because focus was already inside the panel and no blur fired.
 *
 * So these specs drive a REAL pointer drag with Playwright's mouse - move onto the row, press, move in steps to the
 * lower band of a target row, release - from a fresh launch with focus in the main window, and read the result back
 * from Joplin's own data API. The first is the first drag of the session; the second puts focus back in the main
 * window (a click in the note list, as anyone would between two drags) and drags again, which used to fail the same
 * way. A webview-side event log is installed from the spec (capturing listeners, nothing in the shipped code) and
 * printed with each case, so a failure says which step went wrong: pointerdown, the parent's blur, the passthrough
 * engaging, dragstart, each dragover's target and whether it was accepted, drop, dragend.
 */
test.describe('The first drag of a session lands between rows (desktop, real pointer)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const book = `Cockpit FirstDrag ${stamp}`;

  // Joplin's own data API on this throwaway profile, on a port no other spec uses.
  const API_TOKEN = `cockpit-e2e-${stamp}`;
  const API_PORT = 41231;

  // Five to-dos due today, two hours apart: all in the "Today" group whatever the hour of the run.
  const HOURS = [9, 11, 13, 15, 17];
  const marker = (i: number) => `fd-${String.fromCharCode(65 + i)}-${stamp}`;
  const ids: string[] = [];

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    joplin = await launchJoplin({
      settings: { 'clipperServer.autoStart': true, 'api.token': API_TOKEN, 'api.port': API_PORT },
    });
    const { win } = joplin;
    await createNotebook(win, book);
    await apiReady(win);
    const folderId = await folderIdByTitle(book);
    for (let i = 0; i < HOURS.length; i++) ids.push(await createTodoViaApi(marker(i), folderId, todayAt(HOURS[i])));
    for (let i = 0; i < HOURS.length; i++) await waitForPanelTodo(win, marker(i));
    await installEventLog();
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  /** ------------------------------------------------------------------------------------------
   * Joplin's data API
   * --------------------------------------------------------------------------------------- */

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

  async function folderIdByTitle(title: string): Promise<string> {
    const got = await apiRequest('GET', `/folders?token=${API_TOKEN}&limit=100`);
    if (got.status !== 200) throw new Error(`the data API refused the folder list: ${got.status} ${got.text}`);
    const found = (JSON.parse(got.text).items || []).find((f: any) => f.title === title);
    if (!found) throw new Error(`no notebook titled ${title} in the data API's folder list`);
    return found.id;
  }

  async function createTodoViaApi(title: string, folderId: string, dueMs: number): Promise<string> {
    const made = await apiRequest('POST', `/notes?token=${API_TOKEN}`, { title, is_todo: 1, parent_id: folderId, todo_due: dueMs });
    if (made.status !== 200) throw new Error(`the data API refused a to-do: ${made.status} ${made.text}`);
    return JSON.parse(made.text).id;
  }

  async function dueOf(i: number): Promise<number> {
    const got = await apiRequest('GET', `/notes/${ids[i]}?token=${API_TOKEN}&fields=id,todo_due`);
    if (got.status !== 200) throw new Error(`the data API refused a note read: ${got.status} ${got.text}`);
    return Number(JSON.parse(got.text).todo_due || 0);
  }

  function todayAt(hour: number): number {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    return d.getTime();
  }

  /** ------------------------------------------------------------------------------------------
   * The event log (installed from here; the shipped panel carries none of it)
   * --------------------------------------------------------------------------------------- */

  /**
   * Capturing listeners in the panel document for the pointer and drag events, plus the parent window's focus
   * events, each recording the passthrough and ownership state at that instant. A dragover's `defaultPrevented` is
   * read from a WINDOW bubble listener, which runs after every document-level handler the panel registers, so it is
   * the verdict the browser will act on. Pointer moves are only logged while the primary button is held.
   */
  async function installEventLog(): Promise<void> {
    const panel = await agendaPanel(joplin.win);
    await panel.evaluate(() => {
      const w = window as any;
      w.__fdLog = [];
      const state = () => {
        let pe = '?';
        try {
          pe = (window.frameElement as HTMLElement | null)?.style.pointerEvents ?? '(no frame)';
        } catch {
          pe = '(cross-origin)';
        }
        return `down=${w.panelPointerIsDown} foreign=${w.foreignSelectionDragActive} own=${w.panelDragActive} pe='${pe}'`;
      };
      const name = (el: any) => {
        if (!el || !el.closest) return String(el && el.nodeName);
        const row = el.closest('.todo[data-todo-id]');
        if (row) return 'row:' + ((row.textContent || '').match(/fd-[A-E]/) || ['?'])[0];
        return el.nodeName + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '');
      };
      const push = (line: string) => {
        if (w.__fdLog.length < 400) w.__fdLog.push(line);
      };
      for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'dragstart', 'dragleave', 'drop', 'dragend']) {
        document.addEventListener(type, (e: any) => push(`${type} ${name(e.target)} type=${e.pointerType || '-'} y=${e.clientY} | ${state()}`), true);
      }
      document.addEventListener('pointermove', (e: any) => {
        if (e.buttons & 1) push(`pointermove(held) ${name(e.target)} y=${e.clientY} | ${state()}`);
      }, true);
      window.addEventListener('dragover', (e: any) => push(`dragover ${name(e.target)} y=${e.clientY} accepted=${e.defaultPrevented} | ${state()}`), false);
      try {
        const parent = window.parent;
        parent.addEventListener('blur', (e: any) => push(`parent blur ${e.target === parent ? 'window' : name(e.target)} | ${state()}`), true);
        parent.addEventListener('focus', (e: any) => push(`parent focus ${e.target === parent ? 'window' : name(e.target)} | ${state()}`), true);
        parent.addEventListener('mouseup', () => push(`parent mouseup | ${state()}`), true);
        parent.addEventListener('dragover', (e: any) => {
          if (w.__fdLog.length && !/^parent dragover/.test(w.__fdLog[w.__fdLog.length - 1])) push(`parent dragover (the drag is over the MAIN window) | ${state()}`);
        }, true);
      } catch {
        push('parent unreachable');
      }
      push(`installed | panel hasFocus=${document.hasFocus()} parent activeElement=${(() => { try { return window.parent.document.activeElement?.nodeName; } catch { return '?'; } })()} | ${state()}`);
    });
  }

  async function takeLog(): Promise<string[]> {
    const panel = await agendaPanel(joplin.win);
    return panel.evaluate(() => {
      const w = window as any;
      const out = w.__fdLog || [];
      w.__fdLog = [];
      return out;
    });
  }

  /** ------------------------------------------------------------------------------------------
   * The real drag
   * --------------------------------------------------------------------------------------- */

  /** Drag the row `from` with the real mouse into the gap below the row `onto` (its lower band), then release. */
  async function realDrag(from: number, onto: number): Promise<void> {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    const source = await panel.locator('.todo[data-todo-id]', { hasText: marker(from) }).first().boundingBox();
    const target = await panel.locator('.todo[data-todo-id]', { hasText: marker(onto) }).first().boundingBox();
    if (!source || !target) throw new Error('a fixture row has no box on screen');
    const sx = source.x + source.width / 2;
    const sy = source.y + source.height / 2;
    const tx = target.x + target.width / 2;
    const ty = target.y + target.height * 0.8; // the lower 40 % band: insert AFTER the target row
    await win.mouse.move(sx, sy);
    await win.mouse.down();
    await win.mouse.move(sx, sy + 3, { steps: 3 }); // past nothing yet: the drag threshold is a few pixels
    await win.mouse.move(tx, ty, { steps: 12 });
    await win.waitForTimeout(200);
    await win.mouse.move(tx, ty + 1);
    await win.mouse.up();
  }

  /** Wait for the dragged to-do's stored due to lie strictly between its two new neighbours'. */
  async function expectBetween(dragged: number, lower: number, upper: number, log: string[]): Promise<void> {
    const lo = await dueOf(lower);
    const hi = await dueOf(upper);
    await expect
      .poll(async () => {
        const due = await dueOf(dragged);
        return due > lo && due < hi;
      }, { timeout: 20_000, intervals: [500, 1000, 2000] })
      .toBe(true)
      .catch((error) => {
        throw new Error(`${(error as Error).message}\nEVENT LOG:\n${log.join('\n')}`);
      });
  }

  test('the FIRST drag of the session, with focus in the main window, lands in the gap', async () => {
    // E (17:00) into the gap below A (09:00): between A and B (11:00).
    await realDrag(4, 0);
    await joplin.win.waitForTimeout(500);
    const log = await takeLog();
    console.log('FIRST DRAG LOG\n' + log.join('\n'));
    await expectBetween(4, 0, 1, log);
  });

  test('a drag after focus went back to the main window lands too', async () => {
    const { win } = joplin;
    // The panel re-renders after the first drop; wait for E to sit between A and B on screen before aiming.
    await waitForPanelTodo(win, marker(4));
    // Focus back into the main window, the way it happens between two drags: a click in the note list.
    await win.locator('.note-list-item').first().click();
    await win.waitForTimeout(800);
    await takeLog();
    // D (15:00) into the gap below B (11:00): between B and C (13:00).
    await realDrag(3, 1);
    await win.waitForTimeout(500);
    const log = await takeLog();
    console.log('SECOND DRAG LOG\n' + log.join('\n'));
    await expectBetween(3, 1, 2, log);
  });
});
