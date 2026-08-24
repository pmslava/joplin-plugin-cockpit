import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  agendaPanel,
  createNote,
  createNotebook,
  createTodo,
  refreshPanel,
  selectedNoteId,
  setAlarm,
  PANEL_REFRESH_TIMEOUT,
} from './helpers';

/**
 * Real-app cover for the 2.1.0 headline: a REGULAR NOTE row takes part in the panel's multi-selection,
 * exactly like a to-do row, and a mixed to-do + note selection is ordinary.
 *
 * Up to 2.0.0 this was a gap, not a regression: from the very first selection commit (1.0.3) a press on a
 * note row CLEARED the selection and only lit the highlight-only `pickedNoteID`, so a note could never join
 * a batch. Three things are proved here, in the real GUI, because none of them is decidable from source:
 *
 *   1. a Ctrl-click on a note row ADDS it to a selection that already holds a to-do (and the row paints as
 *      selected, which is what the user actually sees);
 *   2. the context menu opened on that mixed selection is the BATCH menu, and running its delete removes
 *      BOTH kinds from real Joplin;
 *   3. the drag payload EXCLUDES the notes: a drop assigns a due date, which a regular note cannot carry,
 *      so a mixed selection dragged onto a date must move only its to-dos and leave the notes alone.
 */
test.describe('Mixed to-do + note selection (desktop)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const notebook = `Cockpit Mixed ${stamp}`;

  // Selection / batch-delete fixtures.
  const TODO_A = `mx-todo-A-${stamp}`;
  const NOTE_A = `mx-note-A-${stamp}`;
  // Drag-payload fixtures, kept separate so the delete above cannot race them.
  const TODO_B = `mx-todo-B-${stamp}`;
  const NOTE_B = `mx-note-B-${stamp}`;
  // NOTE_A's real Joplin id, so "the editor did not move onto it" is asserted against the app's own
  // selection rather than against a title string that may or may not have been readable.
  let noteAId = '';

  /** A local Date today at HH:00 - any clock time today lands the to-do in the "Today" group. */
  const todayAt = (hour: number) => {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    return d;
  };

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    const { win } = joplin;
    await createNotebook(win, notebook); // becomes the selected notebook: everything lands in it
    await createTodo(win, TODO_A);
    await setAlarm(win, todayAt(9));
    await createTodo(win, TODO_B);
    await setAlarm(win, todayAt(10));
    noteAId = await createNote(win, NOTE_A);
    await createNote(win, NOTE_B);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  /** Wait until every given marker has a row in the panel, prompting a refresh each tick. */
  async function waitForRows(markers: string[]): Promise<void> {
    const panel = await agendaPanel(joplin.win);
    await expect
      .poll(
        async () => {
          await refreshPanel(joplin.win);
          return panel.evaluate((ms) => {
            const rows = Array.from(
              document.querySelectorAll('.todo[data-todo-id], .todo[data-note-id]')
            ) as HTMLElement[];
            return ms.filter((m) => rows.some((r) => (r.textContent || '').includes(m))).length;
          }, markers);
        },
        { timeout: PANEL_REFRESH_TIMEOUT, intervals: [1500, 2500, 4000] }
      )
      .toBe(markers.length);
  }

  /** The markers currently in the panel's OWN selection (window.selectedRowIDs), sorted. */
  async function selectionMarkers(markers: string[]): Promise<string[]> {
    const panel = await agendaPanel(joplin.win);
    return panel.evaluate((ms) => {
      const ids: string[] = [...((window as any).selectedRowIDs || [])];
      const rows = Array.from(
        document.querySelectorAll('.todo[data-todo-id], .todo[data-note-id]')
      ) as HTMLElement[];
      return ids
        .map((id) => rows.find((r) => r.dataset.todoId === id || r.dataset.noteId === id))
        .map((row) => ms.find((m) => ((row && row.textContent) || '').includes(m)) || '?')
        .sort();
    }, markers);
  }

  test('a Ctrl-click on a NOTE row adds it to a to-do selection, and the row paints as selected', async () => {
    const { win } = joplin;
    await waitForRows([TODO_A, NOTE_A]);
    const panel = await agendaPanel(win);

    // REAL clicks: a plain click selects (and opens) the to-do, a Ctrl-click extends onto the note row.
    // Before 2.1.0 that second click emptied the selection instead of extending it.
    await panel.locator('.todo[data-todo-id]', { hasText: TODO_A }).first().locator('.todo-title').click();
    await panel
      .locator('.todo[data-note-id]', { hasText: NOTE_A })
      .first()
      .locator('.todo-title')
      .click({ modifiers: ['Control'] });

    await expect.poll(() => selectionMarkers([TODO_A, NOTE_A]), { timeout: 10_000 }).toEqual(
      [TODO_A, NOTE_A].sort()
    );
    // And what the user sees: BOTH rows carry the selection class.
    await expect(panel.locator('.todo[data-note-id]', { hasText: NOTE_A }).first()).toHaveClass(/-selected/);
    await expect(panel.locator('.todo[data-todo-id]', { hasText: TODO_A }).first()).toHaveClass(/-selected/);

    // The Ctrl-click must NOT have opened the note: a modifier click on a note row is selection only, the
    // same rule a to-do row has always followed. Asserted on Joplin's OWN selected-note id rather than on a
    // title string - a locator that silently fails would make a `not.toContain` assertion vacuous, whereas an
    // id that fails to read is caught by the non-empty check first.
    expect(noteAId, 'the fixture note id must have been captured, or the check below proves nothing').not.toBe('');
    const openedId = await selectedNoteId(win);
    expect(openedId, 'Joplin must report some selected note, or the check below proves nothing').not.toBe('');
    expect(openedId, 'a Ctrl-click on a note row must not move the editor onto it').not.toBe(noteAId);
  });

  test('the context menu on a mixed selection batches BOTH kinds, and the delete removes both', async () => {
    const { win } = joplin;
    await waitForRows([TODO_A, NOTE_A]);
    const panel = await agendaPanel(win);

    // Seed the selection with synthetic events, then open Cockpit's own menu on the NOTE row - the kind that
    // could not open a batch menu before 2.1.0.
    //
    // The seeding is a plain mousedown FOLLOWED BY A CLICK, and it has to be: a plain PRESS on a row that is
    // already inside a multi-selection deliberately PRESERVES the whole set (the file-manager rule, so a drag
    // can sweep it), so pressing alone would inherit whatever the previous test left selected - and the
    // Ctrl-press that follows would then REMOVE the note row instead of adding it. The click is the collapse
    // half of that same rule, and it is what makes this independent of the order the tests run in.
    const menu = await panel.evaluate((mk) => {
      const rowByMarker = (m: string) =>
        (Array.from(
          document.querySelectorAll('.todo[data-todo-id], .todo[data-note-id]')
        ) as HTMLElement[]).find((r) => (r.textContent || '').includes(m));
      const todo = rowByMarker(mk.todo)!;
      const note = rowByMarker(mk.note)!;
      todo.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      todo.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true })); // collapse onto this row
      note.dispatchEvent(new MouseEvent('mousedown', { button: 0, ctrlKey: true, bubbles: true }));
      note.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true }));
      const el = document.getElementById('noteContextMenu')!;
      const buttons = Array.from(el.querySelectorAll('.context-menu-item')) as HTMLElement[];
      return {
        selection: [...((window as any).selectedRowIDs || [])].length,
        labels: buttons.map((b) => (b.textContent || '').trim()),
        disabled: buttons.filter((b) => b.classList.contains('-disabled')).map((b) => b.dataset.action || ''),
      };
    }, { todo: TODO_A, note: NOTE_A });

    expect(menu.selection, 'the mixed selection must hold both rows').toBe(2);
    // The count-carrying labels are the batch menu; the single-only action still greys out.
    expect(menu.labels).toContain('Delete 2 notes');
    expect(menu.labels).toContain('Switch type of 2 items');
    expect(menu.disabled).toContain('open');

    // Run it: both the to-do and the plain note leave the panel (and Joplin's trash holds them).
    await panel.evaluate(() => {
      const el = document.getElementById('noteContextMenu')!;
      (el.querySelector('.context-menu-item[data-action="delete"]') as HTMLElement).click();
    });

    await expect
      .poll(
        async () => {
          await refreshPanel(win);
          return panel.evaluate((ms) => {
            const rows = Array.from(
              document.querySelectorAll('.todo[data-todo-id], .todo[data-note-id]')
            ) as HTMLElement[];
            return ms.filter((m) => rows.some((r) => (r.textContent || '').includes(m))).length;
          }, [TODO_A, NOTE_A]);
        },
        { timeout: PANEL_REFRESH_TIMEOUT, intervals: [1500, 2500, 4000] }
      )
      .toBe(0);
  });

  test('a drag started from a mixed selection carries only the TO-DOS in its payload', async () => {
    const { win } = joplin;
    await waitForRows([TODO_B, NOTE_B]);
    const panel = await agendaPanel(win);

    const diag = await panel.evaluate((mk) => {
      const rowByMarker = (m: string) =>
        (Array.from(
          document.querySelectorAll('.todo[data-todo-id], .todo[data-note-id]')
        ) as HTMLElement[]).find((r) => (r.textContent || '').includes(m));
      const todo = rowByMarker(mk.todo)!;
      const note = rowByMarker(mk.note)!;
      // Collapse onto the to-do row first (press + click - see the menu test for why the click is required),
      // build the mixed selection, then fire the plain mousedown the browser fires as a press becomes a drag
      // (which must PRESERVE the set), then the dragstart itself.
      todo.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      todo.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true }));
      note.dispatchEvent(new MouseEvent('mousedown', { button: 0, ctrlKey: true, bubbles: true }));
      todo.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      const selection = [...((window as any).selectedRowIDs || [])];
      const dt = new DataTransfer();
      todo.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
      return {
        selection,
        payload: (dt.getData('text/plain') || '').split(',').filter(Boolean),
        todoID: todo.dataset.todoId,
        noteID: note.dataset.noteId,
      };
    }, { todo: TODO_B, note: NOTE_B });

    // The selection really is mixed (otherwise the exclusion below would be vacuous)...
    expect(diag.selection).toContain(diag.todoID);
    expect(diag.selection).toContain(diag.noteID);
    // ...and the payload is the to-dos alone. A note carries no due date, so a drop must never write one.
    expect(diag.payload).toEqual([diag.todoID]);
  });
});
