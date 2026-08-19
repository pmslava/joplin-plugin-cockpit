import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  agendaPanel,
  createNote,
  createNotebook,
  createTodo,
  refreshPanel,
  selectNote,
  setAlarm,
  waitForPanelTodo,
  PANEL_IFRAME,
  PANEL_REFRESH_TIMEOUT,
} from './helpers';

/**
 * Regression cover for the "selection stops at the Cockpit panel edge" bug.
 *
 * The bug: while drag-selecting text in Joplin's markdown editor (CodeMirror) with the mouse, when the
 * pointer - still holding the primary button - crosses out of the editor and INTO the Cockpit panel's
 * iframe, the selection freezes at the panel boundary instead of continuing to extend. The panel is a
 * separate same-origin iframe that swallows the drag's pointer events, so the editor (whose CodeMirror
 * selection is driven by MAIN-window document listeners) stops receiving them.
 *
 * The fix (panelWebview.js): for a primary-button MOUSE drag that did NOT begin inside the panel, the
 * webview sets its OWN iframe element to pointer-events:none, so the drag falls back through to the main
 * document and the selection keeps extending; it restores the iframe the instant the drag ends. These
 * tests prove, in the real Joplin GUI: (a) the selection keeps extending into the panel area, (b) after
 * the drag's mouseup the panel is interactive again (a row click opens the note), and (c) an internal
 * panel drag is unaffected (the passthrough never engages; a native row->heading drag still reschedules).
 */
test.describe('Selection crossing into the Cockpit panel', () => {
  let joplin: JoplinInstance;
  const notebook = `Cockpit Sel ${Date.now()}`;
  // A note whose body is several long lines, so there is plenty of text to select across and past.
  const bodyLines = Array.from({ length: 14 }, (_, i) =>
    `Line ${String(i).padStart(2, '0')} ${'wwwwwwww'.repeat(6)} end${i}`
  );
  const noteMarker = `SelXing${Date.now()}`;
  const noteTitle = `${noteMarker} note`;
  const overdueTitle = `Overdue drag ${Date.now()}`;
  const todayTitle = `Today drag ${Date.now()}`;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    const { win } = joplin;
    await createNotebook(win, notebook);

    // Two dated to-dos in different groups (for the internal row->heading drag in test c).
    await createTodo(win, overdueTitle);
    await setAlarm(win, new Date(Date.now() - 26 * 3600 * 1000));
    await createTodo(win, todayTitle);
    await setAlarm(win, new Date(Date.now() + 2 * 3600 * 1000));

    // The long-body note is created last, so the editor starts on it for the selection test.
    await createNote(win, noteTitle);
    await win.locator('.cm-content').first().click();
    await win.waitForTimeout(400);
    // Lead with a newline: createNote leaves focus in the TITLE field, and if the editor click did not
    // move focus to the body the first Enter jumps focus there cleanly - so the body text can never leak
    // into the title (which would break the title assertion in the row-click test).
    await win.keyboard.type('\n' + bodyLines.join('\n'));
    await win.waitForTimeout(800);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  /** Read the main-window selection's length + short head/tail excerpt. */
  const readSelLen = (win: JoplinInstance['win']) =>
    win.evaluate(() => (window.getSelection()?.toString() || '').length);

  /** The inline pointer-events value on the panel iframe element, as set by the plugin. */
  const iframePointerEvents = (win: JoplinInstance['win']) =>
    win.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return el ? el.style.pointerEvents : '(no iframe)';
    }, PANEL_IFRAME);

  /**
   * Put the editor on the long-body note at the top and return the drag geometry: an anchor at the start
   * of an on-screen CodeMirror line, the editor's right edge, a lower on-screen y, and the panel box.
   */
  async function dragGeometry(win: JoplinInstance['win']) {
    await selectNote(win, noteTitle);
    await win.locator('.cm-content').first().click();
    await win.keyboard.press('Control+Home');
    await win.waitForTimeout(300);
    const lineBoxes = await win.locator('.cm-line').evaluateAll((els) =>
      els.slice(0, 8).map((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })
    );
    const cmScrollBox = (await win.locator('.cm-scroller').first().boundingBox())!;
    const panelBox = (await win.locator(PANEL_IFRAME).first().boundingBox())!;
    const anchor = lineBoxes.find((b) => b.y > 4 && b.h > 4 && b.w > 0) || lineBoxes[0];
    return {
      startX: anchor.x + 2,
      startY: anchor.y + anchor.h / 2,
      editorRightEdge: cmScrollBox.x + cmScrollBox.width,
      lowY: Math.min(anchor.y + 150, cmScrollBox.y + cmScrollBox.height - 20),
      panelBox,
    };
  }

  test('the selection keeps extending after the drag crosses into the panel', async () => {
    const { win } = joplin;
    await agendaPanel(win);
    const g = await dragGeometry(win);
    const intoPanelX = g.panelBox.x + Math.min(g.panelBox.width / 2, 140);

    // The target point is genuinely over the Cockpit panel iframe (not some other UI region).
    const under = await win.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        return el ? { tag: el.tagName, id: el.id } : null;
      },
      { x: intoPanelX, y: g.lowY }
    );
    expect(under?.tag).toBe('IFRAME');
    expect(under?.id).toContain('cockpit');

    await win.mouse.move(g.startX, g.startY);
    await win.mouse.down();
    // Extend to the editor's right edge - anchored inside CodeMirror, this is a real, non-trivial selection.
    await win.mouse.move(g.editorRightEdge - 40, g.lowY, { steps: 8 });
    await win.mouse.move(g.editorRightEdge + 6, g.lowY, { steps: 3 });
    await win.waitForTimeout(120);
    const selAtEdge = await readSelLen(win);
    expect(selAtEdge).toBeGreaterThan(20); // sanity: the drag really anchored in the editor text

    // Cross INTO the panel and hold at the same y: the passthrough engages (iframe -> pointer-events:none).
    await win.mouse.move(intoPanelX, g.lowY, { steps: 6 });
    await win.waitForTimeout(120);
    expect(await iframePointerEvents(win)).toBe('none'); // the fix engaged for this foreign drag
    const selInPanelHigh = await readSelLen(win);

    // Now drag DOWN while inside the panel. With the fix the selection follows to the lower lines; the
    // bug froze it at the boundary. Assert it grew both past the boundary and as the pointer moved down.
    await win.mouse.move(intoPanelX, g.lowY + 220, { steps: 8 });
    await win.waitForTimeout(150);
    const selInPanelLow = await readSelLen(win);

    expect(selInPanelLow).toBeGreaterThan(selAtEdge + 20); // extended past the panel boundary
    expect(selInPanelLow).toBeGreaterThan(selInPanelHigh + 20); // kept extending as the pointer moved deeper

    await win.mouse.up();
    // ALWAYS-restore: the drag ended (over the panel), so the iframe is interactive again.
    await expect.poll(() => iframePointerEvents(win), { timeout: 5000 }).toBe('');
  });

  test('after the drag mouseup the panel is interactive again (a row click opens the note)', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    const g = await dragGeometry(win);
    const intoPanelX = g.panelBox.x + Math.min(g.panelBox.width / 2, 140);

    // Run a foreign selection drag that ends OVER the panel, so the passthrough engages then restores.
    await win.mouse.move(g.startX, g.startY);
    await win.mouse.down();
    await win.mouse.move(g.editorRightEdge - 20, g.lowY, { steps: 6 });
    await win.mouse.move(intoPanelX, g.lowY, { steps: 6 });
    await win.waitForTimeout(120);
    expect(await iframePointerEvents(win)).toBe('none'); // engaged
    await win.mouse.up();
    await expect.poll(() => iframePointerEvents(win), { timeout: 5000 }).toBe(''); // restored on mouseup

    // The long-body note surfaces as a `.todo[data-note-id]` row once Joplin's index catches up.
    const row = panel.locator('.todo[data-note-id]', { hasText: noteMarker }).first();
    await expect
      .poll(
        async () => {
          await refreshPanel(win);
          return row.count();
        },
        { timeout: PANEL_REFRESH_TIMEOUT, intervals: [1500, 2500, 4000] }
      )
      .toBeGreaterThan(0);

    // Move Joplin's selection off the target so the click has an observable effect, then click the row.
    await selectNote(win, overdueTitle);
    await row.locator('.todo-title').first().click();

    // The panel row click opened the note in Joplin's editor - proof the panel is live after the drag.
    await expect
      .poll(async () => win.locator('input.title-input').inputValue(), { timeout: 30_000 })
      .toBe(noteTitle);
  });

  test('an internal row->heading drag still reschedules the to-do', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    await waitForPanelTodo(win, overdueTitle);
    await waitForPanelTodo(win, todayTitle);

    const overdueHeadingGone = async () => {
      const headings = await panel.locator('.todos h2').allTextContents();
      return !headings.map((h) => h.trim()).includes('Overdue');
    };
    expect(await overdueHeadingGone()).toBe(false); // precondition: the overdue to-do sits under "Overdue"

    // Drive the panel's real drag-and-drop handlers deterministically: dispatch the HTML5 drag sequence
    // (dragstart on the row -> dragover/drop on a dated heading) with a shared DataTransfer, exactly the
    // events onTodoDragStart/onTodoDropped consume. Dropping the overdue row on the "Today"/"Tomorrow"
    // heading reschedules it to that day, so the "Overdue" group empties out.
    const dispatched = await panel.evaluate((overdue) => {
      const rows = Array.from(document.querySelectorAll('.todo[data-todo-id]')) as HTMLElement[];
      const row = rows.find((r) => (r.textContent || '').includes(overdue));
      const heading = (Array.from(document.querySelectorAll('.todos h2[data-drop]')) as HTMLElement[]).find(
        (h) => /Today|Tomorrow/.test(h.textContent || '')
      );
      if (!row || !heading) return { ok: false, rows: rows.length };
      const dt = new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
      heading.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      heading.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      row.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
      return { ok: true, drop: heading.getAttribute('data-drop') };
    }, overdueTitle);
    expect(dispatched.ok).toBe(true);

    await expect.poll(overdueHeadingGone, { timeout: PANEL_REFRESH_TIMEOUT }).toBe(true);
  });

  test('an internal press-drag inside the panel never engages the passthrough', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    // A press that BEGINS inside the panel, dragged within the panel with the button held, must NOT make
    // the iframe transparent - that "began inside" gate is what keeps every ordinary panel interaction
    // (clicks, an internal row selection drag, dragging a row out) working. Press on a to-do row (the
    // realistic internal-drag origin) and drag a short way within the panel; the passthrough stays off.
    const row = panel.locator('.todo[data-todo-id]', { hasText: todayTitle }).first();
    const rowBox = (await row.boundingBox())!;
    const cx = rowBox.x + rowBox.width / 2;
    const cy = rowBox.y + rowBox.height / 2;
    await win.mouse.move(cx, cy);
    await win.mouse.down();
    await win.mouse.move(cx - 20, cy + 12, { steps: 3 });
    await win.mouse.move(cx - 40, cy + 24, { steps: 3 });
    await win.waitForTimeout(120);
    expect(await iframePointerEvents(win)).toBe(''); // internal drag: the passthrough never engaged
    await win.mouse.up();
    await win.waitForTimeout(120);
    expect(await iframePointerEvents(win)).toBe('');
  });
});
