import { test, expect, Page } from '@playwright/test';
import * as http from 'http';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import { agendaPanel, createNotebook, waitForPanelTodo, PANEL_REFRESH_TIMEOUT } from './helpers';

/**
 * Real-app cover for the drag auto-scroll at the list's edges.
 *
 * The report: "It is impossible to drag items to the required date, because it is out of the list and I can't
 * move it while dragging." A native drag owns the pointer, the wheel does not follow it, and the panel's list is
 * an INNER scroller (Joplin's webview skeleton sets overflow:hidden on the html element; only `.todos` scrolls),
 * so Chromium's own drag auto-scroll never reaches it. A heading or a calendar day off screen was unreachable.
 *
 * The fix scrolls `.todos` while a drag this panel started hovers inside a band at its top or bottom edge, and
 * stops the moment the drag ends. These specs drive the panel's REAL handlers with the HTML5 drag sequence a
 * browser fires - the plain mousedown, dragstart, a stream of dragover, dragend - exactly as multi-drag.spec.ts
 * does, and measure `.todos.scrollTop` around each phase.
 *
 * The whole timed sequence runs INSIDE the panel frame (one `evaluate` per probe): a dragover dispatched over CDP
 * per tick would put the round-trip latency into the very interval being measured, and the watchdog that stops
 * the loop after 150ms of silence is measured in exactly those milliseconds.
 *
 * To have anything to scroll, the list must overflow: 60 undated to-dos are seeded through Joplin's own data API
 * (the GUI's "New to-do" costs seconds each, and 60 of them would not fit in a beforeAll), and the suite refuses
 * to start until the panel actually reports scrollHeight > clientHeight.
 */
test.describe('Drag auto-scroll at the list edges (desktop)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const book = `Cockpit AScroll ${stamp}`;

  // Joplin's own data API on this throwaway profile, off the 41184 default so a Joplin the developer happens to
  // be running is never talked to by mistake (and off type-flip's port, so a stray process cannot be mistaken
  // for ours either).
  const API_TOKEN = `cockpit-e2e-${stamp}`;
  const API_PORT = 41198;

  // Enough undated rows that the list overflows any panel height this harness can produce.
  const ROWS = 60;
  const marker = (i: number) => `as-row-${String(i).padStart(2, '0')}-${stamp}`;
  const FIRST = marker(0);
  const LAST = marker(ROWS - 1);

  // A drag that does not move the list must not move it AT ALL; a few pixels of tolerance only absorbs the
  // sub-pixel scrollTop a fractional device pixel ratio can produce.
  const STILL_TOL = 4;
  // A scrolling phase runs for at least 400ms at 2..16 px/frame, so tens of pixels is a floor no real run can
  // miss while still being far above any incidental movement.
  const MOVED_MIN = 50;

  test.beforeAll(async () => {
    joplin = await launchJoplin({
      settings: { 'clipperServer.autoStart': true, 'api.token': API_TOKEN, 'api.port': API_PORT },
    });
    const { win } = joplin;
    await createNotebook(win, book);
    await apiReady(win);
    const folderId = await folderIdByTitle(book);
    // No alarms: the default profile lists undated to-dos (under "No Due Date"), so every seeded row is on
    // screen without a single GUI step per to-do.
    for (let i = 0; i < ROWS; i++) await createTodoViaApi(marker(i), folderId);
    await waitForPanelTodo(win, FIRST);
    await waitForPanelTodo(win, LAST);
    // The precondition every measurement below rests on: the list really does overflow its container.
    await expect
      .poll(async () => (await listMetrics()).maxScroll, {
        timeout: PANEL_REFRESH_TIMEOUT,
        intervals: [1000, 2000, 4000],
      })
      .toBeGreaterThan(200);
    console.log('AUTOSCROLL FIXTURE', JSON.stringify(await listMetrics()));
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  /** ------------------------------------------------------------------------------------------
   * Seeding through Joplin's data API
   * --------------------------------------------------------------------------------------- */

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

  /** Wait for the clipper server to answer, so no fixture is lost to a not-yet-started service. */
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
    const found = (JSON.parse(got.text).items || []).find((f: any) => f.title === title);
    if (!found) throw new Error(`no notebook titled ${title} in the data API's folder list`);
    return found.id;
  }

  /** One undated to-do, straight into the notebook. */
  async function createTodoViaApi(title: string, folderId: string): Promise<void> {
    const made = await apiRequest('POST', `/notes?token=${API_TOKEN}`, {
      title,
      is_todo: 1,
      parent_id: folderId,
    });
    if (made.status !== 200) throw new Error(`the data API refused a to-do: ${made.status} ${made.text}`);
  }

  /** ------------------------------------------------------------------------------------------
   * The probe
   * --------------------------------------------------------------------------------------- */

  /** What the scroll container currently measures. */
  async function listMetrics(): Promise<{ scrollTop: number; clientHeight: number; maxScroll: number }> {
    const panel = await agendaPanel(joplin.win);
    return panel.evaluate(() => {
      const el = document.querySelector('.todos') as HTMLElement | null;
      if (!el) return { scrollTop: -1, clientHeight: -1, maxScroll: -1 };
      return {
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        maxScroll: el.scrollHeight - el.clientHeight,
      };
    });
  }

  /** One phase of a probe: where the pointer sits, for how long, and whether the drag ends first. */
  interface Phase {
    at: 'top' | 'middle' | 'bottom';
    ms: number;
    endDragFirst?: boolean;
  }

  interface Probe {
    dragStarted: boolean;
    clientHeight: number;
    maxScroll: number;
    settled: number;
    /** True when a background refresh replaced the .todos node mid-probe, which invalidates the numbers. */
    rerendered: boolean;
    phases: { at: string; endedFirst: boolean; from: number; to: number; delta: number }[];
  }

  /**
   * Run one drag probe inside the panel. `drag` false omits the dragstart entirely, which is what a FOREIGN drag
   * (text from another window) looks like to the panel. Every probe ends its own gesture, so no loop and no flag
   * is left standing for the next spec.
   */
  async function probe(opts: {
    drag: boolean;
    preScroll: 'top' | 'middle';
    phases: Phase[];
  }): Promise<Probe> {
    const panel = await agendaPanel(joplin.win);
    return panel.evaluate(async (o: any) => {
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const todos = document.querySelector('.todos') as HTMLElement;
      if (!todos) throw new Error('the panel has no .todos container');
      const rows = Array.from(document.querySelectorAll('.todo[data-todo-id]')) as HTMLElement[];
      const row = rows.find((r) => (r.textContent || '').includes(o.marker)) || null;
      if (o.drag && !row) throw new Error('no panel row carrying ' + o.marker);

      // Put the list where this probe needs it, and let the panel's own scroll bookkeeping settle first.
      todos.scrollTop =
        o.preScroll === 'middle' ? Math.floor((todos.scrollHeight - todos.clientHeight) / 2) : 0;
      await sleep(150);

      const rect = todos.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const yFor = (at: string) =>
        at === 'top'
          ? Math.round(rect.top + 6)
          : at === 'bottom'
            ? Math.round(rect.bottom - 6)
            : Math.round(rect.top + rect.height / 2);

      const dt = new DataTransfer();
      const out: any = {
        dragStarted: false,
        clientHeight: todos.clientHeight,
        maxScroll: todos.scrollHeight - todos.clientHeight,
        phases: [],
      };

      if (o.drag && row) {
        // The plain mousedown a browser always fires before dragstart (it is what selects the row).
        row.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
        row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
        out.dragStarted = (dt.getData('text/plain') || '').length > 0;
      }

      for (const phase of o.phases) {
        if (phase.endDragFirst) {
          (row || document.body).dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
        }
        const y = yFor(phase.at);
        const from = todos.scrollTop;
        const until = Date.now() + phase.ms;
        while (Date.now() < until) {
          // Dispatched on whatever is genuinely under the point, so the handler resolves the same scroll
          // container from event.target that a real dragover would.
          const under = (document.elementFromPoint(x, y) as HTMLElement) || todos;
          under.dispatchEvent(
            new DragEvent('dragover', {
              dataTransfer: dt,
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
            })
          );
          await sleep(50); // well inside the 150ms watchdog, as a real drag's own stream is
        }
        const to = todos.scrollTop;
        out.phases.push({ at: phase.at, endedFirst: !!phase.endDragFirst, from, to, delta: to - from });
      }

      // Always end the gesture, then look once more: a loop that outlived it would still be moving the list.
      (row || document.body).dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
      await sleep(200);
      out.settled = todos.scrollTop;
      out.rerendered = document.querySelector('.todos') !== todos;
      return out;
    }, { ...opts, marker: FIRST });
  }

  /** ------------------------------------------------------------------------------------------
   * The cases
   * --------------------------------------------------------------------------------------- */

  test('a drag held in the BOTTOM band scrolls the list down', async () => {
    let last: Probe | null = null;
    await expect
      .poll(
        async () => {
          last = await probe({ drag: true, preScroll: 'top', phases: [{ at: 'bottom', ms: 600 }] });
          return last.phases[0].delta;
        },
        { timeout: 60_000, intervals: [500, 1000, 2000] }
      )
      .toBeGreaterThan(MOVED_MIN);
    console.log('BOTTOM-BAND DIAG', JSON.stringify(last));
    expect(last!.dragStarted, 'the dragstart must have produced a payload').toBe(true);
    // And the scrolling stopped with the gesture: nothing moved in the 200ms after dragend.
    expect(Math.abs(last!.settled - last!.phases[0].to)).toBeLessThanOrEqual(STILL_TOL);
  });

  test('a drag held in the MIDDLE of the list does not scroll it', async () => {
    // Measured ONCE on purpose: expect.poll would retry until a run happened to hold still, which is exactly
    // the failure this case exists to catch.
    const result = await probe({ drag: true, preScroll: 'middle', phases: [{ at: 'middle', ms: 400 }] });
    console.log('MIDDLE DIAG', JSON.stringify(result));
    expect(result.rerendered, 'a background refresh mid-probe would invalidate the numbers').toBe(false);
    expect(result.dragStarted).toBe(true);
    expect(Math.abs(result.phases[0].delta), 'the middle of the list is inert').toBeLessThanOrEqual(STILL_TOL);
  });

  test('a drag held in the TOP band scrolls the list up', async () => {
    let last: Probe | null = null;
    await expect
      .poll(
        async () => {
          last = await probe({ drag: true, preScroll: 'middle', phases: [{ at: 'top', ms: 600 }] });
          return last.phases[0].delta;
        },
        { timeout: 60_000, intervals: [500, 1000, 2000] }
      )
      .toBeLessThan(-MOVED_MIN);
    console.log('TOP-BAND DIAG', JSON.stringify(last));
    expect(Math.abs(last!.settled - last!.phases[0].to)).toBeLessThanOrEqual(STILL_TOL);
  });

  test('dragend stops the scrolling even while the pointer stays in the band', async () => {
    // Two phases at the SAME point in the bottom band; the second one dispatches dragend first and then keeps
    // the dragover stream running. Only the drag's end can explain the second phase standing still - the
    // watchdog cannot, because the events never stop arriving.
    let last: Probe | null = null;
    await expect
      .poll(
        async () => {
          last = await probe({
            drag: true,
            preScroll: 'top',
            phases: [
              { at: 'bottom', ms: 400 },
              { at: 'bottom', ms: 600, endDragFirst: true },
            ],
          });
          return last.phases[0].delta;
        },
        { timeout: 60_000, intervals: [500, 1000, 2000] }
      )
      .toBeGreaterThan(MOVED_MIN);
    console.log('DRAGEND-STOP DIAG', JSON.stringify(last));
    expect(
      Math.abs(last!.phases[1].delta),
      'after dragend the list must stand still even with the pointer in the band'
    ).toBeLessThanOrEqual(STILL_TOL);
  });

  test('a FOREIGN drag (no dragstart from a row) never scrolls the list', async () => {
    // Measured once, for the same reason as the middle case: a retried negative proves nothing.
    const result = await probe({
      drag: false,
      preScroll: 'middle',
      phases: [
        { at: 'bottom', ms: 500 },
        { at: 'top', ms: 500 },
      ],
    });
    console.log('FOREIGN-DRAG DIAG', JSON.stringify(result));
    expect(result.rerendered, 'a background refresh mid-probe would invalidate the numbers').toBe(false);
    expect(result.dragStarted, 'this probe must not have started a drag at all').toBe(false);
    expect(Math.abs(result.phases[0].delta), 'the bottom band is inert for a foreign drag').toBeLessThanOrEqual(
      STILL_TOL
    );
    expect(Math.abs(result.phases[1].delta), 'the top band is inert for a foreign drag').toBeLessThanOrEqual(
      STILL_TOL
    );
  });
});
