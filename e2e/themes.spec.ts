import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
  agendaPanel,
  createNote,
  createNotebook,
  PANEL_REFRESH_TIMEOUT,
} from './helpers';
import { closeJoplin, createProfile, JoplinInstance, launchJoplin } from './launch';

interface ComputedColours {
  color: string;
  backgroundColor: string;
}

function rgbChannels(value: string): [number, number, number] {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) {
    throw new Error(`Could not parse computed colour: ${value}`);
  }
  return channels as [number, number, number];
}

function relativeLuminance(value: string): number {
  const linear = rgbChannels(value).map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

async function computedColours(locator: import('@playwright/test').Locator): Promise<ComputedColours> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, backgroundColor: style.backgroundColor };
  });
}

async function selectRegularNote(
  panel: import('@playwright/test').Frame,
  title: string
): Promise<import('@playwright/test').Locator> {
  const row = panel.locator('.notes-section .todo.-note', { hasText: title });
  await expect(row).toBeVisible({ timeout: PANEL_REFRESH_TIMEOUT });
  await row.locator('.todo-title').click();
  await expect(row).toHaveClass(/(?:^|\s)-selected(?:\s|$)/);
  return row;
}

test.describe('Light theme', () => {
  let joplin: JoplinInstance;
  const noteTitle = `Light theme note ${Date.now()}`;

  test.beforeAll(async () => {
    const profileDir = createProfile(true);
    const settingsPath = path.join(profileDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.theme = 1;
    settings.themeAutoDetect = false;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    joplin = await launchJoplin({ profileDir });
    await createNotebook(joplin.win, 'Cockpit Light Theme E2E');
    await createNote(joplin.win, noteTitle);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('panel and content controls use readable matching colour pairs', async () => {
    const panel = await agendaPanel(joplin.win);
    await expect(panel.locator('html')).not.toHaveClass(/cockpit-dark-appearance/);
    // Cockpit paints its panel with Joplin's scheme-2/sidebar background. This assertion caught the
    // original regression: scheme-1 text (#32373f) on scheme-2 background (#313640), just 1.01:1.
    // The exact pair also proves the throwaway profile loaded Joplin Light; Joplin 3.6 does not
    // expose --joplin-appearance inside plugin webviews.
    const body = await computedColours(panel.locator('body'));
    expect(body).toEqual({
      color: 'rgb(255, 255, 255)',
      backgroundColor: 'rgb(49, 54, 64)',
    });
    expect(contrastRatio(body.color, body.backgroundColor)).toBeGreaterThanOrEqual(4.5);

    // The profile picker is a scheme-4/content surface. Pinning the panel foreground must not turn
    // controls and popup surfaces white-on-white while fixing the surrounding panel.
    const profilePicker = await computedColours(
      panel.locator('#profileControls .dropdown-toggle').first()
    );
    expect(contrastRatio(profilePicker.color, profilePicker.backgroundColor)).toBeGreaterThanOrEqual(
      4.5
    );

    await panel.locator('#profileControls .dropdown-toggle').first().click();
    const profileMenu = panel.locator('#profileMenu');
    await expect(profileMenu).toBeVisible();
    const menu = await computedColours(profileMenu);
    expect(contrastRatio(menu.color, menu.backgroundColor)).toBeGreaterThanOrEqual(4.5);
    await panel.locator('#profileControls .dropdown-toggle').first().click();
    await expect(profileMenu).toBeHidden();

    // Exercise the real regular-note markup and its mousedown selection handler, rather than an
    // injected element that merely happens to carry the same CSS classes.
    const row = await selectRegularNote(panel, noteTitle);
    const heading = await computedColours(panel.locator('.notes-section > h2'));
    expect(heading).toEqual({
      color: 'rgb(255, 255, 255)',
      backgroundColor: 'rgb(49, 54, 64)',
    });
    expect(contrastRatio(heading.color, heading.backgroundColor)).toBeGreaterThanOrEqual(4.5);

    const selectedNote = await computedColours(row);
    expect(selectedNote).toEqual({
      color: 'rgb(255, 255, 255)',
      backgroundColor: 'rgb(19, 19, 19)',
    });
    const selectedTitle = await computedColours(row.locator('.todo-title'));
    expect(selectedTitle.color).toBe(selectedNote.color);
    expect(contrastRatio(selectedTitle.color, selectedNote.backgroundColor)).toBeGreaterThanOrEqual(
      4.5
    );
  });
});

test.describe('Dark theme', () => {
  let joplin: JoplinInstance;
  const noteTitle = `Dark theme note ${Date.now()}`;

  test.beforeAll(async () => {
    const profileDir = createProfile(true);
    const settingsPath = path.join(profileDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.theme = 2;
    settings.themeAutoDetect = false;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    joplin = await launchJoplin({ profileDir });
    await createNotebook(joplin.win, 'Cockpit Dark Theme E2E');
    await createNote(joplin.win, noteTitle);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('Match Joplin restores the former muted heading and neutral note selection', async () => {
    const panel = await agendaPanel(joplin.win);
    await expect(panel.locator('html')).toHaveClass(/cockpit-dark-appearance/);
    const body = await computedColours(panel.locator('body'));
    expect(body).toEqual({
      color: 'rgb(255, 255, 255)',
      backgroundColor: 'rgb(24, 26, 29)',
    });
    expect(contrastRatio(body.color, body.backgroundColor)).toBeGreaterThanOrEqual(4.5);

    const row = await selectRegularNote(panel, noteTitle);
    const heading = await computedColours(panel.locator('.notes-section > h2'));
    expect(heading).toEqual({
      color: 'rgb(153, 153, 153)',
      backgroundColor: 'rgb(24, 26, 29)',
    });
    expect(contrastRatio(heading.color, heading.backgroundColor)).toBeGreaterThanOrEqual(4.5);

    const selectedNote = await computedColours(row);
    expect(selectedNote).toEqual({
      color: 'rgb(221, 221, 221)',
      backgroundColor: 'rgb(97, 97, 97)',
    });
    const selectedTitle = await computedColours(row.locator('.todo-title'));
    expect(selectedTitle.color).toBe(selectedNote.color);
    expect(contrastRatio(selectedTitle.color, selectedNote.backgroundColor)).toBeGreaterThanOrEqual(
      4.5
    );
  });
});
