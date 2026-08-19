import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  agendaPanel,
  createNotebook,
  createTodo,
  refreshPanel,
  selectNote,
  setAlarm,
  waitForPanelTodo,
  PANEL_REFRESH_TIMEOUT,
} from './helpers';

/**
 * Regression cover for the "multi-drag moves only ONE to-do" bug (desktop, 1.9.x) AND for enabling the
 * between-rows drop inside the Overdue (dateless) group.
 *
 * The multi-drag bug: with several to-dos Ctrl-selected, pressing one selected row to start a drag fired a
 * PLAIN mousedown first (the browser always fires mousedown before dragstart). onTodoRowMouseDown's plain
 * branch collapsed the whole selection down to that one row, so by the time dragstart read selectedTodoIDs
 * only ONE id went into the drag payload and only one to-do moved. The fix preserves an already-multi
 * selection on a plain mousedown (the file-manager rule: a press that becomes a drag keeps the set; the
 * collapse-to-one happens on the CLICK that follows a press with no drag, which also opens the note).
 *
 * The Overdue between-drop: the between-rows gesture was gated on the group heading carrying a real
 * YYYY-MM-DD data-drop, which excluded Overdue/Future (dateless) groups. An INTERIOR between-drop needs no
 * group date (the neighbours' dues define the interval), so the gate is relaxed to any group whose rows
 * carry dues (Overdue qualifies; No-Due stays excluded), and betweenBounds derives an edge day from the
 * present neighbour when the group has no date.
 *
 * These specs drive the panel's REAL drag-and-drop handlers deterministically by dispatching the HTML5 drag
 * sequence a browser fires - INCLUDING the plain mousedown that precedes dragstart, which is what the bug
 * hinged on - exactly the events onTodoRowMouseDown/onTodoDragStart/onTodoDropped/onBetweenDrop consume.
 */
test.describe('Multi-drag and Overdue between-drop', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const notebook = `Cockpit MDrag ${stamp}`;

  // Markers (distinct substrings) for each fixture to-do.
  const BW_A = `md-between-A-${stamp}`;
  const BW_B = `md-between-B-${stamp}`;
  const TD_LO = `md-today-lo-${stamp}`;
  const TD_HI = `md-today-hi-${stamp}`;
  const HD_A = `md-head-A-${stamp}`;
  const HD_B = `md-head-B-${stamp}`;
  const SGL = `md-single-${stamp}`;
  const OV_1 = `md-ord-1-${stamp}`;
  const OV_2 = `md-ord-2-${stamp}`;
  const OV_3 = `md-ord-3-${stamp}`;

  const HOUR = 3600 * 1000;

  // A local Date today at HH:00 (any time today is the "Today" group: Overdue needs due < start-of-today).
  const todayAt = (hour: number, minute = 0) => {
    const d = new Date();
    d.setHours(hour, minute, 0, 0);
    return d;
  };
  // A local Date yesterday at HH:MM (always < start-of-today -> the Overdue group).
  const yesterdayAt = (hour: number, minute = 0) => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(hour, minute, 0, 0);
    return d;
  };

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    const { win } = joplin;
    await createNotebook(win, notebook);

    // Today anchors, a wide gap for the between-drop (08:00 .. 20:00). Any clock time today is "Today".
    await createTodo(win, TD_LO);
    await setAlarm(win, todayAt(8));
    await createTodo(win, TD_HI);
    await setAlarm(win, todayAt(20));

    // Two overdue to-dos to drop BETWEEN the Today anchors (multi between-drop across groups).
    await createTodo(win, BW_A);
    await setAlarm(win, new Date(Date.now() - 48 * HOUR));
    await createTodo(win, BW_B);
    await setAlarm(win, new Date(Date.now() - 47 * HOUR));

    // Two overdue to-dos for the multi-drag-to-heading test.
    await createTodo(win, HD_A);
    await setAlarm(win, new Date(Date.now() - 50 * HOUR));
    await createTodo(win, HD_B);
    await setAlarm(win, new Date(Date.now() - 30 * HOUR));

    // One overdue to-do for the single-drag control.
    await createTodo(win, SGL);
    await setAlarm(win, new Date(Date.now() - 40 * HOUR));

    // Three overdue to-dos, ordered by due, for the Overdue between-drop (drop OV_3 between OV_1 and OV_2).
    await createTodo(win, OV_1);
    await setAlarm(win, yesterdayAt(9));
    await createTodo(win, OV_2);
    await setAlarm(win, yesterdayAt(13));
    await createTodo(win, OV_3);
    await setAlarm(win, yesterdayAt(17));

    // Wait for the panel to list them before the tests start dragging.
    await waitForPanelTodo(win, TD_LO);
    await waitForPanelTodo(win, OV_3);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  /** The group heading (Overdue, Today, ...) a to-do row sits under, or null. */
  async function groupOf(win: JoplinInstance['win'], marker: string): Promise<string | null> {
    const panel = await agendaPanel(win);
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

  /** The order (as an array of the given markers) in which those rows currently appear in the panel. */
  async function orderOf(win: JoplinInstance['win'], markers: string[]): Promise<string[]> {
    const panel = await agendaPanel(win);
    return panel.evaluate((ms) => {
      const rows = Array.from(document.querySelectorAll('.todo[data-todo-id]')) as HTMLElement[];
      const out: string[] = [];
      for (const r of rows) {
        const hit = ms.find((m) => (r.textContent || '').includes(m));
        if (hit) out.push(hit);
      }
      return out;
    }, markers);
  }

  /** The HH:MM the row's title shows (minutes-of-day), or null. Today rows render "HH:MM - title". */
  async function timeOf(win: JoplinInstance['win'], marker: string): Promise<number | null> {
    const panel = await agendaPanel(win);
    return panel.evaluate((m) => {
      const rows = Array.from(document.querySelectorAll('.todo[data-todo-id]')) as HTMLElement[];
      const row = rows.find((r) => (r.textContent || '').includes(m));
      if (!row) return null;
      const a = row.querySelector('.todo-title');
      const txt = (a ? a.textContent : '') || '';
      const mm = txt.match(/(\d{1,2}):(\d{2})/);
      return mm ? parseInt(mm[1], 10) * 60 + parseInt(mm[2], 10) : null;
    }, marker);
  }

  test('multi-drag BETWEEN rows spreads the whole selection (both move, strictly increasing)', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);

    // Ctrl-select BW_A then BW_B, then perform the FAITHFUL drag from the origin (last selected): a plain
    // mousedown (as the browser fires before dragstart) then the drag sequence, dropped in the gap just
    // below the Today-low anchor (between 08:00 and 20:00).
    const diag = await panel.evaluate((mk) => {
      const rowByMarker = (m: string) =>
        (Array.from(document.querySelectorAll('.todo[data-todo-id]')) as HTMLElement[]).find(
          (r) => (r.textContent || '').includes(m)
        );
      const sel = () =>
        (window as any).selectedTodoIDs ? [...(window as any).selectedTodoIDs] : '(no global)';
      const a = rowByMarker(mk.a)!;
      const b = rowByMarker(mk.b)!;
      const anchor = rowByMarker(mk.lo)!;
      const out: any = { hasGlobal: !!(window as any).selectedTodoIDs };
      out.start = sel();
      a.dispatchEvent(new MouseEvent('mousedown', { button: 0, ctrlKey: true, bubbles: true }));
      out.afterCtrlA = sel();
      b.dispatchEvent(new MouseEvent('mousedown', { button: 0, ctrlKey: true, bubbles: true }));
      out.afterCtrlB = sel();
      // The plain mousedown the browser fires when a press becomes a drag (this is what used to collapse).
      b.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      out.afterPlainMousedown = sel();
      const dt = new DataTransfer();
      b.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
      out.dtPayload = dt.getData('text/plain');
      const rect = anchor.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height * 0.85; // bottom band -> insert AFTER the low anchor
      anchor.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
      anchor.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
      b.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
      return out;
    }, { a: BW_A, b: BW_B, lo: TD_LO });
    console.log('BETWEEN-MULTI DIAG', JSON.stringify(diag));

    // Both dragged to-dos must land in Today, strictly increasing, inside the (08:00, 20:00) gap.
    await expect
      .poll(async () => (await groupOf(win, BW_A)) === 'Today' && (await groupOf(win, BW_B)) === 'Today', {
        timeout: PANEL_REFRESH_TIMEOUT,
        intervals: [1500, 2500, 4000],
      })
      .toBe(true);
    const tA = await timeOf(win, BW_A);
    const tB = await timeOf(win, BW_B);
    expect(tA, 'BW_A must show a time in Today').not.toBeNull();
    expect(tB, 'BW_B must show a time in Today').not.toBeNull();
    expect(tA!).toBeGreaterThan(8 * 60);
    expect(tB!).toBeLessThan(20 * 60);
    expect(tA!).toBeLessThan(tB!); // dragged order preserved, strictly increasing
    // EQUAL DIVISION (1.9.2): the two dropped to-dos split the (08:00, 20:00) gap into three equal parts, so the
    // four points lo=08:00, tA, tB, hi=20:00 are evenly spaced (12h / 3 = 4h steps: expected 12:00 and 16:00).
    // Assert equal steps within a small minute-rounding tolerance rather than pinning exact clock values.
    const lo = 8 * 60, hi = 20 * 60;
    const step = (hi - lo) / 3; // 240 minutes
    const tol = 2; // minutes of rounding tolerance
    expect(Math.abs((tA! - lo) - step), 'gap lo->A is one equal step').toBeLessThanOrEqual(tol);
    expect(Math.abs((tB! - tA!) - step), 'gap A->B is one equal step').toBeLessThanOrEqual(tol);
    expect(Math.abs((hi - tB!) - step), 'gap B->hi is one equal step').toBeLessThanOrEqual(tol);
  });

  test('multi-drag to a heading moves the WHOLE selection (reproduction: both move, not one)', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);

    const diag = await panel.evaluate((mk) => {
      const rowByMarker = (m: string) =>
        (Array.from(document.querySelectorAll('.todo[data-todo-id]')) as HTMLElement[]).find(
          (r) => (r.textContent || '').includes(m)
        );
      const sel = () =>
        (window as any).selectedTodoIDs ? [...(window as any).selectedTodoIDs] : '(no global)';
      const a = rowByMarker(mk.a)!;
      const b = rowByMarker(mk.b)!;
      const heading = (Array.from(document.querySelectorAll('.todos h2[data-drop]')) as HTMLElement[]).find(
        (h) => /Today/.test(h.textContent || '')
      )!;
      const out: any = { hasGlobal: !!(window as any).selectedTodoIDs };
      out.start = sel();
      a.dispatchEvent(new MouseEvent('mousedown', { button: 0, ctrlKey: true, bubbles: true }));
      out.afterCtrlA = sel();
      b.dispatchEvent(new MouseEvent('mousedown', { button: 0, ctrlKey: true, bubbles: true }));
      out.afterCtrlB = sel();
      b.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true })); // faithful pre-drag mousedown
      out.afterPlainMousedown = sel();
      const dt = new DataTransfer();
      b.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
      out.dtPayload = dt.getData('text/plain');
      out.afterDragStart = sel();
      heading.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      heading.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      b.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
      out.drop = heading.getAttribute('data-drop');
      return out;
    }, { a: HD_A, b: HD_B });
    console.log('HEADING-MULTI DIAG', JSON.stringify(diag));

    // The reproduction: BOTH to-dos must leave Overdue for Today. Pre-fix, only the drag-origin moved.
    await expect
      .poll(
        async () => (await groupOf(win, HD_A)) === 'Today' && (await groupOf(win, HD_B)) === 'Today',
        { timeout: PANEL_REFRESH_TIMEOUT, intervals: [1500, 2500, 4000] }
      )
      .toBe(true);
  });

  test('single drag to a heading still moves exactly that one (unchanged)', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    expect(await groupOf(win, SGL)).toBe('Overdue'); // precondition

    await panel.evaluate((mk) => {
      const rowByMarker = (m: string) =>
        (Array.from(document.querySelectorAll('.todo[data-todo-id]')) as HTMLElement[]).find(
          (r) => (r.textContent || '').includes(m)
        );
      const s = rowByMarker(mk.s)!;
      const heading = (Array.from(document.querySelectorAll('.todos h2[data-drop]')) as HTMLElement[]).find(
        (h) => /Today/.test(h.textContent || '')
      )!;
      s.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      const dt = new DataTransfer();
      s.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
      heading.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      heading.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      s.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
    }, { s: SGL });

    await expect
      .poll(async () => groupOf(win, SGL), { timeout: PANEL_REFRESH_TIMEOUT, intervals: [1500, 2500, 4000] })
      .toBe('Today');
  });

  test('a plain click on a row still opens the note in the editor', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    // Move Joplin's editor off the target first, so the click has an observable effect.
    await selectNote(win, TD_HI);
    await panel.locator('.todo-title', { hasText: OV_1 }).first().click();
    await expect
      .poll(async () => win.locator('input.title-input').inputValue(), { timeout: 30_000 })
      .toContain(OV_1);
  });

  test('between-drop works INSIDE the Overdue group (dateless): the row lands between its neighbours', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    // Precondition: OV_1, OV_2, OV_3 all Overdue, in that order.
    expect(await groupOf(win, OV_1)).toBe('Overdue');
    expect(await groupOf(win, OV_2)).toBe('Overdue');
    expect(await groupOf(win, OV_3)).toBe('Overdue');
    expect(await orderOf(win, [OV_1, OV_2, OV_3])).toEqual([OV_1, OV_2, OV_3]);

    // Drag OV_3 into the gap ABOVE OV_2 (i.e. between OV_1 and OV_2). The Overdue heading carries no
    // data-drop date; the interior interval comes purely from the neighbours' (past) dues.
    const diag = await panel.evaluate((mk) => {
      const rowByMarker = (m: string) =>
        (Array.from(document.querySelectorAll('.todo[data-todo-id]')) as HTMLElement[]).find(
          (r) => (r.textContent || '').includes(m)
        );
      const drag = rowByMarker(mk.three)!;
      const target = rowByMarker(mk.two)!; // insert BEFORE OV_2 -> between OV_1 and OV_2
      drag.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      const dt = new DataTransfer();
      drag.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
      const rect = target.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height * 0.1; // top band -> insert BEFORE the target
      target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
      drag.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
      return { payload: dt.getData('text/plain') };
    }, { three: OV_3, two: OV_2 });
    console.log('OVERDUE-BETWEEN DIAG', JSON.stringify(diag));

    // OV_3 must now sort between OV_1 and OV_2 (its due landed strictly between their past dues), and it
    // must remain in the Overdue group.
    await expect
      .poll(async () => (await orderOf(win, [OV_1, OV_2, OV_3])).join(','), {
        timeout: PANEL_REFRESH_TIMEOUT,
        intervals: [1500, 2500, 4000],
      })
      .toBe([OV_1, OV_3, OV_2].join(','));
    expect(await groupOf(win, OV_3)).toBe('Overdue');
  });
});
