import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { agendaPanel } from './helpers';
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

test.describe('Light theme', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    const profileDir = createProfile(true);
    const settingsPath = path.join(profileDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.theme = 1;
    settings.themeAutoDetect = false;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    joplin = await launchJoplin({ profileDir });
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('panel and content controls use readable matching colour pairs', async () => {
    const panel = await agendaPanel(joplin.win);
    const appearance = await panel.locator(':root').evaluate((element) =>
      getComputedStyle(element).getPropertyValue('--joplin-appearance').trim()
    );
    expect(appearance).toBe('light');

    // Cockpit paints its panel with Joplin's scheme-2/sidebar background. This assertion caught the
    // original regression: scheme-1 text (#32373f) on scheme-2 background (#313640), just 1.01:1.
    const body = await computedColours(panel.locator('body'));
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
  });
});
