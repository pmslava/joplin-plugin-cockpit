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
 * per tick would put the round-trip latency into the very interval being measured, and the silent stretch that
 * the watchdog is measured against is a matter of a few hundred milliseconds.
 *
 * One case deliberately sends a SINGLE dragover and then goes quiet, because the cadence of a real drag is not
 * something this suite gets to choose: the HTML drag-and-drop model iterates every 350ms for a stationary
 * pointer, and holding the pointer still in the band is the entire gesture. A probe that keeps its own 50ms
 * stream running proves the loop scrolls; only the silent one proves it does not need to be fed.
 *
 * To have anything to scroll, the list must overflow: 90 undated to-dos are seeded through Joplin's own data API
 * (the GUI's "New to-do" costs seconds each, and 90 of them would not fit in a beforeAll), and the suite refuses to
 * start until the panel reports a scroll range wider than the longest coast any case below asks for.
 *
 * A small DATED group is seeded alongside them, which is what gives the last case something to arrive AT. The default
 * profile moves "No Due Date" to the END of the list, so the DATED group is the first one and its heading is what sits
 * above the fold: the scroll that reaches it runs UPWARDS. The direction is the fixture's, not the report's, and the
 * gesture is the same either way - a still pointer in a band, and a target the list carries to it.
 * That last case is the only one that finishes the gesture rather than stopping at the scrolling: it holds the pointer
 * in the top band until a DATED heading has arrived under it, releases there, and requires the to-do to actually be
 * rescheduled onto that day - read back from Joplin's own record of the note, and then seen in the panel under that
 * group's heading.
 *
 * Ownership - the thing that keeps a drag from another window from making the list run away under the cursor - is two
 * conditions, and there is a case for each: one with no drag of the panel's own in flight (rejected on the FLAG, which
 * returns before the types are ever read), and one where a drag of ours IS in flight and the dragover carries a foreign
 * DataTransfer instead (rejected on the ownership TYPE). Only the second reaches that branch, and it carries its own
 * control phase - the same band, the same instant, the drag's own payload - so its stillness cannot be a dead panel.
 *
 * What no spec here can prove is the document-level ACCEPTANCE that a release mid-scroll depends on: a dispatched
 * `drop` event fires whether or not any dragover called preventDefault(), so whether a real browser would have offered
 * the drop at all is invisible from here. That half rests on the source pin in test/run.js and on a manual in-app drag.
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

  // Enough undated rows that the list overflows any panel height this harness can produce, by more than the longest
  // coast any case asks for (see MIN_SCROLL_RANGE).
  const ROWS = 90;
  const marker = (i: number) => `as-row-${String(i).padStart(2, '0')}-${stamp}`;
  const FIRST = marker(0);
  const LAST = marker(ROWS - 1);

  // ...and a DATED group above them, all due on the SAME day, so exactly one dated heading exists and its data-drop is
  // unambiguous. Several rows rather than one, so the heading stays under a still pointer for a stretch of frames
  // while the list is still moving, instead of only once the list has come to rest at the top.
  const DATED_ROWS = 8;
  const datedMarker = (i: number) => `as-day-${String(i).padStart(2, '0')}-${stamp}`;
  const DUE_AT = tomorrowNoon();
  const DUE_DATE = isoDate(DUE_AT);

  // PANEL_DRAG_TYPE in src/ui/panel/panelWebview.js: the custom type the panel's own dragstart stamps on the drag,
  // and the thing the dragover handler reads back off dataTransfer.types to recognise a drag of its own.
  const PANEL_DRAG_TYPE = 'application/x-cockpit-todos';
  // A drag that does not move the list must not move it AT ALL; a few pixels of tolerance only absorbs the
  // sub-pixel scrollTop a fractional device pixel ratio can produce.
  const STILL_TOL = 4;
  // A scrolling phase runs for at least 400ms at 2..16 px/frame, so tens of pixels is a floor no real run can
  // miss while still being far above any incidental movement.
  const MOVED_MIN = 50;
  // The floor for the SILENT case. A watchdog at the old 150ms could contribute at most ~9 frames x ~15px = 135px
  // before killing the loop, so a run that coasts past this can only have come from a watchdog well above the
  // drag's own cadence - which is the property the still-pointer gesture depends on.
  const COASTED_MIN = 200;
  // The scroll range the fixture must have. The silent case claims the WATCHDOG ended its coast, which is only a
  // distinguishable claim while the list still has somewhere to go: 800ms of watchdog at 60fps x 16 px/frame is about
  // 770px, so the range has to sit comfortably past that or the bottom of the list could be the real explanation.
  const MIN_SCROLL_RANGE = 1200;
  // AUTOSCROLL_SPEED_MAX in src/ui/panel/panelWebview.js. The helper moves the container at most once per animation
  // frame, so a phase can never move further than the frames it was given x this - which is what keeps the speed
  // constants honest: a helper scrolling at 200 px/frame passes every direction-only assertion. Two frames of
  // slack absorb the counter and the loop being registered at different points in the same frame queue.
  const SPEED_MAX = 16;

  test.beforeAll(async () => {
    // Launch + API wait + ROWS + DATED_ROWS seeded to-dos + three panel waits + a metrics poll do not fit the shared
    // 240s budget on a slow machine, and a hook timeout hides which step actually went wrong.
    test.setTimeout(420_000);
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
    // The dated group, which the default profile sorts ABOVE the undated one ("No Due Date" is moved to the end).
    for (let i = 0; i < DATED_ROWS; i++) await createTodoViaApi(datedMarker(i), folderId, DUE_AT);
    await waitForPanelTodo(win, FIRST);
    await waitForPanelTodo(win, LAST);
    await waitForPanelTodo(win, datedMarker(0));
    // The precondition every measurement below rests on: the list really does overflow its container, by more than
    // the longest single coast any case asks for.
    await expect
      .poll(async () => (await listMetrics()).maxScroll, {
        timeout: PANEL_REFRESH_TIMEOUT,
        intervals: [1000, 2000, 4000],
      })
      .toBeGreaterThan(MIN_SCROLL_RANGE);
    const fixture = await listMetrics();
    console.log('AUTOSCROLL FIXTURE', JSON.stringify(fixture));
    // ...and it is tall enough that the two edge bands are nowhere near each other, so the MIDDLE case really is
    // sampling an inert point rather than the seam between them.
    expect(fixture.clientHeight, 'the list must be far taller than two edge bands').toBeGreaterThan(200);
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

  /** One to-do, straight into the notebook. `dueMs` (epoch ms) dates it; omitted leaves it undated. */
  async function createTodoViaApi(title: string, folderId: string, dueMs?: number): Promise<void> {
    const made = await apiRequest('POST', `/notes?token=${API_TOKEN}`, {
      title,
      is_todo: 1,
      parent_id: folderId,
      ...(dueMs === undefined ? {} : { todo_due: dueMs }),
    });
    if (made.status !== 200) throw new Error(`the data API refused a to-do: ${made.status} ${made.text}`);
  }

  /** What Joplin itself has stored as a to-do's due datetime (epoch ms; 0 when undated). */
  async function todoDueById(id: string): Promise<number> {
    const got = await apiRequest('GET', `/notes/${id}?token=${API_TOKEN}&fields=id,todo_due`);
    if (got.status !== 200) throw new Error(`the data API refused a note read: ${got.status} ${got.text}`);
    return Number(JSON.parse(got.text).todo_due || 0);
  }

  /** Tomorrow at noon, local time - squarely inside the panel's "Tomorrow" group whatever the hour of the run. */
  function tomorrowNoon(): number {
    const day = new Date();
    day.setDate(day.getDate() + 1);
    day.setHours(12, 0, 0, 0);
    return day.getTime();
  }

  /** A local calendar date spelled the way a heading's data-drop spells it: YYYY-MM-DD. */
  function isoDate(ms: number): string {
    const day = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
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

  /** One phase of a probe: where the pointer sits, for how long, how it is fed, and whether the drag ends first. */
  interface Phase {
    at: 'top' | 'middle' | 'bottom';
    ms: number;
    endDragFirst?: boolean;
    /** 'stream' (default) keeps dispatching dragover; 'once' sends one and goes quiet; 'none' sends nothing. */
    feed?: 'stream' | 'once' | 'none';
    /**
     * Which DataTransfer this phase's dragover events carry: the drag's OWN one (default), or a SECOND, foreign one
     * holding nothing but text/plain. The foreign form is how a drag from another window looks to a panel that
     * happens to have a drag of its own in flight, and it is the only way to reach the ownership-TYPE half of
     * isPanelDragEvent: with the flag down the function returns on the flag and never looks at the types at all.
     */
    dt?: 'own' | 'foreign';
  }

  interface Probe {
    dragStarted: boolean;
    clientHeight: number;
    maxScroll: number;
    settled: number;
    /** True when a background refresh replaced the .todos node mid-probe, which invalidates the numbers. */
    rerendered: boolean;
    /** `frames` is the animation frames the phase spanned - the ceiling on how far the loop could have moved. */
    phases: {
      at: string;
      dt: string;
      endedFirst: boolean;
      from: number;
      to: number;
      delta: number;
      frames: number;
    }[];
  }

  /**
   * Run one drag probe inside the panel. Every probe ends its own gesture, so no loop and no flag is left standing
   * for the next spec.
   *
   * Ownership is two conditions, and a probe can put either one of them in the dock:
   *   `drag: false`          omits the dragstart entirely - no drag of the panel's own is in flight, so the FLAG
   *                          rejects the events and the ownership type is never even read.
   *   a phase's `dt: 'foreign'`  keeps the panel's own drag in flight and hands that phase's dragover events a
   *                          second DataTransfer holding only text/plain - the flag is raised, so it is the TYPE
   *                          that has to do the rejecting. This is the only way to reach that branch.
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
      // A foreign drag is not an EMPTY drag: text dragged in from another window carries text/plain. With no
      // dragstart of ours this probe is rejected by the FLAG - isPanelDragEvent returns on `!panelDragActive` and
      // never reaches the types - so what the payload holds does not decide the outcome here; it is set so the
      // fixture is a realistic foreign drag rather than a bare event. The type half is reached by the phases that
      // ask for `dt: 'foreign'` below, which run while a drag of the panel's own IS in flight.
      if (!o.drag) dt.setData('text/plain', 'text dragged in from another window');
      // That second, foreign DataTransfer: text/plain and nothing else, so the panel's dragover handler finds the
      // flag raised and the ownership type absent - the branch no flag-down probe can exercise.
      const foreignDt = new DataTransfer();
      foreignDt.setData('text/plain', 'text dragged in from another window');
      const out: any = {
        dragStarted: false,
        clientHeight: todos.clientHeight,
        maxScroll: todos.scrollHeight - todos.clientHeight,
        phases: [],
      };

      // An animation-frame counter running alongside the probe. The helper moves the container at most once per
      // frame, so the frames a phase spanned are the ceiling on how far it could legitimately have travelled - a
      // bound that holds whatever frame rate this machine happens to manage.
      let frames = 0;
      let counting = true;
      const countFrame = () => {
        frames++;
        if (counting) requestAnimationFrame(countFrame);
      };
      requestAnimationFrame(countFrame);

      if (o.drag && row) {
        // The plain mousedown a browser always fires before dragstart (it is what selects the row).
        row.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
        row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
        // Both halves of what the panel's dragstart puts on the drag: the id payload a drop reads, and the ownership
        // type every handler gates on.
        out.dragStarted =
          (dt.getData('text/plain') || '').length > 0 &&
          Array.prototype.indexOf.call(dt.types, o.ownType) !== -1;
      }

      for (const phase of o.phases) {
        if (phase.endDragFirst) {
          (row || document.body).dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
        }
        const y = yFor(phase.at);
        const from = todos.scrollTop;
        const framesFrom = frames;
        const feed = phase.feed || 'stream';
        const phaseDt = phase.dt === 'foreign' ? foreignDt : dt;
        // Dispatched on whatever is genuinely under the point, so the handler resolves the same scroll container
        // from event.target that a real dragover would.
        const dragover = () => {
          const under = (document.elementFromPoint(x, y) as HTMLElement) || todos;
          under.dispatchEvent(
            new DragEvent('dragover', {
              dataTransfer: phaseDt,
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
            })
          );
        };
        const until = Date.now() + phase.ms;
        if (feed === 'stream') {
          while (Date.now() < until) {
            dragover();
            await sleep(50);
          }
        } else {
          if (feed === 'once') dragover();
          await sleep(phase.ms); // ...and then silence, which is what a pointer holding perfectly still produces
        }
        const to = todos.scrollTop;
        out.phases.push({
          at: phase.at,
          dt: phase.dt || 'own',
          endedFirst: !!phase.endDragFirst,
          from,
          to,
          delta: to - from,
          frames: frames - framesFrom,
        });
      }

      // Always end the gesture, then look once more: a loop that outlived it would still be moving the list.
      (row || document.body).dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
      await sleep(200);
      counting = false;
      out.settled = todos.scrollTop;
      out.rerendered = document.querySelector('.todos') !== todos;
      return out;
    }, { ...opts, marker: FIRST, ownType: PANEL_DRAG_TYPE });
  }

  /**
   * One probe run the panel did not invalidate under it, for the cases whose claim is a NEGATIVE (the list did not
   * move). Those cannot be wrapped in an `expect.poll`: polling a negative retries until a run happens to hold
   * still, which is the very failure they exist to catch. But a background refresh that replaces `.todos` mid-probe
   * leaves the numbers measured on a detached node, and reporting one of those is a failure with nothing behind it.
   * So the run is repeated up to `tries` times, discarding only the invalidated ones, and the FIRST valid run is
   * what gets asserted on - it is never chosen for what it measured. When every attempt is invalidated the last one
   * is returned with its `rerendered` still true, so the caller's own assertion says so out loud.
   */
  async function validProbe(
    opts: { drag: boolean; preScroll: 'top' | 'middle'; phases: Phase[] },
    tries = 3
  ): Promise<Probe> {
    let result = await probe(opts);
    for (let attempt = 1; attempt < tries && result.rerendered; attempt++) result = await probe(opts);
    return result;
  }

  /** What the arrival probe below reports back. */
  interface Arrival {
    dragStarted: boolean;
    draggedId: string;
    clientHeight: number;
    maxScroll: number;
    /** The one pointer position the whole gesture is held at - it is never moved again after the dragstart. */
    pointer: { x: number; y: number };
    /** The data-drop under that pointer when the drag began, and the one the release actually landed on. */
    startDrop: string | null;
    droppedOn: string | null;
    from: number;
    atDrop: number;
    travelled: number;
    arrived: boolean;
    rerendered: boolean;
  }

  /**
   * The whole gesture, end to end: grab a row at the BOTTOM of the list, park the pointer in the top band and never
   * move it again, and let the auto-scroll bring the dated heading up to it - then release there.
   *
   * The direction is upwards because the fixture puts it that way: the default profile moves "No Due Date" to the end
   * of the list, so the dated group is the FIRST one and the heading that has to be reached is above the fold. The
   * gesture is the same either way - a still pointer in a band, and a target that arrives under it.
   *
   * Headings are `position: sticky; top: 0` (panel.css), so the heading of the group being scrolled through is what
   * sits under a pointer in the top band; arrival is the moment the dated one takes that spot over from "No Due Date".
   */
  async function dropOntoDatedHeading(rowMarker: string): Promise<Arrival> {
    const panel = await agendaPanel(joplin.win);
    return panel.evaluate(
      async (o: any) => {
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const listEl = () => document.querySelector('.todos') as HTMLElement | null;
        const todos = listEl();
        if (!todos) throw new Error('the panel has no .todos container');
        const rows = Array.from(document.querySelectorAll('.todo[data-todo-id]')) as HTMLElement[];
        const row = rows.find((r) => (r.textContent || '').includes(o.marker));
        if (!row) throw new Error('no panel row carrying ' + o.marker);

        // Park the list at its very bottom, which is as far from the dated group as this fixture can put the pointer.
        todos.scrollTop = todos.scrollHeight;
        await sleep(150);

        const rect = todos.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + 6); // in the top band, and never moved again
        const dropUnderPointer = () => {
          const under = document.elementFromPoint(x, y) as HTMLElement | null;
          return under && under.closest ? (under.closest('[data-drop]') as HTMLElement | null) : null;
        };

        const dt = new DataTransfer();
        const out: any = {
          dragStarted: false,
          draggedId: row.dataset.todoId || '',
          clientHeight: todos.clientHeight,
          maxScroll: todos.scrollHeight - todos.clientHeight,
          pointer: { x, y },
          startDrop: null,
          droppedOn: null,
          from: todos.scrollTop,
          atDrop: todos.scrollTop,
          travelled: 0,
          arrived: false,
          rerendered: false,
        };

        row.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
        row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
        out.dragStarted =
          (dt.getData('text/plain') || '').length > 0 &&
          Array.prototype.indexOf.call(dt.types, o.ownType) !== -1;

        const startTarget = dropUnderPointer();
        out.startDrop = startTarget ? startTarget.getAttribute('data-drop') : null;

        // Feed the drag the way a browser does while the pointer holds perfectly still, and watch for the dated
        // heading to arrive under it.
        let target: HTMLElement | null = null;
        const until = Date.now() + o.ms;
        while (Date.now() < until) {
          const under = (document.elementFromPoint(x, y) as HTMLElement) || listEl() || todos;
          under.dispatchEvent(
            new DragEvent('dragover', {
              dataTransfer: dt,
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
            })
          );
          const now = dropUnderPointer();
          if (now && now.getAttribute('data-drop') === o.dueDate) {
            target = now;
            break;
          }
          await sleep(50);
        }

        // Read BEFORE the release: a re-render after the drop is the point of the drop, while one during the
        // journey is what would invalidate the numbers above.
        out.rerendered = listEl() !== todos;
        out.atDrop = todos.scrollTop;
        out.travelled = out.from - out.atDrop;
        out.arrived = !!target;
        if (target) {
          out.droppedOn = target.getAttribute('data-drop');
          // Released on whatever is genuinely under the still pointer, mid-scroll, exactly as a mouse-up would be.
          target.dispatchEvent(
            new DragEvent('drop', {
              dataTransfer: dt,
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
            })
          );
        }
        // Whatever happened, the gesture ends here: no loop and no flag is left standing. A row the drop's own
        // re-render has already detached cannot bubble a dragend to the document, so the body stands in for it.
        (row.isConnected ? row : document.body).dispatchEvent(
          new DragEvent('dragend', { dataTransfer: dt, bubbles: true })
        );
        await sleep(200);
        return out;
      },
      { marker: rowMarker, ownType: PANEL_DRAG_TYPE, dueDate: DUE_DATE, ms: 20_000 }
    );
  }

  /** The data-drop of the group heading a to-do row currently sits under, or null when it is not on the panel. */
  async function panelGroupOf(todoId: string): Promise<string | null> {
    const panel = await agendaPanel(joplin.win);
    return panel.evaluate((id: string) => {
      const row = document.querySelector('.todo[data-todo-id="' + id + '"]');
      if (!row) return null;
      let el = row.previousElementSibling;
      while (el) {
        if (el.tagName === 'H2') return el.getAttribute('data-drop');
        el = el.previousElementSibling;
      }
      return null;
    }, todoId);
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
          // A run whose .todos was replaced mid-probe measured a detached node: retry rather than report it.
          return last.rerendered ? 0 : last.phases[0].delta;
        },
        { timeout: 60_000, intervals: [500, 1000, 2000] }
      )
      .toBeGreaterThan(MOVED_MIN);
    console.log('BOTTOM-BAND DIAG', JSON.stringify(last));
    expect(last!.rerendered, 'the reported run must be one no background refresh invalidated').toBe(false);
    expect(last!.dragStarted, 'the dragstart must have produced a payload').toBe(true);
    // And the scrolling stopped with the gesture: nothing moved in the 200ms after dragend.
    expect(Math.abs(last!.settled - last!.phases[0].to)).toBeLessThanOrEqual(STILL_TOL);
    // ...and it never moved faster than the helper's own ceiling allows.
    expect(last!.phases[0].delta, 'the list must not outrun AUTOSCROLL_SPEED_MAX per frame').toBeLessThanOrEqual(
      (last!.phases[0].frames + 2) * SPEED_MAX + STILL_TOL
    );
  });

  test('a drag held in the MIDDLE of the list does not scroll it', async () => {
    // Never polled on the measurement: expect.poll would retry until a run happened to hold still, which is exactly
    // the failure this case exists to catch. A run the panel re-rendered under is discarded all the same - its
    // numbers came off a detached node - and the first valid run is the one asserted on, chosen before it is read.
    const result = await validProbe({ drag: true, preScroll: 'middle', phases: [{ at: 'middle', ms: 400 }] });
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
          return last.rerendered ? 0 : last.phases[0].delta;
        },
        { timeout: 60_000, intervals: [500, 1000, 2000] }
      )
      .toBeLessThan(-MOVED_MIN);
    console.log('TOP-BAND DIAG', JSON.stringify(last));
    expect(last!.rerendered, 'the reported run must be one no background refresh invalidated').toBe(false);
    expect(Math.abs(last!.settled - last!.phases[0].to)).toBeLessThanOrEqual(STILL_TOL);
    expect(
      Math.abs(last!.phases[0].delta),
      'the list must not outrun AUTOSCROLL_SPEED_MAX per frame'
    ).toBeLessThanOrEqual((last!.phases[0].frames + 2) * SPEED_MAX + STILL_TOL);
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
          return last.rerendered ? 0 : last.phases[0].delta;
        },
        { timeout: 60_000, intervals: [500, 1000, 2000] }
      )
      .toBeGreaterThan(MOVED_MIN);
    console.log('DRAGEND-STOP DIAG', JSON.stringify(last));
    expect(last!.rerendered, 'the reported run must be one no background refresh invalidated').toBe(false);
    expect(
      Math.abs(last!.phases[1].delta),
      'after dragend the list must stand still even with the pointer in the band'
    ).toBeLessThanOrEqual(STILL_TOL);
    expect(last!.phases[0].delta, 'the list must not outrun AUTOSCROLL_SPEED_MAX per frame').toBeLessThanOrEqual(
      (last!.phases[0].frames + 2) * SPEED_MAX + STILL_TOL
    );
  });

  test('one dragover keeps the list scrolling through a silence, and the watchdog then stops it', async () => {
    // The case the whole feature rests on. A pointer HOLDING STILL in the band is the gesture - and a still
    // pointer is exactly when the drag's events dry up: the HTML drag-and-drop model iterates every 350ms at
    // best, and an X11 drag follows pointer motion. So this probe sends ONE dragover and then goes completely
    // quiet for 1200ms. A loop that needs feeding could not coast past COASTED_MIN; the old 150ms watchdog had
    // ~135px in it. The second, equally silent phase then proves nothing runs on for ever: by then the watchdog
    // has ended it with no drop and no dragend anywhere in sight.
    let last: Probe | null = null;
    await expect
      .poll(
        async () => {
          last = await probe({
            drag: true,
            preScroll: 'top',
            phases: [
              { at: 'bottom', ms: 1200, feed: 'once' },
              { at: 'bottom', ms: 500, feed: 'none' },
            ],
          });
          return last.rerendered ? 0 : last.phases[0].delta;
        },
        { timeout: 60_000, intervals: [500, 1000, 2000] }
      )
      .toBeGreaterThan(COASTED_MIN);
    console.log('SILENT-COAST DIAG', JSON.stringify(last));
    expect(last!.rerendered, 'the reported run must be one no background refresh invalidated').toBe(false);
    expect(last!.dragStarted).toBe(true);
    expect(
      Math.abs(last!.phases[1].delta),
      'the loop must have ended itself during the silence, with no drop and no dragend'
    ).toBeLessThanOrEqual(STILL_TOL);
    // An unbounded coast would let a helper scrolling at 200 px/frame with no watchdog at all pass the floor above.
    expect(last!.phases[0].delta, 'the list must not outrun AUTOSCROLL_SPEED_MAX per frame').toBeLessThanOrEqual(
      (last!.phases[0].frames + 2) * SPEED_MAX + STILL_TOL
    );
    // ...and it was the WATCHDOG that ended the coast, not the bottom of the list. This is where MIN_SCROLL_RANGE is
    // cashed: the fixture guarantees more range than the watchdog's own window can ever spend.
    expect(last!.phases[0].to, 'the coast must have ended with list left to scroll').toBeLessThan(
      last!.maxScroll - 1
    );
  });

  test('a FOREIGN drag with no drag of ours in flight never scrolls the list', async () => {
    // Never polled on the measurement, for the same reason as the middle case: a retried negative proves nothing.
    //
    // What this case proves is the FLAG half of the gate: no dragstart of the panel's own has run, so
    // panelDragActive is false and isPanelDragEvent returns on that first line without ever reading the drag's
    // types. It cannot speak for the ownership TYPE - the case below is the one that reaches that branch.
    const result = await validProbe({
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

  test('a foreign drag is refused on the ownership TYPE while a drag of ours is in flight', async () => {
    // The branch the case above cannot reach. Ownership is two things - the in-flight flag AND the custom type the
    // panel's own dragstart stamps on the drag - and the flag exists precisely because it can go stale: a drag whose
    // source row a mid-drag re-render detached can end without a dragend reaching the document, leaving the flag
    // raised for whatever drag comes next. The type is what covers that, and it is only ever consulted with the flag
    // already up.
    //
    // So: a real dragstart from a row (the flag goes up), and then a dragover stream in the bottom band carrying a
    // SECOND DataTransfer that holds nothing but text/plain. The list must not move.
    //
    // The second phase is the control, at the same point in the same band with the drag's OWN payload: it proves the
    // drag really was live and the band really was live throughout, so the first phase's stillness can only be the
    // type check. It runs second on purpose - the foreign phase arms no loop, so there is no coast to carry into it,
    // whereas the reverse order would need the loop to be stopped in between.
    const result = await validProbe({
      drag: true,
      preScroll: 'middle',
      phases: [
        { at: 'bottom', ms: 500, dt: 'foreign' },
        { at: 'bottom', ms: 600 },
      ],
    });
    console.log('FOREIGN-TYPE DIAG', JSON.stringify(result));
    expect(result.rerendered, 'a background refresh mid-probe would invalidate the numbers').toBe(false);
    expect(result.dragStarted, 'a drag of ours must have been in flight, flag and all').toBe(true);
    expect(
      Math.abs(result.phases[0].delta),
      'a dragover without the ownership type must not scroll the list, even with our flag raised'
    ).toBeLessThanOrEqual(STILL_TOL);
    expect(
      result.phases[1].delta,
      'the same band with the drag OWN payload must scroll, or the phase above proved nothing'
    ).toBeGreaterThan(MOVED_MIN);
  });

  test('a to-do released after the auto-scroll is rescheduled onto the group that arrived', async () => {
    // The only case here that finishes the gesture instead of stopping at the scrolling, and so the only one that
    // speaks to the second half of the report: not "the list would not move" but "the to-do does not reach the date".
    // The pointer is placed once, in the top band, and never moved again; the auto-scroll brings a dated heading up
    // to it; the release happens there, mid-scroll. What must then be true is not a pixel count but a RESCHEDULE.
    //
    // Three attempts, each dragging a DIFFERENT undated row from the bottom, because a successful run dates the row
    // it dragged: a retry with the same one would no longer start where this case needs it to.
    test.setTimeout(180_000);
    let last: Arrival | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      last = await dropOntoDatedHeading(marker(ROWS - 1 - attempt));
      if (last.arrived && !last.rerendered) break;
    }
    console.log('ARRIVAL DIAG', JSON.stringify(last));
    expect(last!.rerendered, 'the reported run must be one no background refresh invalidated').toBe(false);
    expect(last!.dragStarted, 'the dragstart must have produced a payload and the ownership type').toBe(true);
    // The target really was out of reach when the gesture began, which is the owner's complaint in one assertion.
    expect(last!.startDrop, 'the dated heading must not already have been under the pointer').not.toBe(DUE_DATE);
    expect(last!.arrived, 'the dated heading must have arrived under a pointer that never moved').toBe(true);
    expect(last!.travelled, 'the list must have carried it a real distance to get there').toBeGreaterThan(MOVED_MIN);
    expect(last!.droppedOn, 'the release must have landed on the dated heading').toBe(DUE_DATE);
    // ...and the release DID something: Joplin's own record of the note now carries a due on that day.
    await expect
      .poll(async () => isoDate(await todoDueById(last!.draggedId)), {
        timeout: PANEL_REFRESH_TIMEOUT,
        intervals: [500, 1000, 2000],
      })
      .toBe(DUE_DATE);
    // ...and the panel has moved the row into that group, under the very heading it was dropped on.
    await expect
      .poll(() => panelGroupOf(last!.draggedId), {
        timeout: PANEL_REFRESH_TIMEOUT,
        intervals: [500, 1000, 2000],
      })
      .toBe(DUE_DATE);
  });
});
