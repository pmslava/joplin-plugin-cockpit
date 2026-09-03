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
 * Real-app cover for the MOBILE touch drag, which is MENU-FIRST since the first Pixel round: a 500 ms press on a
 * to-do row opens its context menu with the finger still down and arms the drag silently behind it; the first
 * travel past the 10 px slop then decides, once - UP or DOWN closes the menu, lifts the row and enters the drag
 * proper, SIDEWAYS is left to Android (that stroke is Joplin's own side-menu swipe) and the arming is thrown away.
 * A release that never moved leaves the menu exactly as the press opened it. From the lift on, moving resolves a
 * target on every move and releasing drops into the gap between two rows or onto a [data-drop] target (a group
 * heading, a calendar day, a week column) - the same two messages, and the same host writes, the desktop drag
 * produces.
 *
 * Because of that order, no case here lifts a row by holding alone: every drag case holds, checks the menu is up
 * and nothing is lifted, then makes ONE deliberate vertical step (`liftByMovingUpOrDown`) and only then aims.
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
 * ANDROID'S OWN `contextmenu` IS SYNTHETIC HERE, and only here. Since the second Pixel round the panel suppresses
 * `contextmenu` panel-wide on mobile - the rows carry inline oncontextmenu handlers (src/core/formats.ts), and the
 * platform's long press was using them to open the context menu behind this gesture's back. The two cases for that
 * dispatch a `MouseEvent` rather than gesturing, deliberately: what is under test is the EVENT PATH (is it
 * cancelled, does the inline handler run, does the opener refuse a caller mid-drag), which a dispatched event
 * exercises exactly, while the long press that emits it on a device is Android's own and no harness of ours can
 * make Chromium under Xvfb produce it. The drag halves of those cases are real CDP touch like everything else.
 *
 * WHAT NO SPEC HERE CAN PROVE, and what the Pixel round is for: Android's own gesture arbitration. Chromium under
 * Xvfb happily lets a non-passive `touchmove` cancel the pan; whether the Android WebView's compositor hands the
 * gesture over at all - rather than starting a fling and delivering non-cancelable moves, or raising the native
 * text-selection callout over the row - is a property of the device, not of this harness. Nor can it prove the
 * other half of the new order: that a SIDEWAYS stroke, which this panel now deliberately does not prevent, really
 * does reach Joplin's side menu. Both are checklist step 18b in docs/MOBILE.md, and they are what decides between
 * this gesture and the drag-handle fallback.
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
  // The two cases for Android's own `contextmenu`: one that never gestures at all, and one that fires it in the
  // middle of a lifted drag.
  const CTX = `td-ctx-${stamp}`;
  const CTX_DRAG = `td-ctxdrag-${stamp}`;
  const CANCEL = `td-cancel-${stamp}`;
  const REFUSE = `td-refuse-${stamp}`;
  const SWIPE = `td-swipe-${stamp}`;
  const TAP = `td-tap-${stamp}`;
  const TICK = `td-tick-${stamp}`;
  const ALARM = `td-alarm-${stamp}`;
  const TOMORROW = `td-tomorrow-${stamp}`;
  const PEEK = `td-peek-${stamp}`;
  // Where Joplin's editor is parked before the two cases that have to see it NOT move. A plain note, so it never
  // reaches the panel and can never be mistaken for a row, and seeded LAST: the note list sorts by
  // `user_updated_time` reversed (`notes.sortOrder.field` / `.reverse` defaults), so the newest note is the first
  // one, and Joplin renders that list a viewport at a time. Parking on an early fixture instead would aim at a row
  // fifty places down that is not in the DOM at all.
  // That "newest is first" only holds because `beforeAll` turns OFF `uncompletedTodosOnTop`: Joplin GROUPS before
  // it sorts, and with the default (true) every uncompleted to-do outranks every plain note - which put this one
  // note last behind 55 to-dos, outside the virtualised list, and hung both cases that need it.
  // `parkEditor` below still checks the assumption rather than trusting it.
  const PARK = `td-park-${stamp}`;
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
      settings: {
        'clipperServer.autoStart': true,
        'api.token': API_TOKEN,
        'api.port': API_PORT,
        // File-storage, default TRUE, and it groups the note list before sorting it: every uncompleted to-do
        // above every plain note. This spec seeds 55 to-dos and ONE plain note (PARK) that it has to click, so
        // the default buried PARK at the bottom of a virtualised list. Off, the list is a plain
        // newest-`user_updated_time`-first order and the last-seeded note is the first row.
        'uncompletedTodosOnTop': false,
      },
    });
    const { win } = joplin;
    // The OUTSIDE notebook FIRST and this spec's own second, because `createNotebook` leaves the notebook it just
    // made selected in the app - and two cases below park Joplin's editor on a note by clicking it in the note
    // list, which only ever lists the SELECTED notebook. Created the other way round the app sat on the outside
    // notebook, whose list holds one note, and those two cases spent their whole 240s budget waiting for a row
    // that was never going to be there.
    await createNotebook(win, outsideBook);
    await createNotebook(win, book);
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
    ids[CTX] = await createTodoViaApi(CTX, folderId, yesterdayAt(12, 15));
    ids[CTX_DRAG] = await createTodoViaApi(CTX_DRAG, folderId, yesterdayAt(12, 30));
    ids[CANCEL] = await createTodoViaApi(CANCEL, folderId, yesterdayAt(13));
    ids[REFUSE] = await createTodoViaApi(REFUSE, folderId, yesterdayAt(13, 30));
    ids[SWIPE] = await createTodoViaApi(SWIPE, folderId, yesterdayAt(13, 45));
    ids[TAP] = await createTodoViaApi(TAP, folderId, yesterdayAt(14));
    ids[TICK] = await createTodoViaApi(TICK, folderId, yesterdayAt(15));
    ids[ALARM] = await createTodoViaApi(ALARM, folderId, yesterdayAt(16));
    // One to-do due tomorrow, purely so a "Tomorrow" heading (a dated [data-drop]) exists to drop onto.
    ids[TOMORROW] = await createTodoViaApi(TOMORROW, folderId, tomorrowAt(12));
    // The peek case's row lives in ANOTHER notebook, so filtering to this one and searching for it produces the
    // read-only "results outside current filters" section.
    ids[PEEK] = await createTodoViaApi(PEEK, outsideFolderId, yesterdayAt(17));
    for (let i = 0; i < FILLER; i++) await createTodoViaApi(filler(i), folderId);
    ids[PARK] = await createNoteViaApi(PARK, folderId);

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

  /** One PLAIN note (never a to-do, so the panel never lists it); returns its id. */
  async function createNoteViaApi(title: string, folderId: string): Promise<string> {
    const made = await apiRequest('POST', `/notes?token=${API_TOKEN}`, { title, parent_id: folderId });
    if (made.status !== 200) throw new Error(`the data API refused a note: ${made.status} ${made.text}`);
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

  /**
   * The move that turns the open menu into a lifted row. The gesture is decided by the FIRST travel past the 10 px
   * slop and by nothing else: |dy| >= |dx| lifts, |dx| > |dy| is refused as Joplin's side-menu swipe. So the lift
   * is one deliberate 24 px step at a CONSTANT x - unambiguously vertical, well past the slop, and the same move a
   * finger makes when it starts dragging a row. Returns where the finger now is, which is what the aim glides from.
   *
   * `bounded` is for the cases that MUST NOT lift anything (the tick circle, a read-only peek row): there is no
   * target to aim at afterwards, the finger may be standing over an open overlay or a search render, and consulting
   * the `.todos` scroller there buys nothing while adding a way to fail on the list's metrics rather than on the
   * gesture. Those take the plain 24 px step downwards.
   */
  async function liftByMovingUpOrDown(
    finger: { move: (at: Point) => Promise<unknown> },
    from: Point,
    win: Page,
    bounded = true
  ): Promise<Point> {
    const at = { x: from.x, y: from.y + (bounded ? await verticalLiftStep(win, from) : 24) };
    await finger.move(at);
    await win.waitForTimeout(80);
    return at;
  }

  /**
   * The signed 24 px step, and where it may not land. The bound is not merely "does the point stay inside the
   * list": the drag's own edge auto-scroll arms inside a band at the top and the bottom of the scroller, and a
   * finger parked in a band starts the list scrolling on the very move that lifts the row - under a finger that
   * then holds still, since `onTouchDragScrolled` re-aims and keeps the loop alive by itself. The aim that follows
   * would glide over a moving list and the drop would land wherever the list had got to. So the step is taken
   * towards whichever edge is further away, the other direction is taken when only IT is clear, and only when
   * neither is does the case fail here, naming the band - rather than later, looking like a bad aim (which is
   * exactly the misdiagnosis this file's header warns about).
   *
   * Two things make the bound the panel's own rather than a guessed margin:
   *  - the band is computed with edgeAutoscrollStep's arithmetic verbatim (AUTOSCROLL_BAND_* in panelWebview.js),
   *    including the min(height/2, ...) clamp that keeps the two bands from overlapping in a short list;
   *  - a band is only LIVE where the scroller can still move that way. `edgeAutoscrollTick` stops the loop on the
   *    first frame that does not change scrollTop, so the top band scrolls nothing at scrollTop 0 - which is
   *    exactly where `settle()` puts every case, and where the first rows of the first group sit - and the bottom
   *    band scrolls nothing once the list is at its end. Refusing an inert band would fail the cases whose source
   *    row is near the top of an unscrolled list, for a hazard that provably cannot happen to them.
   */
  async function verticalLiftStep(win: Page, from: Point): Promise<number> {
    const list = await listBox(win);
    const metrics = await listMetrics();
    const height = list.bottom - list.top;
    const band = Math.min(height / 2, Math.max(32, Math.min(72, height * 0.15)));
    const inLiveBand = (y: number) =>
      (y - list.top < band && metrics.scrollTop > 0) ||
      (list.bottom - y < band && metrics.scrollTop < metrics.maxScroll);
    const clearance = (y: number) => Math.min(y - list.top, list.bottom - y);
    // One predicate for both bounds, so the throw below is the only exit: on screen at all (the `assertOnScreen`
    // test, folded in rather than run separately, since a step that failed it would have been rejected here), and
    // not inside a band that can actually run.
    const usable = (y: number) => y >= list.top && y <= list.bottom && !inLiveBand(y);
    // Towards the middle of the list first, and the other way only if the preferred landing point is unusable.
    const order = clearance(from.y + 24) >= clearance(from.y - 24) ? [24, -24] : [-24, 24];
    const step = order.find((s) => usable(from.y + s));
    if (step === undefined) {
      throw new Error(
        `neither lifting step is usable from y=${Math.round(from.y)}: the list is ${Math.round(
          list.top
        )}..${Math.round(list.bottom)}, its edge auto-scroll band is ${Math.round(
          band
        )}px deep, and it is scrolled to ${metrics.scrollTop} of ${metrics.maxScroll} - so both +24 and -24 land ` +
          `off-screen or inside a band that CAN scroll, where the list would move under the still finger and the ` +
          `drop would land wherever it got to. Not the gesture's fault: the source row is too near an edge for ` +
          `this case.`
      );
    }
    return step;
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

  /** The centre of a footer button in the open in-panel overlay, in TOP-LEVEL coordinates. */
  async function overlayButtonPoint(win: Page, label: string): Promise<Point> {
    const panel = await agendaPanel(win);
    const box = await panel.evaluate((text) => {
      const buttons = Array.from(
        document.querySelectorAll('#cockpitOverlay .cockpit-overlay-footer button')
      ) as HTMLElement[];
      const button = buttons.find((b) => (b.textContent || '').trim() === text);
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, label);
    if (!box) throw new Error(`the open overlay has no ${label} button`);
    const origin = await panelOrigin(win);
    return { x: origin.x + box.x, y: origin.y + box.y };
  }

  /**
   * One tap, with a finger of its own. Used where a case has to press something with touch rather than with
   * Playwright's mouse - see the ring case for the one place where that difference is the whole point.
   */
  async function tapAt(win: Page, at: Point): Promise<void> {
    const finger = await newFinger(win);
    try {
      await finger.down(at);
      await win.waitForTimeout(80);
      await finger.up();
    } finally {
      await finger.dispose();
    }
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

  /**
   * Park Joplin's editor on the plain fixture note, which is what makes "the note did not open" and "the tap DID
   * open it" observable at all. It checks the row is in the note list before clicking it and checks the editor
   * followed afterwards: a park that cannot happen - the wrong notebook selected, or a note too far down a
   * virtualised list to be rendered - then fails in seconds, by name, instead of hanging a case on a click that
   * waits out its whole budget.
   */
  async function parkEditor(win: Page): Promise<void> {
    const row = win.locator('.note-list-item .title span', { hasText: PARK }).first();
    await expect(
      row,
      `${PARK} must be rendered in the note list - is Joplin showing ${book}, newest note first?`
    ).toBeVisible({ timeout: 30_000 });
    await selectNote(win, PARK);
    await expect
      .poll(async () => win.locator('input.title-input').inputValue(), { timeout: 30_000 })
      .toContain(PARK);
  }

  /** ------------------------------------------------------------------------------------------
   * The cases
   * --------------------------------------------------------------------------------------- */

  test('a hold, then a move up or down into a gap, lands the to-do strictly between its new neighbours', async () => {
    const { win } = joplin;
    expect(await forceMobilePanel(win), 'the panel must be in mobile mode').toBe(true);
    await armMessageLog(win);
    const panel = await agendaPanel(win);
    const finger = await newFinger(win);
    try {
      const from = await rowPoint(win, GAP, 0.5);
      await finger.down(from);
      await win.waitForTimeout(700); // past the 500ms hold: the MENU opens, with the finger still down
      const held = await dragState();
      console.log('TOUCH DRAG HELD', JSON.stringify(held));
      expect(held.dragging, 'the hold alone must not lift anything').toBe(0);
      expect(held.banner, 'and it must put no banner up either').toBe(null);
      await expect(panel.locator('#noteContextMenu'), 'the hold opens the menu').toBeVisible();
      // The one deliberate vertical step: THIS is what lifts the row, and it closes the menu.
      const at = await liftByMovingUpOrDown(finger, from, win);
      const lifted = await dragState();
      console.log('TOUCH DRAG LIFTED', JSON.stringify(lifted));
      expect(lifted.dragging, 'a vertical first move must lift the held row').toBe(1);
      expect(lifted.banner, 'the banner must name what is moving').toContain('Moving');
      await expect(panel.locator('#noteContextMenu'), 'and the menu must be gone').toHaveCount(0);
      // Into the BOTTOM half of the 08:00 anchor, which is the gap between it and the 12:00 one.
      const to = await rowPoint(win, LO, 0.8);
      await finger.glide(at, to);
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
    // The guard is taken at the LIFT and released after the drop message, in that order.
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
      expect((await dragState()).dragging, 'the hold alone must not lift the row').toBe(0);
      const at = await liftByMovingUpOrDown(finger, from, win);
      expect((await dragState()).dragging, 'the vertical move must lift it').toBe(1);
      // headingPoint with `dropped: false` asserts the heading really carries no data-drop, so this case cannot
      // quietly become a test of a droppable heading.
      const to = await headingPoint(win, 'Overdue', false);
      await finger.glide(at, to);
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

  test('a hold opens the menu with the finger DOWN, and a release without moving leaves it open', async () => {
    const { win } = joplin;
    await settle();
    // Park the editor somewhere else, so "the note did not open" is observable.
    await parkEditor(win);
    const before = await todoDue(MENU);
    await armMessageLog(win);
    const panel = await agendaPanel(win);
    const finger = await newFinger(win);
    try {
      await finger.down(await rowPoint(win, MENU, 0.5));
      await win.waitForTimeout(700);
      // THE ORDER THIS WHOLE REDESIGN IS ABOUT: the menu is already up while the finger is still down, and
      // nothing has been lifted for it.
      await expect(panel.locator('#noteContextMenu'), 'the menu must be open before the finger comes up').toBeVisible();
      const held = await dragState();
      expect(held.dragging, 'and nothing may be lifted by the hold alone').toBe(0);
      expect(held.banner, 'nor any banner shown').toBe(null);
      await finger.up();
    } finally {
      await finger.dispose();
    }
    await expect(panel.locator('#noteContextMenu'), 'and it must survive the release').toBeVisible();
    expect((await dragState()).dragging, 'the release must leave nothing lifted behind it').toBe(0);
    const posted = await postedMessages(win);
    console.log('TOUCH MENU POSTED', JSON.stringify(posted));
    // A gesture that never lifted never takes the refresh guard - the host answers a release by repainting, and on
    // mobile that repaint is a webview reload which would destroy the menu the press just opened.
    expect(names(posted), 'a hold-and-release must not touch the refresh guard').not.toContain('dialogGuard');
    expect(names(posted), 'and must write nothing').not.toContain('todosDropped');
    expect(names(posted), 'and must write nothing').not.toContain('todosDroppedBetween');
    expect(names(posted), 'and the synthetic click must not open the note').not.toContain('todoClicked');
    // ...nor may that click land on the menu now sitting under the finger and run one of its items.
    expect(names(posted), 'and must not run a menu action').not.toContain('noteMenuAction');
    expect(await todoDue(MENU), 'the due date is untouched').toBe(before);
    await expect
      .poll(async () => win.locator('input.title-input').inputValue(), { timeout: 30_000 })
      .toContain(PARK);
    await panel.locator('body').press('Escape');
    await expect(panel.locator('#noteContextMenu')).toHaveCount(0);
  });

  test("a contextmenu on a mobile row opens nothing - Android's long press cannot reach the inline handler", async () => {
    // THE SECOND PIXEL ROUND'S BUG, at its own event. Android's native long press fires a real `contextmenu` on
    // whatever is under the finger, and every to-do row carries an inline oncontextmenu="onTodoContextMenu(...)"
    // (src/core/formats.ts) - so the platform could open the panel's context menu without the long-press adapter
    // knowing anything about it, at a moment the device's "Touch & hold delay" decides rather than the panel.
    // On mobile the panel now refuses the event outright, for every target, in the capture phase at the document.
    // The event is synthetic here on purpose: what is under test is the EVENT PATH (is it cancelled, does the
    // inline handler run), which a dispatched MouseEvent exercises exactly - the gesture that produces it on the
    // device is Android's, and no harness of ours can make Chromium under Xvfb emit it.
    const { win } = joplin;
    await settle();
    expect(await forceMobilePanel(win), 'the panel must be in mobile mode').toBe(true);
    const panel = await agendaPanel(win);
    await waitForPanelTodo(win, CTX);
    const seen = await panel.evaluate((m) => {
      const rows = Array.from(document.querySelectorAll('.todo[data-todo-id]')) as HTMLElement[];
      const row = rows.find((r) => (r.textContent || '').includes(m));
      if (!row) return null;
      const event = new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true });
      const notCancelled = row.dispatchEvent(event);
      // ...and the ONE exemption, on the same event: a real editable field. Android raises the text-selection
      // handles and the Paste / Select-all bar through `contextmenu`, and in the search box on a phone that bar
      // is the only way to paste - so the panel-wide refusal must stop at the field's edge.
      const field = document.getElementById('searchFilter');
      let fieldPrevented: boolean | null = null;
      if (field) {
        const fieldEvent = new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true });
        const fieldNotCancelled = field.dispatchEvent(fieldEvent);
        fieldPrevented = !fieldNotCancelled || fieldEvent.defaultPrevented;
      }
      // ...and the edge BETWEEN those two, which is where the exemption was wrong once: the row's tick circle is
      // an <input>, so an exemption written about the tag rather than about text let this event through - and it
      // bubbles to the row's own inline handler, whose FIRST branch is the circle (openAlarmOverlay). The target
      // here is a CHILD of the handler-carrying element, which the two dispatches above never are.
      const box = row.querySelector('input.todo-checkbox') as HTMLElement | null;
      let boxPrevented: boolean | null = null;
      if (box) {
        const boxEvent = new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true });
        const boxNotCancelled = box.dispatchEvent(boxEvent);
        boxPrevented = !boxNotCancelled || boxEvent.defaultPrevented;
      }
      return {
        // The hazard, asserted rather than assumed: the row really does carry the handler that would have opened
        // the menu. The day the markup stops emitting it, this case is testing nothing and should say so.
        inline: row.getAttribute('oncontextmenu') || '',
        prevented: !notCancelled || event.defaultPrevented,
        menus: document.querySelectorAll('#noteContextMenu').length,
        hasField: !!field,
        fieldPrevented,
        hasBox: !!box,
        boxPrevented,
        // The circle's branch opens the alarm overlay on mobile, so the overlay is what says whether the inline
        // handler ran - the context-menu count above cannot see this path at all.
        overlays: document.querySelectorAll('#cockpitOverlay').length,
      };
    }, CTX);
    console.log('TOUCH CTXMENU', JSON.stringify(seen));
    expect(seen, `no row on screen for ${CTX}`).not.toBe(null);
    expect(seen!.inline, 'the row must still carry the inline handler this suppression exists for').toContain(
      'onTodoContextMenu'
    );
    expect(seen!.prevented, 'a contextmenu on a mobile row must be cancelled - the native callout goes with it').toBe(
      true
    );
    expect(seen!.menus, 'and the inline handler must never run: the adapter alone opens the menu').toBe(0);
    expect(seen!.hasField, 'the panel must have its search box - the exemption is about real editable fields').toBe(true);
    expect(
      seen!.fieldPrevented,
      'a contextmenu in a text field must NOT be cancelled: the selection handles and the Paste / Select-all bar ride on it, and nothing in the field opens a menu of ours'
    ).toBe(false);
    expect(seen!.hasBox, 'the row must still have its tick circle - the <input> the exemption must not reach').toBe(true);
    expect(
      seen!.boxPrevented,
      "a contextmenu on the row's tick circle must be cancelled like the rest of the row: it is an <input> that takes no text, and it sits inside the element carrying the inline handler"
    ).toBe(true);
    expect(
      seen!.overlays,
      "and the circle's branch must never run: an unsuppressed contextmenu there re-enters openAlarmOverlay behind the adapter's back"
    ).toBe(0);
    // ...and the same row still opens its menu the way it is supposed to, on a real hold: the suppression removes
    // the platform's route in without touching the panel's own.
    const finger = await newFinger(win);
    try {
      await finger.down(await rowPoint(win, CTX, 0.5));
      await win.waitForTimeout(700);
      await expect(panel.locator('#noteContextMenu'), 'the long-press adapter must still open it').toBeVisible();
      await finger.up();
    } finally {
      await finger.dispose();
    }
    await panel.locator('body').press('Escape');
    await expect(panel.locator('#noteContextMenu')).toHaveCount(0);
  });

  test('a contextmenu DURING a lifted drag opens nothing, and the release still lands the to-do in the gap', async () => {
    // The shape the owner actually saw on the Pixel: the hold opened the menu, the vertical move lifted the row,
    // and then Android's own long press fired its `contextmenu` LATE - after `liftTouchDrag` had closed the menu -
    // which re-opened it over the lifted row and swallowed the release that should have reached a gap ("the menu
    // does not close, and the row is not moved"). Both halves are asserted here: the event opens nothing, and the
    // drop that follows it writes what it was aimed at.
    const { win } = joplin;
    await settle();
    await armMessageLog(win);
    const panel = await agendaPanel(win);
    const finger = await newFinger(win);
    try {
      const from = await rowPoint(win, CTX_DRAG, 0.5);
      await finger.down(from);
      await win.waitForTimeout(700);
      await expect(panel.locator('#noteContextMenu'), 'the hold opens the menu').toBeVisible();
      const at = await liftByMovingUpOrDown(finger, from, win);
      expect((await dragState()).dragging, 'the vertical move must lift the row').toBe(1);
      await expect(panel.locator('#noteContextMenu'), 'and close the menu').toHaveCount(0);
      // Now the late native event, on the lifted row, mid-gesture. TWO routes are tried, because the fix has two
      // layers: the event itself (stopped dead in the capture phase, so no inline handler runs) and the opener
      // (`showNoteContextMenu` refuses any caller while a touch gesture owns the finger). The second is reached
      // by calling the row's own handler directly, which is what an inline handler that somehow survived would do.
      const during = await panel.evaluate((m) => {
        const w = window as any;
        const rows = Array.from(document.querySelectorAll('.todo[data-todo-id]')) as HTMLElement[];
        const row = rows.find((r) => (r.textContent || '').includes(m));
        if (!row) return null;
        const event = new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true });
        const notCancelled = row.dispatchEvent(event);
        const afterEvent = document.querySelectorAll('#noteContextMenu').length;
        // The belt to those braces: the handler called outright, with the minimal event shape it reads.
        w.onTodoContextMenu(
          {
            target: row,
            currentTarget: row,
            clientX: 10,
            clientY: 10,
            preventDefault: () => undefined,
            stopPropagation: () => undefined,
          },
          row.dataset.todoId
        );
        return {
          prevented: !notCancelled || event.defaultPrevented,
          afterEvent,
          afterHandler: document.querySelectorAll('#noteContextMenu').length,
          stillLifted: document.querySelectorAll('.todo.-dragging').length,
        };
      }, CTX_DRAG);
      console.log('TOUCH CTXMENU MID-DRAG', JSON.stringify(during));
      expect(during, `no row on screen for ${CTX_DRAG}`).not.toBe(null);
      expect(during!.prevented, 'a contextmenu during the drag must be cancelled like any other').toBe(true);
      expect(during!.afterEvent, 'and must open no menu over the lifted row').toBe(0);
      expect(during!.afterHandler, 'nor may the handler itself, called outright while the gesture owns the finger').toBe(0);
      expect(during!.stillLifted, 'and none of it may end the drag').toBe(1);
      // ...and the release still does its job: into the BOTTOM half of the 08:00 anchor, the gap under it.
      const to = await rowPoint(win, LO, 0.8);
      await finger.glide(at, to);
      const aiming = await dragState();
      console.log('TOUCH CTXMENU AIMING', JSON.stringify(aiming));
      expect(aiming.before + aiming.after, 'exactly one insertion line must still be painted').toBe(1);
      await finger.up();
    } finally {
      await finger.dispose();
    }

    const posted = await postedMessages(win);
    console.log('TOUCH CTXMENU POSTED', JSON.stringify(posted));
    expect(names(posted), 'the drop must still post the between-drop message').toContain('todosDroppedBetween');
    expect(names(posted), 'and no menu action may have run behind the drag').not.toContain('noteMenuAction');
    const between = posted.find((m) => m[0] === 'todosDroppedBetween')!;
    expect(between[1], 'the payload is the dragged to-do').toEqual([ids[CTX_DRAG]]);
    const guards = posted.filter((m) => m[0] === 'dialogGuard');
    expect(guards.map((m) => m[1]), 'the refresh guard must be taken once and released once').toEqual([true, false]);
    // Read back from Joplin's own record: strictly after the 08:00 anchor and before the 12:00 one, which is the
    // gap it was aimed at whatever else has since been dropped into it.
    const due = await dueSettles(CTX_DRAG, (d) => d > todayAt(8) && d < todayAt(12));
    console.log('TOUCH CTXMENU DUE', new Date(due).toString());
    expect(due, 'strictly after the 08:00 neighbour').toBeGreaterThan(todayAt(8));
    expect(due, 'strictly before the 12:00 neighbour').toBeLessThan(todayAt(12));
    await expect
      .poll(async () => groupOf(CTX_DRAG), { timeout: PANEL_REFRESH_TIMEOUT, intervals: [1500, 2500] })
      .toBe('Today');
  });

  test('a hold then a SIDEWAYS first move lifts nothing, writes nothing and never takes the guard', async () => {
    // The other half of the first-move rule, and the reason the whole gesture was redesigned: on the Pixel a
    // sideways stroke from a held row is Joplin's own side-menu swipe. The panel must refuse it completely -
    // no lift, no paint, no message, and above all no refresh guard, since a guard taken here and released on
    // the swipe would have the host repaint the panel out from under the menu the press just opened.
    const { win } = joplin;
    await settle();
    const before = await todoDue(SWIPE);
    await waitForPanelTodo(win, SWIPE);
    await armMessageLog(win);
    const panel = await agendaPanel(win);
    const finger = await newFinger(win);
    try {
      // Both points are on the SAME row at the same y, so the stroke is exactly horizontal: dy is 0 and every
      // step of it is unambiguously sideways, which is the input the rule is written for. The press must land on
      // the row BODY: `.todo` is a flex row whose last child is the notebook pill, `flex-shrink: 0; max-width:
      // 38%`, rendered for every to-do that has a notebook - so the right ~38% of the row is the pill, which
      // `canLiftRow` refuses and whose own long press opens the notebook overlay instead of the menu. A press
      // there would arm nothing and the case would pass or fail on something that is not the first-move rule.
      // Mid-row is clear of both the pill and the tick circle; the ~35% of the row width to x=0.15 is still an
      // order of magnitude past the 10px slop.
      const from = await rowPoint(win, SWIPE, 0.5, 0.5);
      const to = await rowPoint(win, SWIPE, 0.5, 0.15);
      await finger.down(from);
      await win.waitForTimeout(700);
      await expect(panel.locator('#noteContextMenu'), 'the hold still opens the menu').toBeVisible();
      await finger.glide(from, to, 6, 40);
      const swiping = await dragState();
      console.log('TOUCH SWIPE STATE', JSON.stringify(swiping));
      expect(swiping.dragging, 'a sideways first move must never lift the row').toBe(0);
      expect(swiping.banner, 'and must show no banner').toBe(null);
      expect(swiping.before + swiping.after + swiping.over, 'and must paint no target').toBe(0);
      await finger.up();
    } finally {
      await finger.dispose();
    }
    // The menu is the press's, not the drag's: a refused swipe leaves it exactly as it was.
    await expect(panel.locator('#noteContextMenu'), 'the menu must still be open after the swipe').toBeVisible();
    const posted = await postedMessages(win);
    console.log('TOUCH SWIPE POSTED', JSON.stringify(posted));
    for (const forbidden of ['dialogGuard', 'todosDropped', 'todosDroppedBetween', 'noteMenuAction', 'todoClicked']) {
      expect(names(posted), `a refused swipe must not post ${forbidden}`).not.toContain(forbidden);
    }
    expect(await todoDue(SWIPE), 'and the due date is untouched').toBe(before);
    await panel.locator('body').press('Escape');
    await expect(panel.locator('#noteContextMenu')).toHaveCount(0);
    // The proof that the guard was never taken is not the empty log alone: a panel holding a stray
    // ['dialogGuard', true] would stop refreshing, so a note created afterwards must still reach it.
    const folderId = await folderIdByTitle(book);
    const later = `td-after-swipe-${stamp}`;
    // This dateless to-do stays in the book for the rest of the file, one more row in the No-Due group, and every
    // later case's rows sit one row lower for it. Nothing here reads a row by position - `rowPoint` finds rows by
    // their marker text and `assertOnScreen` refuses a point the list has pushed out of view - so the shift is
    // absorbed rather than merely tolerated. Same shape as `td-after-cancel-*` in the header-cancel case.
    await createTodoViaApi(later, folderId);
    await waitForPanelTodo(win, later);
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
    // Off the tapped to-do first, or "the tap opened it" is true of an editor that never moved.
    await parkEditor(win);
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
      const ring = await checkboxPoint(win, ALARM);
      await finger.down(ring);
      await win.waitForTimeout(700);
      // The ring is NOT a drag zone: the hold reaches the date picker and arms nothing behind it, so the move
      // that would lift an ordinary row lifts nothing here either. By now the picker overlay is open UNDER the
      // finger, which is precisely why the step is the unbounded one: there is no drop to aim at afterwards, and
      // the list's own metrics have nothing to say about a move whose whole assertion is that nothing happened.
      expect((await dragState()).dragging, 'a hold on the ring must not lift the row').toBe(0);
      await liftByMovingUpOrDown(finger, ring, win, false);
      expect((await dragState()).dragging, 'and a vertical move from the ring must still lift nothing').toBe(0);
      await finger.up();
    } finally {
      await finger.dispose();
    }
    await expect(panel.locator('#cockpitOverlay')).toBeVisible();
    // Dismissed with a FINGER, and it has to be. The hold above fired, so `longPress.fired` is set; the move that
    // followed it carried the touch past Chromium's tap slop, so the release synthesised NO click, and nothing
    // consumed the flag. On a phone that is harmless and invisible: the next input is another touch, and the
    // adapter's pointerdown clears the flag before any zone check (panelWebview.js, `longPress.fired = false`
    // ahead of the `#cockpitOverlay` early return), so the tap's own click sails through the swallower. Playwright's
    // `.click()` is a MOUSE click, which that pointerdown returns on before it can reset anything - so the stale
    // flag survives to the click and the swallower eats the Cancel press. That mixture, a mouse click landing in
    // the panel after a touch gesture, is a desktop-host artefact this file otherwise never produces; the fix is to
    // stop producing it here rather than to weaken the flag the menu-first gesture depends on (a release without
    // travel MUST still reach its click with `fired` set, or the menu 18a is about would close under the finger).
    await tapAt(win, await overlayButtonPoint(win, 'Cancel'));
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
      expect((await dragState()).dragging, 'the hold alone must not lift the row').toBe(0);
      const at = await liftByMovingUpOrDown(finger, from, win);
      expect((await dragState()).dragging, 'the vertical move must lift it').toBe(1);
      // Out of the list altogether, onto the panel's own controls: nothing there is a drop target.
      const origin = await panelOrigin(win);
      await finger.glide(at, { x: at.x, y: origin.y + 12 }, 10, 40);
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
    // Opening the menu and choosing from it is a POLL, not one pass. The panel repaints itself on every refresh
    // and a repaint landing between the two closes the menu with nothing chosen - which is how this case failed
    // its first attempt in the review round, on a `#notebookMenu` that was hidden again by the time it was read.
    // The loop's exit condition is the filter the panel actually holds (its own `-current` item), so a lost click
    // is simply retried rather than being discovered later as a peek that never appeared.
    await expect
      .poll(
        async () => {
          const current = panel.locator('#notebookMenu .dropdown-item.-current .dropdown-label');
          const nowOn = async () =>
            (await current.count()) ? ((await current.first().textContent()) || '').trim() : '';
          if ((await nowOn()) === book) return book;
          // Both clicks are attempted with a short timeout and swallowed: the failure mode being defended against
          // IS a repaint pulling the element out from under the click, and a raised error would end the poll on
          // the very race it exists to ride out. The next turn simply starts again from whatever is on screen.
          try {
            if (!(await panel.locator('#notebookMenu').isVisible())) {
              await panel.locator('.dropdown-toggle[onclick*="notebookMenu"]').click({ timeout: 5_000 });
              await win.waitForTimeout(400);
            }
            await panel
              .locator('#notebookMenu .dropdown-item', { hasText: book })
              .locator('.dropdown-label')
              .first()
              .click({ timeout: 5_000 });
            await win.waitForTimeout(1000);
          } catch {
            /* a repaint took the menu away mid-click; try again from the top */
          }
          return nowOn();
        },
        { timeout: PANEL_REFRESH_TIMEOUT, intervals: [800, 1500, 2500] }
      )
      .toBe(book);
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
      const from = await rowPoint(win, PEEK, 0.5);
      await finger.down(from);
      await win.waitForTimeout(700);
      expect((await dragState()).dragging, 'a peek row must never be lifted - it is not a reschedule source').toBe(0);
      // Its long press keeps doing what it always did: the single-note menu for the peeked note. Asserted HERE,
      // before the step, and not after it: the step is an unbounded 24px pan that the armed state deliberately
      // does not preventDefault, so if this search render's list overflows at all the pan scrolls it, and any
      // scroll runs `hideNoteContextMenu` (the document-level capture listener in panelWebview.js). The menu would
      // then be gone for a reason this case is not about.
      await expect(panel.locator('#noteContextMenu')).toBeVisible();
      // ...and it arms nothing either, so even the move that WOULD lift an ordinary row does nothing here. The
      // unbounded step again: nothing is aimed at afterwards, and the list under this case is a search render.
      await liftByMovingUpOrDown(finger, from, win, false);
      expect((await dragState()).dragging, 'and a vertical move from a peek row must still lift nothing').toBe(0);
      await finger.up();
    } finally {
      await finger.dispose();
    }
    expect((await dragState()).dragging, 'and the release leaves nothing lifted behind it either').toBe(0);
    const posted = await postedMessages(win);
    expect(names(posted), 'and no drag machinery runs for it').not.toContain('dialogGuard');
    await panel.locator('body').press('Escape');
  });

  /**
   * One drag, start to finish, in the menu-first order: hold a row until the 500 ms fire opens its context menu
   * (nothing is lifted by that alone any more), make ONE vertical step to lift it - which closes the menu - then
   * glide onto whatever `target()` resolves to at that moment (a heading's centre, a point in a row's top or
   * bottom half) and release there. The target is resolved AFTER the lift on purpose - a panel that re-rendered
   * between the two would otherwise be aimed at with stale coordinates.
   */
  async function dragRowTo(marker: string, target: () => Promise<Point>): Promise<void> {
    const { win } = joplin;
    await waitForPanelTodo(win, marker);
    const panel = await agendaPanel(win);
    const finger = await newFinger(win);
    try {
      const from = await rowPoint(win, marker, 0.5);
      await finger.down(from);
      await win.waitForTimeout(700);
      // The hold is the MENU, with the finger still down. The drag is armed behind it and invisible.
      expect((await dragState()).dragging, `${marker} must NOT be lifted by the hold alone`).toBe(0);
      await expect(panel.locator('#noteContextMenu'), 'the hold must open the context menu').toBeVisible();
      const lifted = await liftByMovingUpOrDown(finger, from, win);
      expect((await dragState()).dragging, `${marker} must be lifted by the vertical move`).toBe(1);
      await expect(panel.locator('#noteContextMenu'), 'and the lift must close the menu').toHaveCount(0);
      const to = await target();
      await finger.glide(lifted, to);
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
