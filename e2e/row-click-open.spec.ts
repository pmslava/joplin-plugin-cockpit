import { test, expect, Locator } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  agendaPanel,
  createNote,
  createNotebook,
  selectNote,
  refreshPanel,
  PANEL_REFRESH_TIMEOUT,
} from './helpers';

/**
 * A left click on a row's dead zone opens the note.
 *
 * The bug: opening was wired only to the title zone, so a plain left click on the row's padding (or any
 * gap outside the title, checkbox and notebook pill) selected the row but left the editor unchanged. The
 * fix makes any plain left click on a row open it, exactly like the title. This spec proves it in the
 * real GUI: it clicks a point in the row's LEFT PADDING - 3px in from the row's left edge, which is left
 * of the progress circle and well left of the title and the notebook pill - and asserts Joplin's editor
 * switches to that note. The click lands on the row background, never on any of its three interactive
 * zones, so only the row-wide open can account for the editor changing. An absolute mouse click at a
 * boundingBox-derived point is used (a padding-relative offset is ambiguous about padding vs border box).
 */
test.describe('Row dead-zone click opens the note', () => {
  let joplin: JoplinInstance;
  // A distinctive token that exists only in the target note's title, so its row is located unambiguously.
  const marker = `Zqxrowopen${Date.now()}`;
  const noteTitle = `${marker} target note`;
  // A second note with NO shared marker, created last so the editor starts on it - moving the selection
  // off the target gives the click an observable effect to prove.
  const decoyTitle = `Decoy note ${Date.now()}`;
  const notebook = `Cockpit Row Open ${Date.now()}`;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    const { win } = joplin;
    await createNotebook(win, notebook); // becomes the selected notebook...
    await createNote(win, noteTitle); // ...so both notes are created inside it.
    await createNote(win, decoyTitle); // selected last => the editor starts on the decoy.
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('a left click on the row padding (outside every zone) opens the note in the editor', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);

    // Move Joplin's selection off the target first, so a change of the editor is the click's own doing.
    await selectNote(win, decoyTitle);

    // The default profile lists regular notes, so the note surfaces as a `.todo[data-note-id]` row once
    // Joplin's search index has caught up. Poll for that row, prompting a panel refresh each tick so it
    // appears as soon as the index agrees rather than on the panel's slow periodic refresh.
    const row = panel.locator('.todo[data-note-id]', { hasText: marker }).first();
    await expect
      .poll(
        async () => {
          await refreshPanel(win);
          return row.count();
        },
        { timeout: PANEL_REFRESH_TIMEOUT, intervals: [1500, 2500, 4000] }
      )
      .toBeGreaterThan(0);

    // Compute a point in the row's LEFT PADDING: 3px in from the row's left edge. The row's first child
    // (the progress circle) starts at the 6px content edge, and the title and notebook pill are further
    // right still, so this point sits on the row background, outside all three interactive zones. Assert
    // that geometry explicitly before clicking, then click it with an absolute mouse click.
    await row.scrollIntoViewIfNeeded();
    const rowBox = await row.boundingBox();
    const circleBox = await row.locator('.note-progress').boundingBox();
    const titleBox = await row.locator('.todo-title').boundingBox();
    expect(rowBox).not.toBeNull();
    expect(circleBox).not.toBeNull();
    expect(titleBox).not.toBeNull();

    const clickX = rowBox!.x + 3;
    const clickY = rowBox!.y + rowBox!.height / 2;
    // The point is genuinely outside every zone: left of the progress circle, and so left of the title too.
    expect(clickX).toBeLessThan(circleBox!.x);
    expect(clickX).toBeLessThan(titleBox!.x);

    await win.mouse.click(clickX, clickY);

    // Joplin's editor title field now shows the clicked note - the row-wide open fired from the padding.
    await expect
      .poll(async () => win.locator('input.title-input').inputValue(), { timeout: 30_000 })
      .toBe(noteTitle);
  });

  /**
   * The panel's row highlight follows the MAIN editor, not only the rows opened from the panel: the plugin watches
   * workspace.onNoteSelectionChange and pushes the open note's id to the panel webview, which highlights that row
   * (or none, when the list does not hold it). This runs after the test above, so the panel starts highlighting the
   * target note it just opened; selecting the decoy in Joplin's OWN note list must move the highlight to its row.
   */
  test('opening another note in Joplin moves the panel highlight to that row', async () => {
    const { win } = joplin;
    const panel = await agendaPanel(win);
    const isSelected = (row: Locator) =>
      row.evaluate((el) => el.classList.contains('-selected')).catch(() => false);

    const targetRow = panel.locator('.todo[data-note-id]', { hasText: marker }).first();
    await expect.poll(() => isSelected(targetRow), { timeout: 30_000 }).toBe(true);

    // The decoy is a note in the same notebook, so the profile lists it too - wait for its row, prompting a
    // refresh each tick like the test above does, then select it in Joplin's note list.
    const decoyRow = panel.locator('.todo[data-note-id]', { hasText: decoyTitle }).first();
    await expect
      .poll(
        async () => {
          await refreshPanel(win);
          return decoyRow.count();
        },
        { timeout: PANEL_REFRESH_TIMEOUT, intervals: [1500, 2500, 4000] }
      )
      .toBeGreaterThan(0);

    await selectNote(win, decoyTitle);

    await expect.poll(() => isSelected(decoyRow), { timeout: 30_000 }).toBe(true);
    expect(await isSelected(targetRow)).toBe(false);
  });
});
