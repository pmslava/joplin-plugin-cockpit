import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, createProfile as createJoplinProfile, JoplinInstance } from './launch';
import {
  createNotebook,
  createProfile,
  createTodo,
  editCurrentProfile,
  panelTodoTitles,
  profileControlsVisible,
  profileNames,
  selectProfile,
  selectedProfileName,
  setAlarm,
  waitForPanelTodo,
  waitForPanelTodoGone,
} from './helpers';

/**
 * Profiles are the part of Agenda that changed most in the move to mobile: they used to live in an
 * sqlite3 database and now live in a plugin setting. These tests drive the profile editor through
 * the real GUI, and the last one restarts Joplin to prove the profiles are actually persisted.
 *
 * Deleting a profile is deliberately not covered: the confirmation is an Electron native message
 * box, which is outside the renderer and so cannot be driven by Playwright.
 */
test.describe('Profiles', () => {
  let joplin: JoplinInstance;
  let profileDir: string;
  const alphaTitle = 'Alpha task';
  const betaTitle = 'Beta task';

  test.beforeAll(async () => {
    profileDir = createJoplinProfile(true);
    joplin = await launchJoplin({ profileDir });
    const { win } = joplin;
    await createNotebook(win, 'Agenda E2E');

    await createTodo(win, alphaTitle);
    await setAlarm(win, new Date(Date.now() + 2 * 3600 * 1000));

    await createTodo(win, betaTitle);
    await setAlarm(win, new Date(Date.now() + 3 * 3600 * 1000));

    await waitForPanelTodo(win, alphaTitle);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('a new profile can be created from the panel', async () => {
    const { win } = joplin;
    await createProfile(win, { name: 'Beta only', searchCriteria: 'Beta' });

    await expect
      .poll(() => profileNames(win), { timeout: 30_000 })
      .toEqual(expect.arrayContaining(['All todo and notes', 'Beta only']));
  });

  test('the new profile becomes selectable and its search criteria filters the list', async () => {
    const { win } = joplin;
    await selectProfile(win, 'Beta only');
    expect(await selectedProfileName(win)).toBe('Beta only');

    await waitForPanelTodo(win, betaTitle);
    await waitForPanelTodoGone(win, alphaTitle);
  });

  test('switching back to the other profile restores the full list', async () => {
    const { win } = joplin;
    await selectProfile(win, 'All todo and notes');
    await waitForPanelTodo(win, alphaTitle);
    await waitForPanelTodo(win, betaTitle);
  });

  test('the display format can be changed per profile', async () => {
    const { win } = joplin;
    await selectProfile(win, 'Beta only');
    await editCurrentProfile(win, { displayFormat: 'basic' });

    // The basic format groups nothing and shows the bare title, with no time prefix.
    await expect
      .poll(async () => (await panelTodoTitles(win)).includes(betaTitle), { timeout: 60_000 })
      .toBe(true);
  });

  test('profiles and the selected profile survive a restart of Joplin', async () => {
    await closeJoplin(joplin, { keepProfile: true });
    joplin = await launchJoplin({ profileDir });
    const { win } = joplin;

    await expect
      .poll(() => profileNames(win), { timeout: 60_000 })
      .toEqual(expect.arrayContaining(['All todo and notes', 'Beta only']));
    expect(await selectedProfileName(win)).toBe('Beta only');

    // Its settings survived too: still the 'Beta' search criteria from before the restart.
    await waitForPanelTodo(win, betaTitle);
    await waitForPanelTodoGone(win, alphaTitle);
  });

  test('the profile controls are shown in the panel', async () => {
    // Hiding them is driven by the "Toggle Profile Edit Mode" command, which on desktop is only
    // reachable from the Tools > Agenda menu and the command palette. Both are native Electron
    // menus, and synthetic key presses do not fire their accelerators, so the toggle itself is
    // covered by the harness suite (npm test) instead.
    expect(await profileControlsVisible(joplin.win)).toBe(true);
  });
});
