import { Page, Frame, expect } from '@playwright/test';
import { PLUGIN_ID } from './launch';

/**
 * Reusable, real-app interaction helpers for the Agenda e2e suite.
 *
 * Every helper drives the genuine Joplin desktop GUI through the main renderer `Page` (`win`).
 * The selectors here were verified against a real Joplin 3.6 build; see the comments on each helper
 * for the gotchas.
 */

/** Short settle delay used after GUI actions that trigger async React re-renders. */
const SETTLE = 1500;

/**
 * Agenda refreshes on note changes, but Joplin's search index is only brought up to date on a timer
 * of its own, so a change usually reaches the panel in a few seconds and in the worst case only on
 * Agenda's fallback refresh, which defaults to every 60 seconds. Anything that waits for the panel
 * to reflect a change therefore has to allow for more than one fallback interval.
 */
export const PANEL_REFRESH_TIMEOUT = 90_000;

/** ----------------------------------------------------------------------------------------------
 * The Agenda panel
 * ------------------------------------------------------------------------------------------- */

/**
 * Find the iframe hosting the Cockpit panel. Plugin panels are rendered in a Joplin webview iframe
 * whose id contains the plugin id, but the panel is located by the presence of its profile controls
 * section instead, which is both simpler and independent of the plugin id. (`#profileControls` is
 * emitted on every panel render; the profile picker inside it is a custom dropdown, not a native
 * `<select>`, so there is no `#profileDropdown` to key off any more.)
 */
async function findPanelFrame(win: Page): Promise<Frame | null> {
  for (const frame of win.frames()) {
    const found = await frame
      .locator('#profileControls')
      .count()
      .catch(() => 0);
    if (found) return frame;
  }
  return null;
}

/** Get the Agenda panel frame, waiting for it to appear. */
export async function agendaPanel(win: Page): Promise<Frame> {
  await expect
    .poll(async () => (await findPanelFrame(win)) != null, { timeout: 60_000 })
    .toBe(true);
  return (await findPanelFrame(win))!;
}

/** Whether the Agenda panel is currently rendered at all. */
export async function panelIsPresent(win: Page): Promise<boolean> {
  return (await findPanelFrame(win)) != null;
}

/**
 * The element in the main window that hosts the panel. Joplin names it after the plugin and view.
 * An attribute selector is required rather than `#id`, because the plugin id contains dots, which a
 * CSS id selector would read as class names. Used by the (opt-in) showcase capture spec.
 */
export const PANEL_IFRAME = `iframe[id="plugin-view-${PLUGIN_ID}-panel"]`;

/**
 * Whether the panel is visible to the user. Hiding a panel leaves its iframe in the DOM — the
 * application layout just stops showing it — so presence of the frame is not the same as visibility.
 * The panel's own iframe element is reached from the frame itself, so this stays independent of how
 * Joplin happens to spell the iframe's id.
 */
export async function panelIsVisible(win: Page): Promise<boolean> {
  const frame = await findPanelFrame(win);
  if (!frame) return false;
  try {
    const element = await frame.frameElement();
    return await element.isVisible();
  } catch {
    return false;
  }
}

/**
 * The to-do titles currently listed in the panel, in display order.
 *
 * Read via textContent, not innerText: innerText is layout-dependent (it returns "" for anything
 * the panel is painting invisibly and reflects CSS text casing), whereas the tests want the literal
 * label the panel emitted, e.g. "23:06 - Today task".
 */
export async function panelTodoTitles(win: Page): Promise<string[]> {
  const frame = await findPanelFrame(win);
  if (!frame) return [];
  return (await frame.locator('.todo-title').allTextContents()).map((t) => t.trim());
}

/**
 * The group headings (Overdue, Today, ...) currently shown in the panel, in display order.
 *
 * The panel uppercases these headings with `text-transform: uppercase`, which is a display effect
 * only; innerText would echo it back as "OVERDUE". textContent returns the real heading the panel
 * rendered ("Overdue", "Today", "No Due Date", ...), which is what the specs assert against.
 */
export async function panelHeadings(win: Page): Promise<string[]> {
  const frame = await findPanelFrame(win);
  if (!frame) return [];
  return (await frame.locator('.todos h2').allTextContents()).map((t) => t.trim());
}

/** Wait until the panel lists a to-do whose text contains `title`. */
export async function waitForPanelTodo(win: Page, title: string): Promise<void> {
  await expect
    .poll(async () => (await panelTodoTitles(win)).some((t) => t.includes(title)), {
      timeout: PANEL_REFRESH_TIMEOUT,
    })
    .toBe(true);
}

/** Wait until the panel no longer lists a to-do whose text contains `title`. */
export async function waitForPanelTodoGone(win: Page, title: string): Promise<void> {
  await expect
    .poll(async () => (await panelTodoTitles(win)).some((t) => t.includes(title)), {
      timeout: PANEL_REFRESH_TIMEOUT,
    })
    .toBe(false);
}

/** Click the checkbox of the panel row whose title contains `title`. */
export async function checkPanelTodo(win: Page, title: string): Promise<void> {
  const frame = await agendaPanel(win);
  await frame.locator('.todo', { hasText: title }).locator('.todo-checkbox').click();
  await win.waitForTimeout(SETTLE);
}

/** Click the title link of the panel row whose title contains `title`. */
export async function clickPanelTodo(win: Page, title: string): Promise<void> {
  const frame = await agendaPanel(win);
  await frame.locator('.todo-title', { hasText: title }).click();
  await win.waitForTimeout(SETTLE);
}

/**
 * Force a panel + overview-note refresh.
 *
 * Cockpit has no manual "refresh" button: refreshes are driven by note-change events and a periodic
 * timer. Re-selecting the currently active profile posts `profilesDropdownChanged`, whose handler
 * schedules a full `refreshInterfaces()` (panel data *and* the overview notes), which is the promptest
 * refresh a real GUI action can trigger. The scheduled refresh lands a beat later, so callers still
 * poll for the result.
 */
export async function refreshPanel(win: Page): Promise<void> {
  const frame = await agendaPanel(win);
  await frame.locator('#profileControls .dropdown-toggle').first().click();
  await frame.locator('#profileMenu .dropdown-item.-current .dropdown-label').first().click();
  await win.waitForTimeout(SETTLE);
}

/** ----------------------------------------------------------------------------------------------
 * Notebooks and notes
 * ------------------------------------------------------------------------------------------- */

/** Create a new notebook with the given name. It becomes the active/selected notebook. */
export async function createNotebook(win: Page, name: string): Promise<void> {
  await win.click('.sidebar-header-button.-newfolder');
  await win.waitForTimeout(1200);
  await win.locator('input[type="text"]:visible').first().fill(name);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(1200);
}

/**
 * The id of the note currently selected in the note list. Joplin puts the note id in a `data-id`
 * attribute on the list row, and marks the selected row's inner element with `-selected`.
 */
export async function selectedNoteId(win: Page): Promise<string> {
  const id = await win
    .locator('.note-list-item:has(.content.-selected)')
    .first()
    .getAttribute('data-id');
  if (!id) throw new Error('Could not determine the selected note id');
  return id;
}

/**
 * Create a new to-do in the currently selected notebook and type its title.
 * Focus lands in the title field after clicking "New to-do", so we just type. Returns the note id.
 */
export async function createTodo(win: Page, title: string): Promise<string> {
  await win.locator('button:has-text("New to-do")').first().click();
  await win.waitForTimeout(SETTLE);
  await win.keyboard.type(title);
  await win.waitForTimeout(SETTLE);
  return selectedNoteId(win);
}

/** Create a new plain note in the currently selected notebook. Returns the note id. */
export async function createNote(win: Page, title: string): Promise<string> {
  await win.locator('button:has-text("New note")').first().click();
  await win.waitForTimeout(SETTLE);
  await win.keyboard.type(title);
  await win.waitForTimeout(SETTLE);
  return selectedNoteId(win);
}

/** Select the note with the given title in the note list. */
export async function selectNote(win: Page, title: string): Promise<void> {
  await win.locator('.note-list-item .title span', { hasText: title }).first().click();
  await win.waitForTimeout(SETTLE);
}

/** ----------------------------------------------------------------------------------------------
 * Alarms (to-do due dates)
 * ------------------------------------------------------------------------------------------- */

/** Format a Date the way Joplin's `datetime-local` alarm input expects. */
export function toDateTimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Set the selected to-do's alarm (which is what Agenda treats as its due date). */
export async function setAlarm(win: Page, date: Date): Promise<void> {
  await win.click('button[title="Set alarm"]');
  await win.waitForTimeout(2000);
  await win.locator('input[type="datetime-local"]').fill(toDateTimeLocal(date));
  await win.locator('button:has-text("OK")').last().click();
  await win.waitForTimeout(SETTLE);
}

/** ----------------------------------------------------------------------------------------------
 * To-do completion
 * ------------------------------------------------------------------------------------------- */

const COMPLETE_CHECKBOX = '.note-list-item .content.-selected .checkbox input[type="checkbox"]';

/** Read whether the currently selected to-do is marked complete in Joplin's own note list. */
export async function isSelectedTodoComplete(win: Page): Promise<boolean> {
  return win.locator(COMPLETE_CHECKBOX).first().isChecked();
}

/** ----------------------------------------------------------------------------------------------
 * Profiles
 * ------------------------------------------------------------------------------------------- */

export interface ProfileFields {
  name?: string;
  searchCriteria?: string;
  noteID?: string;
  displayFormat?: 'basic' | 'interval' | 'date' | 'month' | 'week';
  showCompleted?: boolean;
  showNoDue?: boolean;
  noDueDatesAtEnd?: boolean;
}

/** Find the iframe hosting the profile editor dialog, which is identified by its name field. */
async function findEditorFrame(win: Page): Promise<Frame | null> {
  for (const frame of win.frames()) {
    const found = await frame
      .locator('#nameInput')
      .count()
      .catch(() => 0);
    if (found) return frame;
  }
  return null;
}

/** Wait for the profile editor dialog to open and return its frame. */
async function editorFrame(win: Page): Promise<Frame> {
  await expect
    .poll(async () => (await findEditorFrame(win)) != null, { timeout: 30_000 })
    .toBe(true);
  return (await findEditorFrame(win))!;
}

/**
 * Fill the profile editor form.
 *
 * Gotcha: the dialog's script only copies the field values into the hidden form field that Joplin
 * submits when a `change` event fires, so every field is explicitly given one.
 */
async function fillProfileForm(frame: Frame, fields: ProfileFields): Promise<void> {
  const setText = async (selector: string, value: string) => {
    await frame.locator(selector).fill(value);
    await frame.locator(selector).dispatchEvent('change');
  };
  const setCheckbox = async (selector: string, value: boolean) => {
    if ((await frame.locator(selector).isChecked()) !== value) {
      await frame.locator(selector).click();
    }
  };

  if (fields.name != null) await setText('#nameInput', fields.name);
  if (fields.searchCriteria != null) await setText('#searchCriteriaInput', fields.searchCriteria);
  if (fields.noteID != null) await setText('#noteIDInput', fields.noteID);
  if (fields.displayFormat != null) {
    await frame.locator('#displayFormatSelect').selectOption(fields.displayFormat);
    await frame.locator('#displayFormatSelect').dispatchEvent('change');
  }
  if (fields.showCompleted != null) {
    // "Show completed" is no longer a single flag: the editor splits it into past/today/future/
    // no-due checkboxes. Map the boolean onto all four so it behaves like the old single toggle.
    for (const id of [
      '#showCompletedPastCheckbox',
      '#showCompletedTodayCheckbox',
      '#showCompletedFutureCheckbox',
      '#showCompletedNoDueCheckbox',
    ]) {
      await setCheckbox(id, fields.showCompleted);
    }
  }
  if (fields.showNoDue != null) await setCheckbox('#showNoDueCheckbox', fields.showNoDue);
  if (fields.noDueDatesAtEnd != null) {
    await setCheckbox('#noDueDatesAtEndCheckbox', fields.noDueDatesAtEnd);
  }
}

/** Open the panel's profile dropdown menu (a custom widget, not a native `<select>`). */
async function openProfileMenu(win: Page): Promise<Frame> {
  const frame = await agendaPanel(win);
  const menu = frame.locator('#profileMenu');
  if (!(await menu.isVisible().catch(() => false))) {
    await frame.locator('#profileControls .dropdown-toggle').first().click();
    await menu.waitFor({ state: 'visible', timeout: 5000 });
  }
  return frame;
}

/**
 * Create a profile using the profile dropdown's "+ New profile..." action, fill the form and confirm.
 *
 * The editor is a Joplin dialog: its fields live in an iframe, but its Cancel/Create buttons are
 * rendered by Joplin in the main window, outside the iframe.
 */
export async function createProfile(win: Page, fields: ProfileFields): Promise<void> {
  const frame = await openProfileMenu(win);
  // Target the action by its handler, not its label, so it is never confused with a profile that
  // happens to be named "New Profile" (the editor's default name for a fresh profile).
  await frame.locator('#profileMenu .dropdown-item[onclick*="createProfileClicked"]').click();
  const editor = await editorFrame(win);
  await fillProfileForm(editor, fields);
  await win.locator('button:has-text("Create")').last().click();
  await win.waitForTimeout(SETTLE);
}

/** Edit the currently selected profile using its "Edit profile" row action in the dropdown. */
export async function editCurrentProfile(win: Page, fields: ProfileFields): Promise<void> {
  const frame = await openProfileMenu(win);
  await frame.locator('#profileMenu .dropdown-item.-current button[title="Edit profile"]').click();
  const editor = await editorFrame(win);
  await fillProfileForm(editor, fields);
  await win.locator('button:has-text("Save")').last().click();
  await win.waitForTimeout(SETTLE);
}

/** Read the profile names listed in the panel's dropdown, in order. */
export async function profileNames(win: Page): Promise<string[]> {
  const frame = await agendaPanel(win);
  // The dropdown is rendered with its menu hidden, so read textContent rather than innerText (which
  // is empty for hidden elements). Only real profile rows carry the `profilesDropdownChanged` action;
  // the trailing "+ New profile..." row is a different action and is excluded.
  const labels = await frame
    .locator('#profileMenu .dropdown-item[onclick*="profilesDropdownChanged"] .dropdown-label')
    .allTextContents();
  return labels.map((l) => l.trim());
}

/** The name of the profile currently selected, shown on the dropdown's toggle. */
export async function selectedProfileName(win: Page): Promise<string> {
  const frame = await agendaPanel(win);
  return (await frame.locator('#profileControls .dropdown-toggle-label').first().innerText()).trim();
}

/** Select a profile by name in the panel dropdown. */
export async function selectProfile(win: Page, name: string): Promise<void> {
  const frame = await openProfileMenu(win);
  await frame
    .locator('#profileMenu .dropdown-item', { hasText: name })
    .locator('.dropdown-label')
    .first()
    .click();
  await win.waitForTimeout(SETTLE);
}

/** Whether the panel's profile controls (the profile dropdown and create buttons) are visible. */
export async function profileControlsVisible(win: Page): Promise<boolean> {
  const frame = await agendaPanel(win);
  return frame.locator('#profileControls').isVisible();
}

/** ----------------------------------------------------------------------------------------------
 * Calendar views
 * ------------------------------------------------------------------------------------------- */

/** The month or week currently shown above the calendar. */
export async function calendarTitle(win: Page): Promise<string> {
  const frame = await agendaPanel(win);
  return frame.locator('.calendar-title').innerText();
}

/** Step the calendar back or forward by one month or week. */
export async function calendarNavigate(win: Page, direction: 'Previous' | 'Next'): Promise<void> {
  const frame = await agendaPanel(win);
  await frame.locator(`.calendar-nav button[title="${direction}"]`).click();
  await win.waitForTimeout(SETTLE);
}

/** Return the calendar to the current month or week. */
export async function calendarToday(win: Page): Promise<void> {
  const frame = await agendaPanel(win);
  await frame.locator('.calendar-title').click();
  await win.waitForTimeout(SETTLE);
}

/** The weekday column headings of the month grid, in display order. */
export async function calendarWeekdayHeadings(win: Page): Promise<string[]> {
  const frame = await agendaPanel(win);
  return frame.locator('.calendar-grid thead th').allInnerTexts();
}

/** Click the day cell showing the given day number, within the anchored month. */
export async function selectCalendarDay(win: Page, dayNumber: number): Promise<void> {
  const frame = await agendaPanel(win);
  await frame
    .locator('.calendar-day:not(.-outside) .calendar-day-button')
    .filter({ has: frame.locator(`.calendar-day-number:text-is("${dayNumber}")`) })
    .first()
    .click();
  await win.waitForTimeout(SETTLE);
}

/** The to-do titles listed under the month grid for the selected day. */
export async function selectedDayTodos(win: Page): Promise<string[]> {
  const frame = await agendaPanel(win);
  return (await frame.locator('.calendar-selected .todo-title').allTextContents()).map((t) =>
    t.trim()
  );
}

/** The day headings of the week planner, in display order. */
export async function weekPlannerDays(win: Page): Promise<string[]> {
  const frame = await agendaPanel(win);
  return frame.locator('.week-day h2').allInnerTexts();
}

/** ----------------------------------------------------------------------------------------------
 * Commands and note content
 * ------------------------------------------------------------------------------------------- */

/**
 * The text of the rendered note viewer, which is how the body of the currently selected note is
 * read without depending on the internals of the markdown editor.
 */
export async function noteViewerText(win: Page): Promise<string> {
  for (const frame of win.frames()) {
    if (frame.url().includes('note-viewer/index.html')) {
      return frame
        .locator('body')
        .innerText()
        .catch(() => '');
    }
  }
  return '';
}
