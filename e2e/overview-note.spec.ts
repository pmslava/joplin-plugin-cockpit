import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  createNote,
  createNotebook,
  createTodo,
  editCurrentProfile,
  noteViewerText,
  selectNote,
  setAlarm,
  waitForPanelTodo,
  PANEL_REFRESH_TIMEOUT,
} from './helpers';

/**
 * The overview note feature: a profile can name a note that Agenda keeps filled with that profile's
 * to-do list, so the list is readable anywhere a note is.
 */
test.describe('Overview note', () => {
  let joplin: JoplinInstance;
  let overviewNoteId: string;
  const todoTitle = 'Overview task';
  const overviewNoteTitle = 'Agenda Overview';

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    const { win } = joplin;
    await createNotebook(win, 'Agenda E2E');

    overviewNoteId = await createNote(win, overviewNoteTitle);

    await createTodo(win, todoTitle);
    await setAlarm(win, new Date(Date.now() + 4 * 3600 * 1000));
    await waitForPanelTodo(win, todoTitle);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('the note is left alone until a profile points at it', async () => {
    const { win } = joplin;
    await selectNote(win, overviewNoteTitle);
    expect(await noteViewerText(win)).not.toContain(todoTitle);
  });

  test('setting the overview note id fills the note with the to-do list', async () => {
    const { win } = joplin;
    await editCurrentProfile(win, { name: 'Overview profile', noteID: overviewNoteId });

    await selectNote(win, overviewNoteTitle);
    await expect
      .poll(() => noteViewerText(win), { timeout: PANEL_REFRESH_TIMEOUT })
      .toContain(todoTitle);

    // The generated note is headed with the profile name and groups to-dos the same way the panel
    // does. Which group the to-do lands in depends on the time of day the suite runs: an alarm a few
    // hours out is either later today or early tomorrow.
    const text = await noteViewerText(win);
    expect(text).toContain('Overview profile');
    expect(text).toMatch(/\b(Today|Tomorrow)\b/);
  });

  test('a new to-do reaches the overview note as well', async () => {
    const { win } = joplin;
    await createTodo(win, 'Second overview task');
    await setAlarm(win, new Date(Date.now() + 5 * 3600 * 1000));

    await selectNote(win, overviewNoteTitle);
    await expect
      .poll(() => noteViewerText(win), { timeout: PANEL_REFRESH_TIMEOUT })
      .toContain('Second overview task');
  });

  test('clearing the overview note id stops Agenda writing to it', async () => {
    const { win } = joplin;
    await editCurrentProfile(win, { noteID: '' });

    await createTodo(win, 'Ignored task');
    await setAlarm(win, new Date(Date.now() + 6 * 3600 * 1000));
    await waitForPanelTodo(win, 'Ignored task');

    await selectNote(win, overviewNoteTitle);
    // Wait out both the follow up refreshes and a fallback interval, so that a profile still
    // pointing at the note would certainly have rewritten it by now.
    await win.waitForTimeout(70_000);
    expect(await noteViewerText(win)).not.toContain('Ignored task');
  });
});
