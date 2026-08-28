import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  agendaPanel,
  createNotebook,
  createTodo,
  setAlarm,
  waitForPanelTodo,
  readClipboard,
  writeClipboard,
  panelToastVisible,
} from './helpers';

/**
 * Real-app cover for the panel context menu's two copy actions (desktop).
 *
 * The bug: "Copy Markdown link" and "Copy note ID" copied nothing and raised a native "the clipboard is not
 * available here" modal. `joplin` in a plugin is a sandbox PROXY that records every member READ on the pending
 * call path and unwinds only on the call, so Cockpit's own `typeof clipboard.writeText` guard left the path at
 * `clipboard.writeText` and the real call arrived at the host as `clipboard.writeText.writeText`, which does not
 * exist. The clipboard itself was never absent - the probe for it was what broke it.
 *
 * Only the SYSTEM clipboard can prove that, so every case seeds a distinct sentinel first (a stale value from an
 * earlier case can then never pass) and reads the clipboard back through the main renderer's own Electron
 * binding. The bracket-titled fixture is not decoration: it pins the Markdown escaping against real clipboard
 * content, which no static check can do.
 *
 * Every case also asserts the panel toast stayed down. The failure notice is a toast now rather than a dialog -
 * on desktop showMessageBox is showMessageBoxSync, which blocks the whole main process (and therefore this
 * spec's own probes), and on mobile a plugin dialog opens BEHIND the panel overlay.
 */
test.describe('Context menu copy actions (desktop)', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const book = `Cockpit Clip ${stamp}`;

  const CA = `cb-A-${stamp}`;
  const CB = `cb-B-${stamp}`;
  const CX = `cb-[bracket]-X-${stamp}`;
  const CY = `cb-Y-${stamp}`;

  let idCA = '';
  let idCB = '';
  let idCX = '';

  // A local Date today at HH:00 - any clock time today lands the to-do in the "Today" group, so it is visible.
  const todayAt = (hour: number) => {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    return d;
  };

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    const { win } = joplin;
    await createNotebook(win, book);
    idCA = await createTodo(win, CA);
    await setAlarm(win, todayAt(8));
    idCB = await createTodo(win, CB);
    await setAlarm(win, todayAt(9));
    idCX = await createTodo(win, CX);
    await setAlarm(win, todayAt(10));
    await createTodo(win, CY);
    await setAlarm(win, todayAt(11));
    await waitForPanelTodo(win, CA);
    await waitForPanelTodo(win, CY);
  });

  test.afterAll(async () => {
    if (!joplin) return;
    // A future regression that re-adds a blocking modal would leave closeJoplin's browser.close() waiting on a
    // frozen main process, and with it the machine-wide e2e lock. Bound the polite close, then make sure.
    try {
      await Promise.race([
        closeJoplin(joplin),
        new Promise((r) => setTimeout(r, 30_000)),
      ]);
    } finally {
      try {
        joplin.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  });

  /**
   * Read the clipboard, and SIGKILL the app if the probe times out. A hung probe means the main process is
   * blocked (the native modal this fix removes), which no later assertion can recover from - and a Joplin left
   * running holds the one-instance lock for every other project on this machine.
   */
  async function clipboard(): Promise<string> {
    try {
      return await readClipboard(joplin.win);
    } catch (error) {
      try {
        joplin.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  /**
   * Build a selection over `markers` (a plain press on the first row, Ctrl-presses on the rest) and open
   * Cockpit's context menu on the last one - the same path a right click takes.
   *
   * The press on CY first is not decoration. A plain press on a row that is ALREADY inside a multi-selection
   * PRESERVES the whole set - the file-manager rule that keeps a multi-row drag intact - so after a case that
   * left CA and CB selected, the press meant to seed the next selection would keep both and the Ctrl press
   * would then REMOVE one, leaving a single-note menu on the wrong row. CY takes part in no case, so pressing
   * it always collapses the selection to one row that is about to be replaced.
   *
   * The resulting selection size is asserted rather than assumed: a batch copy that silently acted on one note
   * is precisely the failure this file exists to catch.
   */
  async function selectAndOpenMenu(markers: string[]): Promise<void> {
    const panel = await agendaPanel(joplin.win);
    const state = await panel.evaluate(
      ({ mk, reset }) => {
        const rowByMarker = (m: string) =>
          (Array.from(document.querySelectorAll('.todo[data-todo-id]')) as HTMLElement[]).find((r) =>
            (r.textContent || '').includes(m)
          );
        const press = (row: HTMLElement, ctrl: boolean) =>
          row.dispatchEvent(new MouseEvent('mousedown', { button: 0, ctrlKey: ctrl, bubbles: true }));

        press(rowByMarker(reset)!, false);
        let last: HTMLElement | null = null;
        mk.forEach((m, index) => {
          const row = rowByMarker(m)!;
          press(row, index > 0);
          last = row;
        });
        last!.dispatchEvent(
          new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true })
        );
        const ids = (window as any).selectedRowIDs;
        return { selected: ids ? ids.size : 0, menu: !!document.getElementById('noteContextMenu') };
      },
      { mk: markers, reset: CY }
    );
    expect(state.selected).toBe(markers.length);
    expect(state.menu).toBe(true);
  }

  /** Click the open context menu's item whose data-action matches. */
  async function clickMenuAction(action: string): Promise<void> {
    const panel = await agendaPanel(joplin.win);
    await panel.evaluate((a) => {
      const menu = document.getElementById('noteContextMenu')!;
      const button = menu.querySelector(`.context-menu-item[data-action="${a}"]`) as HTMLElement;
      button.click();
    }, action);
  }

  /**
   * One case: seed a sentinel the copy must overwrite, run the action, then wait for the exact expected text.
   * The wait is a poll because the host does a data.get for the title before it writes.
   */
  async function expectCopied(
    label: string,
    markers: string[],
    action: string,
    expected: string
  ): Promise<void> {
    const sentinel = `SENTINEL-${label}-${stamp}`;
    await writeClipboard(joplin.win, sentinel);
    expect(await clipboard()).toBe(sentinel);

    await selectAndOpenMenu(markers);
    await clickMenuAction(action);

    await expect.poll(clipboard, { timeout: 20_000, intervals: [400, 800, 1500, 2500] }).toBe(
      expected
    );
    // The failure branch must not have been taken: no toast, and (since the probes above answered) no modal.
    expect(await panelToastVisible(joplin.win)).toBe(false);
  }

  test('a single row copies its note id', async () => {
    await expectCopied('1', [CA], 'copyNoteID', idCA);
  });

  test('a single row copies its Markdown link', async () => {
    await expectCopied('2', [CA], 'copyMarkdownLink', `[${CA}](:/${idCA})`);
  });

  test('a title containing square brackets is escaped in the copied Markdown link', async () => {
    // Joplin's own Note.markdownTag escapes [ and ]; without it the label closes early at the first ] and the
    // link stops parsing. This is the case a static check cannot settle - it is about the bytes on the clipboard.
    await expectCopied('3', [CX], 'copyMarkdownLink', `[${CX.replace(/(\[|\])/g, '\\$1')}](:/${idCX})`);
  });

  test('a multi-selection copies every note id, newline separated', async () => {
    await expectCopied('4', [CA, CB], 'copyNoteID', `${idCA}\n${idCB}`);
  });

  test('a multi-selection copies every Markdown link, newline separated', async () => {
    await expectCopied('5', [CA, CB], 'copyMarkdownLink', `[${CA}](:/${idCA})\n[${CB}](:/${idCB})`);
  });
});
