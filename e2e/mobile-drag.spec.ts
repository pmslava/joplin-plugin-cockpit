import { test, expect, Page } from '@playwright/test';
import * as http from 'http';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  agendaPanel,
  createNotebook,
  selectNote,
  waitForPanelTodo,
  PANEL_IFRAME,
  PANEL_REFRESH_TIMEOUT,
} from './helpers';

/**
 * Real-app cover for the MOBILE touch drag: a 500 ms press on a to-do row lifts it, moving it resolves a target on
 * every move, and releasing drops it into the gap between two rows or onto a [data-drop] target (a group heading,
 * a calendar day, a week column) - the same two messages, and the same host writes, the desktop drag produces.
 *
 * Two things make this spec unusual, and both are deliberate.
 *
 * IT RUNS THE MOBILE PANEL UNDER THE DESKTOP APP. There is no Joplin-mobile harness here, and the gesture is gated
 * on `IS_MOBILE`, which the panel reads from the `#cockpitPlatform` marker the host emits on mobile only. So
 * `forceMobilePanel` injects that marker and re-runs `applyPlatformClass()`, which is the panel's own switch. The
 * marker is appended to `<body>` rather than into `#joplin-plugin-content`, so it survives every `setHtml`
 * re-render and the panel stays in mobile mode for the whole file. What this cannot reproduce is the mobile HOST:
 * on desktop a render is a `setHtml` rather than a full webview reload, and `refreshPanelData` does not consult the
 * refresh guard at all (it is gated on `mobile &&`). So the guard's EFFECT is out of reach here; what is in reach,
 * and what the guard-leak case below asserts, is that the webview posts a balanced pair and never a lone `true`.
 *
 * THE TOUCHES ARE REAL CDP INPUT, never synthetic `PointerEvent`s. `Input.dispatchTouchEvent` goes in at the
 * browser's own input layer, so Blink produces the touch AND pointer events, the compatibility mouse events and
 * the synthetic click exactly as a finger would - which is the only way the click swallower, the passive-listener
 * rules and the tap-versus-hold timing are exercised rather than assumed. Coordinates are therefore top-level
 * window coordinates: every frame-relative box is translated by the panel iframe's own origin.
 *
 * WHAT NO SPEC HERE CAN PROVE, and what the Pixel round is for: Android's own gesture arbitration. Chromium under
 * Xvfb happily lets a non-passive `touchmove` cancel the pan; whether the Android WebView's compositor hands the
 * gesture over at all - rather than starting a fling and delivering non-cancelable moves, or raising the native
 * text-selection callout over the row - is a property of the device, not of this harness. That is checklist step 2
 * in docs/MOBILE.md, and it is the one that decides between this gesture and the drag-handle fallback.
 */
test.describe('Touch drag to reschedule (mobile-mode panel)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const book = `Cockpit TDrag ${stamp}`;
  const outsideBook = `Cockpit TDrag Out ${stamp}`;

  // Joplin's own data API on this throwaway profile, off the 41184 default and off every other spec's port, so a
  // Joplin the developer happens to be running - or a stray process from another spec - is never talked to.
  const API_TOKEN = `cockpit-e2e-${stamp}`;
  const API_PORT = 41197;

  // The Today anchors the gap cases aim between, at three widely separated clock times.
  const LO = `td-lo-${stamp}`;
  const MID = `td-mid-${stamp}`;
  const HI = `td-hi-${stamp}`;
  // The rows that get dragged, one per case, so no case depends on another having run.
  const GAP = `td-gap-${stamp}`;
  const BAND_UP = `td-band-up-${stamp}`;
  const BAND_DOWN = `td-band-down-${stamp}`;
  const ONTO_DAY = `td-onto-day-${stamp}`;
  const ONTO_CLEAR = `td-onto-clear-${stamp}`;
  const MENU = `td-menu-${stamp}`;
  const CANCEL = `td-cancel-${stamp}`;
  const REFUSE = `td-refuse-${stamp}`;
  const TAP = `td-tap-${stamp}`;
  const TICK = `td-tick-${stamp}`;
  const ALARM = `td-alarm-${stamp}`;
  const TOMORROW = `td-tomorrow-${stamp}`;
  const PEEK = `td-peek-${stamp}`;
  // Undated filler: the "No Due Date" heading needs rows under it, and the scroll case needs the list to overflow.
  const FILLER = 40;
  const filler = (i: number) => `td-fill-${String(i).padStart(2, '0')}-${stamp}`;

  // The ids the data API gave the fixtures, so a due date can be read back from Joplin's own record rather than
  // from the panel's rendering of it.
  const ids: Record<string, string> = {};

  const MINUTE = 60 * 1000;

  /** A local Date today at HH:MM. Any clock time today lands in the panel's "Today" group. */
  const todayAt = (hour: number, minute = 0) => {
    const day = new Date();
    day.setHours(hour, minute, 0, 0);
    return day.getTime();
  };
  const yesterdayAt = (hour: number, minute = 0) => {
    const day = new Date();
    day.setDate(day.getDate() - 1);
    day.setHours(hour, minute, 0, 0);
    return day.getTime();
  };
  const tomorrowAt = (hour: number, minute = 0) => {
    const day = new Date();
    day.setDate(day.getDate() + 1);
    day.setHours(hour, minute, 0, 0);
    return day.getTime();
  };

  test.beforeAll(async () => {
    // Launch + API wait + ~55 seeded to-dos + the panel catching up do not fit the shared 240s budget on a slow
    // machine, and a hook timeout hides which step actually went wrong.
    test.setTimeout(420_000);
    joplin = await launchJoplin({
      settings: { 'clipperServer.autoStart': true, 'api.token': API_TOKEN, 'api.port': API_PORT },
    });
    const { win } = joplin;
    await createNotebook(win, book);
    await createNotebook(win, outsideBook);
    await apiReady(win);
    const folderId = await folderIdByTitle(book);
    const outsideFolderId = await folderIdByTitle(outsideBook);

    ids[LO] = await createTodoViaApi(LO, folderId, todayAt(8));
    ids[MID] = await createTodoViaApi(MID, folderId, todayAt(12));
    ids[HI] = await createTodoViaApi(HI, folderId, todayAt(20));
    // The dragged rows start Overdue (yesterday), so every drop is a visible move into another group.
    ids[GAP] = await createTodoViaApi(GAP, folderId, yesterdayAt(9));
    ids[BAND_UP] = await createTodoViaApi(BAND_UP, folderId, yesterdayAt(10));
    ids[BAND_DOWN] = await createTodoViaApi(BAND_DOWN, folderId, yesterdayAt(11));
    // ...except the two whole-row-target cases, which carry a TIME OF DAY that the drop must preserve (a heading
    // drop moves the day and nothing else) or clear outright.
    ids[ONTO_DAY] = await createTodoViaApi(ONTO_DAY, folderId, todayAt(14, 30));
    ids[ONTO_CLEAR] = await createTodoViaApi(ONTO_CLEAR, folderId, todayAt(16, 45));
    ids[MENU] = await createTodoViaApi(MENU, folderId, yesterdayAt(12));
    ids[CANCEL] = await createTodoViaApi(CANCEL, folderId, yesterdayAt(13));
    ids[REFUSE] = await createTodoViaApi(REFUSE, folderId, yesterdayAt(13, 30));
    ids[TAP] = await createTodoViaApi(TAP, folderId, yesterdayAt(14));
    ids[TICK] = await createTodoViaApi(TICK, folderId, yesterdayAt(15));
    ids[ALARM] = await createTodoViaApi(ALARM, folderId, yesterdayAt(16));
    // One to-do due tomorrow, purely so a "Tomorrow" heading (a dated [data-drop]) exists to drop onto.
    ids[TOMORROW] = await createTodoViaApi(TOMORROW, folderId, tomorrowAt(12));
    // The peek case's row lives in ANOTHER notebook, so filtering to this one and searching for it produces the
    // read-only "results outside current filters" section.
    ids[PEEK] = await createTodoViaApi(PEEK, outsideFolderId, yesterdayAt(17));
    for (let i = 0; i < FILLER; i++) await createTodoViaApi(filler(i), folderId);

    await waitForPanelTodo(win, LO);
    await waitForPanelTodo(win, HI);
    await waitForPanelTodo(win, filler(FILLER - 1));
    await forceMobilePanel(win);
    // The precondition the scroll case rests on: the list really does overflow its container.
    const metrics = await listMetrics();
    console.log('TOUCH DRAG FIXTURE', JSON.stringify(metrics));
    expect(metrics.maxScroll, 'the seeded list must overflow, or nothing can be scrolled').toBeGreaterThan(200);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  /** ------------------------------------------------------------------------------------------
   * Seeding through Joplin's data API
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

  async function folderIdByTitle(title: string): Promise<string> {
    const got = await apiRequest('GET', `/folders?token=${API_TOKEN}&limit=100`);
    if (got.status !== 200) throw new Error(`the data API refused the folder list: ${got.status} ${got.text}`);
    const found = (JSON.parse(got.text).items || []).find((f: any) => f.title === title);
    if (!found) throw new Error(`no notebook titled ${title} in the data API's folder list`);
    return found.id;
  }

  /** One to-do, straight into the notebook; returns its id. `dueMs` dates it, omitted leaves it undated. */
  async function createTodoViaApi(title: string, folderId: string, dueMs?: number): Promise<string> {
    const made = await apiRequest('POST', `/notes?token=${API_TOKEN}`, {
      title,
      is_todo: 1,
      parent_id: folderId,
      ...(dueMs === undefined ? {} : { todo_due: dueMs }),
    });
    if (made.status !== 200) throw new Error(`the data API refused a to-do: ${made.status} ${made.text}`);
    return JSON.parse(made.text).id;
  }

  /** What Joplin itself has stored for a to-do (epoch ms; 0 when undated). The panel's own rendering is a second
   * opinion at best - every reschedule below is judged on the record. */
  async function todoDue(marker: string): Promise<number> {
    const got = await apiRequest('GET', `/notes/${ids[marker]}?token=${API_TOKEN}&fields=id,todo_due`);
    if (got.status !== 200) throw new Error(`the data API refused a note read: ${got.status} ${got.text}`);
    return Number(JSON.parse(got.text).todo_due || 0);
  }

  async function todoCompleted(marker: string): Promise<number> {
    const got = await apiRequest('GET', `/notes/${ids[marker]}?token=${API_TOKEN}&fields=id,todo_completed`);
    if (got.status !== 200) throw new Error(`the data API refused a note read: ${got.status} ${got.text}`);
    return Number(JSON.parse(got.text).todo_completed || 0);
  }

  /** Poll Joplin's record until the drop has actually been written (the write is several async hops away). */
  async function dueSettles(marker: string, accept: (due: number) => boolean): Promise<number> {
    await expect
      .poll(async () => accept(await todoDue(marker)), { timeout: PANEL_REFRESH_TIMEOUT, intervals: [800, 1500, 2500] })
      .toBe(true);
    return todoDue(marker);
  }

  /** ------------------------------------------------------------------------------------------
   * Helper 1: the panel, in mobile mode
   * --------------------------------------------------------------------------------------- */

  /**
   * Put the panel into mobile mode and keep it there. `IS_MOBILE` is read from the `#cockpitPlatform` marker the
   * host emits on mobile only, so injecting that marker and re-running the panel's own `applyPlatformClass()` is
   * the whole switch - no code path is faked. The marker goes on `<body>`, OUTSIDE `#joplin-plugin-content`, so a
   * `setHtml` re-render (which replaces the wrapper's innerHTML) cannot destroy it and every later `reconcile()`
   * finds it again. Returns what the panel now thinks it is, so a case can assert it rather than hope.
   */
  async function forceMobilePanel(win: Page): Promise<boolean> {
    const panel = await agendaPanel(win);
    return panel.evaluate(() => {
      const w = window as any;
      if (!document.getElementById('cockpitPlatform')) {
        const marker = document.createElement('div');
        marker.id = 'cockpitPlatform';
        marker.hidden = true;
        document.body.appendChild(marker);
      }
      w.applyPlatformClass();
      return !!w.IS_MOBILE;
    });
  }

  /** ------------------------------------------------------------------------------------------
   * Helper 2: real touch input over CDP
   * --------------------------------------------------------------------------------------- */

  interface Point {
    x: number;
    y: number;
  }

  /**
   * A touch "finger" driven through the browser's own input pipeline. Synthetic `PointerEvent`s dispatched into the
   * page would prove nothing here: they never produce the compatibility mouse events or the synthetic click the
   * swallower has to eat, they are not subject to the passive-listener rules the whole gesture rests on, and they
   * cannot scroll the list. `Input.dispatchTouchEvent` is the real thing.
   *
   * Coordinates are TOP-LEVEL window coordinates (see `panelPoint`), because the CDP session is attached to the
   * main page and knows nothing of the panel's iframe.
   */
  async function newFinger(win: Page) {
    const cdp = await win.context().newCDPSession(win);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const dispatch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: Point[]) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), id: 1 })),
      });
    return {
      down: (at: Point) => dispatch('touchStart', [at]),
      move: (at: Point) => dispatch('touchMove', [at]),
      up: () => dispatch('touchEnd', []),
      /** A straight run of moves from the current point to `to`, so the gesture looks like a finger rather than a
       *  teleport - which matters for the pan case, and for the target changing along the way in the drag cases. */
      async glide(from: Point, to: Point, steps = 8, stepMs = 40) {
        for (let i = 1; i <= steps; i++) {
          await dispatch('touchMove', [
            { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps },
          ]);
          await win.waitForTimeout(stepMs);
        }
      },
      dispose: () => cdp.detach().catch(() => undefined),
    };
  }

  /** The panel iframe's own origin in the Joplin window, which every frame-relative box is translated by. */
  async function panelOrigin(win: Page): Promise<Point> {
    const box = await win.locator(PANEL_IFRAME).first().boundingBox();
    if (!box) throw new Error('the Cockpit panel iframe has no bounding box');
    return { x: box.x, y: box.y };
  }

  /**
   * Every point below is checked to be INSIDE the scroller's visible box before it is handed to a finger.
   * `.todos` keeps its scroll position across renders, so a case that leaves the list scrolled (the pan case does,
   * deliberately) would otherwise send the next case's touches into the panel header or clean out of the iframe -
   * and it would fail on the gesture, naming the wrong cause. `settle()` puts the list back at the top; this
   * throws with the list's own metrics when a point still lands off-screen. It deliberately does NOT scroll
   * anything into view itself: `dragRowTo` resolves its target point AFTER the row has been lifted, and a
   * coordinate helper that scrolled the list would be moving the target out from under a finger mid-gesture.
   */
  async function assertOnScreen(win: Page, what: string, y: number): Promise<void> {
    const list = await listBox(win);
    if (y >= list.top && y <= list.bottom) return;
    const metrics = await listMetrics();
    throw new Error(
      `${what} is not inside the visible list (y=${Math.round(y)}, list ${Math.round(list.top)}..${Math.round(
        list.bottom
      )}, scrollTop ${metrics.scrollTop} of ${metrics.maxScroll}) - the list is scrolled or too short, not the gesture's fault`
    );
  }

  /** The scroller's own visible box, in TOP-LEVEL coordinates. */
  async function listBox(win: Page): Promise<{ top: number; bottom: number }> {
    const panel = await agendaPanel(win);
    const box = await panel.evaluate(() => {
      const el = document.querySelector('.todos') as HTMLElement | null;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    });
    if (!box) throw new Error('the panel has no .todos scroller');
    const origin = await panelOrigin(win);
    return { top: origin.y + box.top, bottom: origin.y + box.bottom };
  }

  /** A point inside a to-do row, given as fractions of its box, in TOP-LEVEL coordinates. */
  async function rowPoint(win: Page, marker: string, fractionY: number, fractionX = 0.6): Promise<Point> {
    const panel = await agendaPanel(win);
    const box = await panel.evaluate((m) => {
      const rows = Array.from(document.querySelectorAll('.todo[data-todo-id]')) as HTMLElement[];
      const row = rows.find((r) => (r.textContent || '').includes(m));
      if (!row) return null;
      const rect = row.getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    }, marker);
    if (!box) throw new Error(`no row on screen for ${marker}`);
    const origin = await panelOrigin(win);
    const at = { x: origin.x + box.x + box.width * fractionX, y: origin.y + box.y + box.height * fractionY };
    await assertOnScreen(win, `the row for ${marker}`, at.y);
    return at;
  }

  /** The centre of a group heading, in TOP-LEVEL coordinates. `dropped` picks between the headings that accept a
   *  drop (they carry data-drop) and the ones that refuse every drop (Overdue and Future name no date). */
  async function headingPoint(win: Page, text: string, dropped = true): Promise<Point> {
    const panel = await agendaPanel(win);
    const box = await panel.evaluate(([t, withDrop]) => {
      const selector = withDrop ? '.todos h2[data-drop]' : '.todos h2:not([data-drop])';
      const heads = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
      const head = heads.find((h) => (h.textContent || '').trim() === t);
      if (!head) return null;
      const rect = head.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, [text, dropped] as [string, boolean]);
    if (!box) throw new Error(`no ${dropped ? 'droppable' : 'drop-refusing'} group heading "${text}" on screen`);
    const origin = await panelOrigin(win);
    const at = { x: origin.x + box.x, y: origin.y + box.y };
    await assertOnScreen(win, `the "${text}" heading`, at.y);
    return at;
  }

  /** The centre of a to-do's checkbox ring, in TOP-LEVEL coordinates. */
  async function checkboxPoint(win: Page, marker: string): Promise<Point> {
    const panel = await agendaPanel(win);
    const box = await panel.evaluate((m) => {
      const rows = Array.from(document.querySelectorAll('.todo[data-todo-id]')) as HTMLElement[];
      const row = rows.find((r) => (r.textContent || '').includes(m));
      const ring = row ? (row.querySelector('.todo-checkbox') as HTMLElement | null) : null;
      if (!ring) return null;
      const rect = ring.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, marker);
    if (!box) throw new Error(`no checkbox for ${marker}`);
    const origin = await panelOrigin(win);
    const at = { x: origin.x + box.x, y: origin.y + box.y };
    await assertOnScreen(win, `the checkbox for ${marker}`, at.y);
    return at;
  }

  /** ------------------------------------------------------------------------------------------
   * Helper 3: what the panel POSTED
   * --------------------------------------------------------------------------------------- */

  /**
   * Record every message the panel webview posts to the host, by wrapping `webviewApi.postMessage` and calling
   * through. It is what makes the negatives here real: "nothing was written" is otherwise indistinguishable from
   * "the write has not landed yet", and the guard pair - the one thing a leak would show up in - is invisible from
   * outside the webview entirely (on the desktop host the guard changes no behaviour at all).
   */
  async function armMessageLog(win: Page): Promise<void> {
    const panel = await agendaPanel(win);
    const wrapped = await panel.evaluate(() => {
      const w = window as any;
      const original = w.__cockpitPostOriginal || w.webviewApi.postMessage;
      if (!w.__cockpitPostWrapped) {
        w.__cockpitPostOriginal = w.webviewApi.postMessage;
        const through = w.webviewApi.postMessage.bind(w.webviewApi);
        w.webviewApi.postMessage = function (message: any) {
          try {
            w.__cockpitPosted.push(JSON.parse(JSON.stringify(message)));
          } catch {
            w.__cockpitPosted.push(['<unserialisable>']);
          }
          return through(message);
        };
        w.__cockpitPostWrapped = true;
      }
      w.__cockpitPosted = [];
      // The wrap ITSELF is the thing every negative below rests on: if `postMessage` were ever non-writable, an
      // accessor, or reinstated by a re-render, the assignment would no-op and "nothing was posted" would be true
      // of an empty log rather than of the panel. Answer whether the function in place is the one we installed.
      return w.webviewApi.postMessage !== original && w.__cockpitPostWrapped === true;
    });
    expect(wrapped, 'the postMessage wrap must be in place, or every negative here passes vacuously').toBe(true);
  }

  async function postedMessages(win: Page): Promise<any[][]> {
    const panel = await agendaPanel(win);
    return panel.evaluate(() => ((window as any).__cockpitPosted || []).slice());
  }

  /** The names of the posted messages, which is usually the whole assertion. */
  const names = (messages: any[][]) => messages.map((m) => String(m[0]));

  /** ------------------------------------------------------------------------------------------
   * Panel state probes
   * --------------------------------------------------------------------------------------- */

  async function listMetrics(): Promise<{ scrollTop: number; clientHeight: number; maxScroll: number }> {
    const panel = await agendaPanel(joplin.win);
    return panel.evaluate(() => {
      const el = document.querySelector('.todos') as HTMLElement | null;
      if (!el) return { scrollTop: -1, clientHeight: -1, maxScroll: -1 };
      return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, maxScroll: el.scrollHeight - el.clientHeight };
    });
  }

  /** What the panel is showing MID-GESTURE: the lifted row, the painted indicators, the banner. */
  async function dragState(): Promise<{
    dragging: number;
    before: number;
    after: number;
    over: number;
    banner: string | null;
    bannerCancel: boolean;
  }> {
    const panel = await agendaPanel(joplin.win);
    return panel.evaluate(() => {
      const banner = document.getElementById('cockpitDragBanner');
      return {
        dragging: document.querySelectorAll('.todo.-dragging').length,
        before: document.querySelectorAll('.todo.-drop-before').length,
        after: document.querySelectorAll('.todo.-drop-after').length,
        over: document.querySelectorAll('.-drop-over').length,
        banner: banner ? banner.textContent : null,
        // The lift banner already ENDS in the word "cancel" ("release outside the list to cancel"), so the text
        // alone cannot tell a resolved cancel state from a banner that was never re-labelled at all. The class is
        // what updateDragTarget actually toggles.
        bannerCancel: !!banner && banner.classList.contains('-cancel'),
      };
    });
  }

  /** The group heading a to-do row currently sits under, or null. */
  async function groupOf(marker: string): Promise<string | null> {
    const panel = await agendaPanel(joplin.win);
    return panel.evaluate((m) => {
      const rows = Array.from(document.querySelectorAll('.todo[data-todo-id]')) as HTMLElement[];
      const row = rows.find((r) => (r.textContent || '').includes(m));
      if (!row) return null;
      let el = row.previousElementSibling;
      while (el) {
        if (el.tagName === 'H2') return (el.textContent || '').trim();
        el = el.previousElementSibling;
      }
      return null;
    }, marker);
  }

  /** Settle between cases: each drop provokes a host render, and a gesture started into one would be measuring a
   *  list that is being replaced under it. */
  async function settle(): Promise<void> {
    await joplin.win.waitForTimeout(2500);
    await forceMobilePanel(joplin.win);
    // ...and put the list back at the top. The panel deliberately preserves its scroll position across renders,
    // so the pan case's 220px would otherwise still be there for every case after it, and their rows would be
    // aimed at off-screen. Done AFTER the wait, so a late render cannot restore the old position over it.
    const panel = await agendaPanel(joplin.win);
    await panel.evaluate(() => {
      const list = document.querySelector('.todos') as HTMLElement | null;
      if (list) list.scrollTop = 0;
    });
    await joplin.win.waitForTimeout(150);
  }

  /** ------------------------------------------------------------------------------------------
   * The cases
   * --------------------------------------------------------------------------------------- */

  test('a hold and a move into a gap lands the to-do strictly between its new neighbours', async () => {
    const { win } = joplin;
    expect(await forceMobilePanel(win), 'the panel must be in mobile mode').toBe(true);
    await armMessageLog(win);
    const finger = await newFinger(win);
    try {
      const from = await rowPoint(win, GAP, 0.5);
      await finger.down(from);
      await win.waitForTimeout(700); // past the 500ms hold: the row lifts
      const lifted = await dragState();
      console.log('TOUCH DRAG LIFTED', JSON.stringify(lifted));
      expect(lifted.dragging, 'the held row must be lifted').toBe(1);
      expect(lifted.banner, 'the banner must name what is moving').toContain('Moving');
      // Into the BOTTOM half of the 08:00 anchor, which is the gap between it and the 12:00 one.
      const to = await rowPoint(win, LO, 0.8);
      await finger.glide(from, to);
      const aiming = await dragState();
      console.log('TOUCH DRAG AIMING', JSON.stringify(aiming));
      expect(aiming.before + aiming.after, 'exactly one insertion line must be painted').toBe(1);
      await finger.up();
    } finally {
      await finger.dispose();
    }

    const posted = await postedMessages(win);
    console.log('TOUCH DRAG POSTED', JSON.stringify(posted));
    expect(names(posted), 'the gap drop must post the desktop between-drop message').toContain('todosDroppedBetween');
    const between = posted.find((m) => m[0] === 'todosDroppedBetween')!;
    expect(between[1], 'the payload is the dragged to-do').toEqual([ids[GAP]]);
    // The guard is taken on the first move and released after the drop message, in that order.
    const guards = posted.filter((m) => m[0] === 'dialogGuard');
    expect(guards.map((m) => m[1]), 'the refresh guard must be taken once and released once').toEqual([true, false]);
    expect(posted.indexOf(between), 'the drop must be posted before the guard is released').toBeLessThan(
      posted.indexOf(guards[1])
    );

    const due = await dueSettles(GAP, (d) => d > todayAt(8) && d < todayAt(12));
    console.log('TOUCH DRAG DUE', new Date(due).toString());
    expect(due, 'strictly after the 08:00 neighbour').toBeGreaterThan(todayAt(8));
    expect(due, 'strictly before the 12:00 neighbour').toBeLessThan(todayAt(12));
    await expect.poll(async () => groupOf(GAP), { timeout: PANEL_REFRESH_TIMEOUT, intervals: [1500, 2500] }).toBe('Today');
  });

  test('the top and bottom halves of the SAME row resolve to different gaps', async () => {
    const { win } = joplin;
    await settle();
    // Above the 12:00 anchor -> the gap over it, so the due must land BEFORE 12:00...
    await dragRowTo(BAND_UP, () => rowPoint(win, MID, 0.15));
    const up = await dueSettles(BAND_UP, (d) => d > todayAt(0) && d < todayAt(12));
    // ...and below the very same row -> the gap under it, after 12:00 and before the 20:00 anchor.
    await settle();
    await dragRowTo(BAND_DOWN, () => rowPoint(win, MID, 0.85));
    const down = await dueSettles(BAND_DOWN, (d) => d > todayAt(12) && d < todayAt(20));
    console.log('TOUCH DRAG BANDS', new Date(up).toString(), new Date(down).toString());
    expect(up, 'the top half inserts ABOVE the row').toBeLessThan(todayAt(12));
    expect(down, 'the bottom half inserts BELOW it').toBeGreaterThan(todayAt(12));
    expect(up, 'and so the two halves are two different gaps').toBeLessThan(down);
  });

  test('a drop on a dated heading moves the day and keeps the time of day', async () => {
    const { win } = joplin;
    await settle();
    const before = await todoDue(ONTO_DAY);
    expect(new Date(before).getHours() * 60 + new Date(before).getMinutes(), 'precondition: 14:30').toBe(14 * 60 + 30);
    await dragRowTo(ONTO_DAY, () => headingPoint(win, 'Tomorrow'));
    const after = await dueSettles(ONTO_DAY, (d) => d > todayAt(23, 59));
    const when = new Date(after);
    console.log('TOUCH DRAG HEADING DROP', when.toString());
    expect(when.getHours() * 60 + when.getMinutes(), 'the time of day must survive the move').toBe(14 * 60 + 30);
    expect(after, 'and the day must be tomorrow').toBeGreaterThan(todayAt(23, 59));
    expect(after, '...tomorrow, not later').toBeLessThan(tomorrowAt(23, 59) + MINUTE);
  });

  test('a drop on the No Due Date heading clears the due date', async () => {
    const { win } = joplin;
    await settle();
    expect(await todoDue(ONTO_CLEAR), 'precondition: it has a due date').toBeGreaterThan(0);
    await dragRowTo(ONTO_CLEAR, () => headingPoint(win, 'No Due Date'));
    const after = await dueSettles(ONTO_CLEAR, (d) => d === 0);
    expect(after, 'the "clear" target must clear the due date outright').toBe(0);
  });

  test('a heading that refuses every drop is not the gap above it either', async () => {
    const { win } = joplin;
    await settle();
    // "Overdue" and "Future" name no date, so getHeadingDropTarget gives them no data-drop and they accept
    // nothing. They are also SIBLINGS of the rows, sitting in the gap the row index attributes to the row above -
    // and, being sticky, they float over rows in a scrolled list. Without the resolver's own bail on a heading,
    // aiming at one would silently write the to-do into the group BEFORE it. The desktop drag is inert here.
    const before = await todoDue(REFUSE);
    await waitForPanelTodo(win, REFUSE);
    await armMessageLog(win);
    const finger = await newFinger(win);
    try {
      const from = await rowPoint(win, REFUSE, 0.5);
      await finger.down(from);
      await win.waitForTimeout(700);
      expect((await dragState()).dragging, 'the row must be lifted by the hold').toBe(1);
      // headingPoint with `dropped: false` asserts the heading really carries no data-drop, so this case cannot
      // quietly become a test of a droppable heading.
      const to = await headingPoint(win, 'Overdue', false);
      await finger.glide(from, to);
      const aiming = await dragState();
      console.log('TOUCH REFUSED HEADING', JSON.stringify(aiming));
      expect(aiming.before + aiming.after + aiming.over, 'a heading that refuses drops must paint nothing at all').toBe(0);
      expect(aiming.bannerCancel, 'and the banner must say a release would cancel').toBe(true);
      await finger.up();
    } finally {
      await finger.dispose();
    }
    const posted = await postedMessages(win);
    console.log('TOUCH REFUSED POSTED', JSON.stringify(posted));
    expect(names(posted), 'a drop-refusing heading must write nothing at all').not.toContain('todosDropped');
    expect(names(posted), 'and above all must not write the gap above it').not.toContain('todosDroppedBetween');
    expect(
      posted.filter((m) => m[0] === 'dialogGuard').map((m) => m[1]),
      'the guard is still taken and released, like any other travelled drag'
    ).toEqual([true, false]);
    expect(await todoDue(REFUSE), 'and the due date is untouched').toBe(before);
  });

  test('a hold and a release WITHOUT moving still opens the context menu, and opens no note', async () => {
    const { win } = joplin;
    await settle();
    // Park the editor somewhere else, so "the note did not open" is observable.
    await selectNote(win, LO);
    const before = await todoDue(MENU);
    await armMessageLog(win);
    const finger = await newFinger(win);
    try {
      await finger.down(await rowPoint(win, MENU, 0.5));
      await win.waitForTimeout(700);
      expect((await dragState()).dragging, 'the row is lifted while the finger is down').toBe(1);
      await finger.up();
    } finally {
      await finger.dispose();
    }
    const panel = await agendaPanel(win);
    await expect(panel.locator('#noteContextMenu')).toBeVisible();
    const posted = await postedMessages(win);
    console.log('TOUCH MENU POSTED', JSON.stringify(posted));
    // A lift that never travelled never takes the refresh guard - the host answers a release by repainting, and on
    // mobile that repaint is a webview reload which would destroy the menu this very release just opened.
    expect(names(posted), 'a hold-and-release must not touch the refresh guard').not.toContain('dialogGuard');
    expect(names(posted), 'and must write nothing').not.toContain('todosDropped');
    expect(names(posted), 'and must write nothing').not.toContain('todosDroppedBetween');
    expect(names(posted), 'and the synthetic click must not open the note').not.toContain('todoClicked');
    expect(await todoDue(MENU), 'the due date is untouched').toBe(before);
    await expect.poll(async () => win.locator('input.title-input').inputValue(), { timeout: 30_000 }).toContain(LO);
    await panel.locator('body').press('Escape');
    await expect(panel.locator('#noteContextMenu')).toHaveCount(0);
  });

  test('a press SHORTER than the hold scrolls the list and writes nothing', async () => {
    const { win } = joplin;
    await settle();
    const before = await listMetrics();
    await armMessageLog(win);
    const finger = await newFinger(win);
    try {
      const from = await rowPoint(win, LO, 0.5);
      await finger.down(from);
      await win.waitForTimeout(300); // well short of the 500ms hold: this is a pan, not a lift
      // The first move goes in IMMEDIATELY after the wait, before any probe: a `dragState()` evaluate that took
      // 200ms on a loaded machine would let the 500ms hold fire, and the case would silently become a drag test
      // that fails on its own assertions. Past the 10px slop, this move also cancels the pending press outright,
      // so the probe after it can no longer race anything.
      const panned = { x: from.x, y: from.y - 30 };
      await finger.move(panned);
      expect((await dragState()).dragging, 'nothing may be lifted before the hold fires').toBe(0);
      await finger.glide(panned, { x: from.x, y: from.y - 220 }, 10, 25);
      await finger.up();
    } finally {
      await finger.dispose();
    }
    await win.waitForTimeout(600);
    const after = await listMetrics();
    console.log('TOUCH PAN', JSON.stringify({ before: before.scrollTop, after: after.scrollTop }));
    expect(after.scrollTop, 'the list must still scroll by flick - nothing may take that away').toBeGreaterThan(
      before.scrollTop
    );
    const posted = await postedMessages(win);
    // A scrolled list posts its new position, so the log is NOT empty here - which is what stops the three
    // negatives below from passing on a log that never recorded anything in the first place.
    expect(names(posted), 'the pan must have posted its new scroll position').toContain('scrollChanged');
    for (const forbidden of ['todosDropped', 'todosDroppedBetween', 'dialogGuard']) {
      expect(names(posted), `a pan must not post ${forbidden}`).not.toContain(forbidden);
    }
  });

  test('a tap still opens the note', async () => {
    const { win } = joplin;
    await settle();
    await selectNote(win, LO);
    await waitForPanelTodo(win, TAP);
    const finger = await newFinger(win);
    try {
      const at = await rowPoint(win, TAP, 0.5, 0.5);
      await finger.down(at);
      await win.waitForTimeout(80);
      await finger.up();
    } finally {
      await finger.dispose();
    }
    await expect.poll(async () => win.locator('input.title-input').inputValue(), { timeout: 30_000 }).toContain(TAP);
  });

  test('the checkbox ring keeps its own gestures: a tap ticks, a hold opens the date picker', async () => {
    const { win } = joplin;
    await settle();
    await waitForPanelTodo(win, TICK);
    expect(await todoCompleted(TICK), 'precondition: open').toBe(0);
    let finger = await newFinger(win);
    try {
      const at = await checkboxPoint(win, TICK);
      await finger.down(at);
      await win.waitForTimeout(80);
      await finger.up();
    } finally {
      await finger.dispose();
    }
    await expect
      .poll(async () => todoCompleted(TICK), { timeout: PANEL_REFRESH_TIMEOUT, intervals: [800, 1500, 2500] })
      .toBeGreaterThan(0);

    await settle();
    await waitForPanelTodo(win, ALARM);
    const panel = await agendaPanel(win);
    finger = await newFinger(win);
    try {
      await finger.down(await checkboxPoint(win, ALARM));
      await win.waitForTimeout(700);
      // The ring is NOT a drag zone: the hold must reach the date picker, not lift the row.
      expect((await dragState()).dragging, 'a hold on the ring must not lift the row').toBe(0);
      await finger.up();
    } finally {
      await finger.dispose();
    }
    await expect(panel.locator('#cockpitOverlay')).toBeVisible();
    await panel.locator('#cockpitOverlay .cockpit-overlay-footer button', { hasText: 'Cancel' }).first().click();
    await expect(panel.locator('#cockpitOverlay')).toHaveCount(0);
  });

  test('a cancel over the panel header writes nothing, and leaves the refresh guard balanced', async () => {
    const { win } = joplin;
    await settle();
    const before = await todoDue(CANCEL);
    await armMessageLog(win);
    const finger = await newFinger(win);
    try {
      const from = await rowPoint(win, CANCEL, 0.5);
      await finger.down(from);
      await win.waitForTimeout(700);
      // Out of the list altogether, onto the panel's own controls: nothing there is a drop target.
      const origin = await panelOrigin(win);
      await finger.glide(from, { x: from.x, y: origin.y + 12 }, 10, 40);
      const cancelling = await dragState();
      console.log('TOUCH CANCEL STATE', JSON.stringify(cancelling));
      expect(cancelling.before + cancelling.after + cancelling.over, 'nothing may be painted as a target').toBe(0);
      expect(cancelling.bannerCancel, 'and the banner must be in its cancel state, not merely still up').toBe(true);
      for (const named of ['before ', 'after ', 'onto ']) {
        expect(cancelling.banner, 'a cancel banner must name no target').not.toContain(named);
      }
      await finger.up();
    } finally {
      await finger.dispose();
    }
    const posted = await postedMessages(win);
    console.log('TOUCH CANCEL POSTED', JSON.stringify(posted));
    expect(names(posted), 'a cancel must write nothing').not.toContain('todosDropped');
    expect(names(posted), 'a cancel must write nothing').not.toContain('todosDroppedBetween');
    // THE LEAK CHECK. A `true` with no `false` freezes every mobile refresh for the life of the webview; the host
    // here is a desktop one and would not show it, so the pair itself is the evidence.
    expect(
      posted.filter((m) => m[0] === 'dialogGuard').map((m) => m[1]),
      'the guard must be taken once and released once, even when nothing is dropped'
    ).toEqual([true, false]);
    expect(await todoDue(CANCEL), 'and the due date is untouched').toBe(before);
    // ...and the panel is not left frozen: a note created afterwards still reaches it.
    const folderId = await folderIdByTitle(book);
    const later = `td-after-cancel-${stamp}`;
    await createTodoViaApi(later, folderId);
    await waitForPanelTodo(win, later);
  });

  test('a read-only peek row is never lifted, and still opens its menu', async () => {
    const { win } = joplin;
    await settle();
    const panel = await agendaPanel(win);
    // The peek appears when a committed search matches nothing INSIDE the current filters and something outside
    // them: filter to this spec's notebook, then search for the to-do that lives in the other one.
    await expect
      .poll(
        async () =>
          panel.locator('#notebookMenu .dropdown-item .dropdown-label', { hasText: book }).count(),
        { timeout: PANEL_REFRESH_TIMEOUT }
      )
      .toBeGreaterThan(0);
    await panel.locator('.dropdown-toggle[onclick*="notebookMenu"]').click();
    await expect(panel.locator('#notebookMenu')).toBeVisible();
    await panel.locator('#notebookMenu .dropdown-item', { hasText: book }).locator('.dropdown-label').first().click();
    const search = panel.locator('#searchFilter');
    await expect
      .poll(
        async () => {
          await search.click();
          await search.fill(PEEK);
          await search.press('Enter');
          await win.waitForTimeout(1200);
          return panel.locator('.outside-results .todo-title', { hasText: PEEK }).count();
        },
        { timeout: PANEL_REFRESH_TIMEOUT, intervals: [1500, 2500, 4000] }
      )
      .toBeGreaterThan(0);
    await forceMobilePanel(win);

    await armMessageLog(win);
    const finger = await newFinger(win);
    try {
      await finger.down(await rowPoint(win, PEEK, 0.5));
      await win.waitForTimeout(700);
      expect((await dragState()).dragging, 'a peek row must never be lifted - it is not a reschedule source').toBe(0);
      await finger.up();
    } finally {
      await finger.dispose();
    }
    // Its long press keeps doing what it always did: the single-note menu for the peeked note.
    await expect(panel.locator('#noteContextMenu')).toBeVisible();
    const posted = await postedMessages(win);
    expect(names(posted), 'and no drag machinery runs for it').not.toContain('dialogGuard');
    await panel.locator('body').press('Escape');
  });

  /**
   * One drag, start to finish: hold a row until it lifts, glide onto whatever `target()` resolves to at that
   * moment (a heading's centre, a point in a row's top or bottom half), and release there. The target is resolved
   * AFTER the lift on purpose - a panel that re-rendered between the two would otherwise be aimed at with stale
   * coordinates.
   */
  async function dragRowTo(marker: string, target: () => Promise<Point>): Promise<void> {
    const { win } = joplin;
    await waitForPanelTodo(win, marker);
    const finger = await newFinger(win);
    try {
      const from = await rowPoint(win, marker, 0.5);
      await finger.down(from);
      await win.waitForTimeout(700);
      expect((await dragState()).dragging, `${marker} must be lifted by the hold`).toBe(1);
      const to = await target();
      await finger.glide(from, to);
      const aiming = await dragState();
      console.log('TOUCH DRAG AIM', marker, JSON.stringify(aiming));
      expect(
        aiming.before + aiming.after + aiming.over,
        'a resolved target must be painted, and exactly one of them'
      ).toBe(1);
      await finger.up();
    } finally {
      await finger.dispose();
    }
  }
});
