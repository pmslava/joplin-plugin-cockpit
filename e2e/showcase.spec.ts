import { test } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  agendaPanel,
  createNotebook,
  createTodo,
  editCurrentProfile,
  refreshPanel,
  setAlarm,
  PANEL_IFRAME,
} from './helpers';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Not an assertion suite: this populates a realistic month and captures the panel views so the
 * layout can be looked at, and so the README screenshots can be regenerated.
 *
 * It asserts nothing and takes a couple of minutes, so it is skipped unless asked for:
 *
 *     SHOWCASE=1 npx playwright test e2e/showcase.spec.ts
 */
test.describe('Calendar showcase', () => {
  test.skip(!process.env.SHOWCASE, 'Set SHOWCASE=1 to capture the panel screenshots');

  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('capture the calendar views', async () => {
    const { win } = joplin;
    const outDir = path.join(__dirname, '..', 'test-results');
    fs.mkdirSync(outDir, { recursive: true });
    const day = (offset: number, hour: number) => {
      const date = new Date();
      date.setDate(date.getDate() + offset);
      date.setHours(hour, offset % 2 ? 30 : 0, 0, 0);
      return date;
    };

    await createNotebook(win, 'Showcase');

    // Two overdue, several stacked on today to show the dot cap, and a few spread through the month.
    const plan: Array<[string, Date]> = [
      ['Pay the rent', day(-3, 9)],
      ['Chase invoice', day(-1, 16)],
      ['Standup', day(0, 9)],
      ['Dentist appointment', day(0, 11)],
      ['Review pull request', day(0, 14)],
      ['Call the plumber', day(0, 16)],
      ['Buy birthday present', day(0, 18)],
      ['Team retrospective', day(2, 11)],
      ['Book flights', day(6, 8)],
      ['Renew passport', day(11, 10)],
    ];
    for (const [title, when] of plan) {
      await createTodo(win, title);
      await setAlarm(win, when);
    }

    // Mark the last one done so a completed day renders muted.
    await win.locator('.note-list-item .content.-selected .checkbox input').first().click();
    await win.waitForTimeout(1500);

    for (let attempt = 0; attempt < 4; attempt++) await refreshPanel(win);

    await editCurrentProfile(win, { displayFormat: 'interval' });
    for (let attempt = 0; attempt < 2; attempt++) await refreshPanel(win);
    await win.locator(PANEL_IFRAME).screenshot({ path: path.join(outDir, 'showcase-list.png') });

    await editCurrentProfile(win, { displayFormat: 'month' });
    for (let attempt = 0; attempt < 3; attempt++) await refreshPanel(win);
    await win.locator(PANEL_IFRAME).screenshot({ path: path.join(outDir, 'showcase-month.png') });

    await editCurrentProfile(win, { displayFormat: 'week' });
    for (let attempt = 0; attempt < 2; attempt++) await refreshPanel(win);
    await win.locator(PANEL_IFRAME).screenshot({ path: path.join(outDir, 'showcase-week.png') });
  });
});
