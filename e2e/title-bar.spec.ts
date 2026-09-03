import { test, expect, Page } from '@playwright/test';
import { launchJoplin, closeJoplin, createProfile as createJoplinProfile, JoplinInstance } from './launch';
import {
  createTodo,
  selectNote,
  setAlarm,
  setCockpitCheckboxes,
  waitForPanelTodo,
} from './helpers';

/**
 * The two note title bar features of v2.5.0, driven in the real app - because neither of them exists anywhere the
 * Node harness can see. One is a stylesheet Joplin links into its own window, the other is a DOM click intercept
 * running inside Joplin's renderer; the harness can only pin that the plugin ASKS for them.
 *
 * Both settings say "takes effect after a Joplin restart", and they mean it - Joplin can neither unload a chrome
 * stylesheet nor unregister a content script - so this file launches Joplin once with both settings at their OFF
 * default, records what the bell does then, turns both on through the Options screen, and RELAUNCHES against the
 * same profile to record what the bell does with them on. That restart is the feature, not a workaround for it.
 */
test.describe('The note title bar (due date on hover, and the bell opening Cockpit\'s picker)', () => {
  let joplin: JoplinInstance;
  let profileDir = '';
  let restarted = false;
  const stamp = Date.now();
  const bellTodo = `BellTask${stamp}`;

  const HOVER_LABEL = 'Hide the due date next to the bell in the note title bar and show it on hover';
  const PICKER_LABEL = "Open Cockpit's date picker instead of Joplin's when the alarm bell is clicked";

  /** The alarm bell in the note title bar: the only title-bar button carrying the alarm icon. */
  const BELL = '.note-title-info-group button.toolbar-button:has(.icon-alarm)';
  /** The due-date text Joplin prints inside that button beside the icon - the thing the stylesheet hides. */
  const BELL_TEXT = '.note-title-info-group button.toolbar-button:has(.icon-alarm) > span:not(.toolbar-icon)';

  /** The `display` the browser actually computes for the bell's text span (so a CSS rule is read, not guessed). */
  async function bellTextDisplay(win: Page): Promise<string> {
    return win.evaluate((selector) => {
      const span = document.querySelector(selector);
      return span ? getComputedStyle(span).display : 'missing';
    }, BELL_TEXT);
  }

  /** Whether Joplin's OWN alarm prompt (PromptDialog, `.prompt-dialog`) is on screen. */
  async function joplinPromptOpen(win: Page): Promise<boolean> {
    return win.locator('.prompt-dialog').isVisible().catch(() => false);
  }

  /** Whether COCKPIT's alarm dialog is on screen: a plugin webview iframe carrying the picker's own form. */
  async function cockpitDialogOpen(win: Page): Promise<boolean> {
    for (const frame of win.frames()) {
      const found = await frame.locator('#alarmForm').count().catch(() => 0);
      if (found) return true;
    }
    return false;
  }

  /** Dismiss whichever picker is open, so the next case starts from a clean window. */
  async function dismissAnyDialog(win: Page): Promise<void> {
    await win.keyboard.press('Escape');
    await win.waitForTimeout(1000);
    if (await joplinPromptOpen(win)) {
      await win.locator('.prompt-dialog button:has-text("Cancel")').first().click().catch(() => undefined);
    }
    const cancel = win.locator('.user-webview-dialog button:has-text("Cancel")').last();
    if (await cancel.isVisible().catch(() => false)) await cancel.click().catch(() => undefined);
    await win.waitForTimeout(1000);
  }

  test.beforeAll(async () => {
    profileDir = createJoplinProfile(true);
    joplin = await launchJoplin({ profileDir });
    await createTodo(joplin.win, bellTodo);
    // An alarm is what makes Joplin print the due date inside the button (-has-title), which is the whole subject
    // of feature A - and it is set here through Joplin's own prompt, while that prompt is still what the bell opens.
    await setAlarm(joplin.win, new Date(Date.now() + 26 * 3600 * 1000));
    await waitForPanelTodo(joplin.win, bellTodo);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('with both settings off: the due date is visible beside the bell, and the bell opens Joplin\'s own prompt', async () => {
    const { win } = joplin;
    await selectNote(win, bellTodo);
    await expect(win.locator(BELL)).toBeVisible();
    // Nothing is hidden: the plugin loaded no stylesheet, so the button looks exactly as Joplin drew it.
    expect(await bellTextDisplay(win)).not.toBe('none');

    await win.locator(BELL).click();
    await expect.poll(async () => joplinPromptOpen(win), { timeout: 20_000 }).toBe(true);
    expect(await cockpitDialogOpen(win)).toBe(false);
    await dismissAnyDialog(win);
  });

  test('with both settings on (after a restart): the due date only shows on hover, and the bell opens Cockpit\'s picker', async () => {
    if (!restarted) {
      await setCockpitCheckboxes(joplin.win, { [HOVER_LABEL]: true, [PICKER_LABEL]: true });
      await closeJoplin(joplin, { keepProfile: true });
      joplin = await launchJoplin({ profileDir });
      restarted = true;
    }
    const { win } = joplin;
    await selectNote(win, bellTodo);
    await expect(win.locator(BELL)).toBeVisible();

    // A: the chrome stylesheet is in the window, so the due-date text is hidden until the pointer is on the bell.
    await expect.poll(async () => bellTextDisplay(win), { timeout: 20_000 }).toBe('none');
    await win.locator(BELL).hover();
    await expect.poll(async () => bellTextDisplay(win), { timeout: 10_000 }).toBe('block');

    // B: the content script takes the click in the capture phase, so Joplin's editAlarm never runs.
    await win.locator(BELL).click();
    await expect.poll(async () => cockpitDialogOpen(win), { timeout: 30_000 }).toBe(true);
    expect(await joplinPromptOpen(win)).toBe(false);
    await dismissAnyDialog(win);
  });
});
