import { test, expect, Page } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  createNotebook,
  createProfile,
  createTodo,
  executePluginCommand,
  noteViewerText,
  profileNames,
  selectNote,
  setCockpitTextSetting,
  waitForPanelTodo,
  PANEL_REFRESH_TIMEOUT,
} from './helpers';

/**
 * The settings note: one Joplin note carrying Cockpit's profiles and view settings, so a user sets them up once and
 * every device they sync with picks them up (issue 5). The format half is unit-tested in the harness; what only the
 * real app can show is the whole round trip - a note that is really there, with a body that really parses, and a
 * profile made through the GUI really reaching it.
 *
 * TWO INSTANCES, because there are two ways in and the second needs a profile that has never had a settings note.
 * The first describe drives the `cockpit.connectSettingsNote` command through `executePluginCommand`, and therefore
 * `launchJoplin({ envDev: true })`, for the same reason whereabouts-commands.spec.ts does: it goes through the very
 * CommandService entry point a palette entry lands in, with no dependence on how the palette spells the label. The
 * second drives the SETTINGS FIELD, which is what a user actually uses - the command lost its Tools menu item in the
 * owner's first live round of 2.6.0 - and needs no dev mode at all.
 *
 * THE INBOUND HALF IS NOT DRIVEN HERE. Proving that a change another device made is applied needs the note's BODY
 * rewritten from outside Cockpit, and this harness has no route to it: Joplin's data API is not reachable from the
 * renderer (`window.require` hands back a second, unconnected copy of the module - see executePluginCommand), and
 * typing a JSON payload into the Markdown editor goes through CodeMirror's bracket auto-closing, which would mangle
 * it. The apply path is covered end to end in the harness instead (test/run.js: the startup read, the sync-complete
 * read, the note-change read and the periodic tick).
 */
const SETTINGS_NOTE_TITLE = 'Joplin Cockpit Plugin Settings';
const SETTINGS_NOTE_SENTENCE =
  'This note is used by the Cockpit plugin to sync its profiles and settings between devices.';

/**
 * The settings note's rendered body, or '' while there is no such note to read.
 *
 * The editor is parked on the given to-do FIRST, every time: Cockpit never writes the settings note while it is the
 * note open in the editor (a plugin write evicts the mobile editor mid-edit), so a poll that simply sat on the note
 * would be holding back the very write it is waiting for. Moving off it is also the drain point for a deferred write.
 */
async function settingsNoteText(win: Page, parkOn: string): Promise<string> {
  try {
    await selectNote(win, parkOn);
    await selectNote(win, SETTINGS_NOTE_TITLE);
    return await noteViewerText(win);
  } catch {
    // The note has not been created, or has not reached the note list yet. The caller is polling.
    return '';
  }
}

/** The JSON payload inside a rendered body, or null when there is not one that parses. */
function payloadOf(text: string): any {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(text.slice(first, last + 1));
  } catch {
    return null;
  }
}

test.describe('Settings note', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const notebook = `Cockpit Settings ${stamp}`;
  const todoTitle = `SettingsTask${stamp}`;
  const newProfile = `Synced profile ${stamp}`;

  test.beforeAll(async () => {
    joplin = await launchJoplin({ envDev: true });
    const { win } = joplin;
    await createNotebook(win, notebook); // becomes the selected notebook...
    await createTodo(win, todoTitle); // ...so the to-do and the settings note are both created in it
    await waitForPanelTodo(win, todoTitle);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('the command creates the note, and its body lists this device\'s profiles', async () => {
    const { win } = joplin;
    await executePluginCommand(win, 'cockpit.connectSettingsNote');

    // The note is created through the data API, so it reaches the note list on the app's own schedule.
    await expect
      .poll(async () => settingsNoteText(win, todoTitle), { timeout: PANEL_REFRESH_TIMEOUT })
      .toContain(SETTINGS_NOTE_SENTENCE);

    const payload = payloadOf(await settingsNoteText(win, todoTitle));
    expect(payload).not.toBeNull();
    expect(payload.version).toBe(1);
    // Seeded from this device, never empty: the profile a fresh install ships with is in it.
    const names = (payload.profiles?.profiles || []).map((profile: any) => profile.name);
    expect(names).toContain('All todo and notes');
    // The settings that travel are there; the ones that are a property of the machine are not.
    expect(payload.settings).toHaveProperty('themeMode');
    expect(payload.settings).not.toHaveProperty('showToolbarButton');
    expect(payload.settings).not.toHaveProperty('customFontSize');
  });

  test('a profile made in the panel reaches the note', async () => {
    const { win } = joplin;
    await createProfile(win, { name: newProfile, showNoDue: true });
    expect(await profileNames(win)).toContain(newProfile);

    // The write is debounced by 3 s and then has to survive the editor gate, which `settingsNoteText` releases on
    // every poll by parking the editor on the to-do first. The timeout is the suite's ordinary generous one.
    await expect
      .poll(async () => settingsNoteText(win, todoTitle), { timeout: PANEL_REFRESH_TIMEOUT })
      .toContain(newProfile);

    const payload = payloadOf(await settingsNoteText(win, todoTitle));
    expect(payload).not.toBeNull();
    const names = (payload.profiles?.profiles || []).map((profile: any) => profile.name);
    // WHOLESALE, not a diff: the note carries the entire store, so the profile that was already there is still there.
    expect(names).toContain('All todo and notes');
    expect(names).toContain(newProfile);
  });

  test('running the command again connects to the note that exists rather than making a second one', async () => {
    const { win } = joplin;
    await executePluginCommand(win, 'cockpit.connectSettingsNote');
    await selectNote(win, todoTitle);
    const titles = await win.locator('.note-list-item .title span').allTextContents();
    const settingsNotes = titles.filter((title) => title.trim() === SETTINGS_NOTE_TITLE);
    expect(settingsNotes).toHaveLength(1);
    // ...and the profiles are still the ones this device holds, not a store applied back over itself.
    expect(await profileNames(win)).toContain(newProfile);
  });
});

/**
 * The way a user sets this up: one field in Settings › Plugins › Cockpit. Typing the note's own name there creates
 * the note when there is none, which is the whole of the first device's setup - no menu item, no command palette.
 *
 * Its own Joplin instance, because the cases above have already made a settings note in theirs and the thing under
 * test here is precisely a profile that has never had one.
 */
test.describe('Settings note from the Settings screen', () => {
  let joplin: JoplinInstance;
  const stamp = Date.now();
  const notebook = `Cockpit Field ${stamp}`;
  const todoTitle = `FieldTask${stamp}`;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    const { win } = joplin;
    await createNotebook(win, notebook);
    await createTodo(win, todoTitle);
    await waitForPanelTodo(win, todoTitle);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('typing the note\'s title into the Settings field creates the note', async () => {
    const { win } = joplin;
    await setCockpitTextSetting(win, 'Settings note', SETTINGS_NOTE_TITLE);

    await expect
      .poll(async () => settingsNoteText(win, todoTitle), { timeout: PANEL_REFRESH_TIMEOUT })
      .toContain(SETTINGS_NOTE_SENTENCE);

    const payload = payloadOf(await settingsNoteText(win, todoTitle));
    expect(payload).not.toBeNull();
    expect(payload.version).toBe(1);
    const names = (payload.profiles?.profiles || []).map((profile: any) => profile.name);
    expect(names).toContain('All todo and notes');
  });
});
