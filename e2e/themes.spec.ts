import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as sqlite3 from 'sqlite3';
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

async function addThemeProbe(panel: import('@playwright/test').Frame): Promise<void> {
  await panel.locator('body').evaluate((body) => {
    const probe = document.createElement('div');
    probe.id = 'theme-probe';
    probe.className = 'todos';
    probe.innerHTML = [
      '<h2>TODAY</h2>',
      '<div class="todo -selected"><span class="todo-title">Selected</span></div>',
      '<div class="calendar-day -selected"><button class="calendar-day-button">15</button></div>',
    ].join('');
    body.appendChild(probe);
  });
}

async function setPluginSetting(
  profileDir: string,
  key: string,
  value: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const database = new sqlite3.Database(path.join(profileDir, 'database.sqlite'));
    database.run(
      'INSERT OR REPLACE INTO settings (`key`, `value`) VALUES (?, ?)',
      [`plugin-io.github.pmslava.cockpit.${key}`, value],
      (error) => {
        database.close((closeError) => {
          if (error || closeError) reject(error || closeError);
          else resolve();
        });
      }
    );
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

    // The Dark restoration is deliberately semantic rather than a global selector rollback. These
    // probes ensure Light keeps its high-contrast scheme-2 heading and current-item pair.
    await addThemeProbe(panel);
    const heading = await computedColours(panel.locator('#theme-probe h2'));
    expect(heading.color).toBe(body.color);
    expect(contrastRatio(heading.color, body.backgroundColor)).toBeGreaterThanOrEqual(4.5);
    const selectedTodo = await computedColours(panel.locator('#theme-probe .todo.-selected'));
    expect(selectedTodo).toEqual({
      color: 'rgb(255, 255, 255)',
      backgroundColor: 'rgb(19, 19, 19)',
    });
    expect(contrastRatio(selectedTodo.color, selectedTodo.backgroundColor)).toBeGreaterThanOrEqual(
      4.5
    );
  });
});

test.describe('Dark preset', () => {
  let joplin: JoplinInstance;
  let bootstrap: JoplinInstance | undefined;
  let profileDir: string;

  test.beforeAll(async () => {
    profileDir = createProfile(true);
    const settingsPath = path.join(profileDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.theme = 2;
    settings.themeAutoDetect = false;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

    // Plugin settings use Joplin's database storage. Let Cockpit register the key once, persist the
    // preset in the throwaway database, then restart against that same isolated profile.
    bootstrap = await launchJoplin({ profileDir });
    await closeJoplin(bootstrap, { keepProfile: true });
    bootstrap = undefined;
    await setPluginSetting(profileDir, 'themeMode', 'dark');
    joplin = await launchJoplin({ profileDir });
  });

  test.afterAll(async () => {
    if (joplin) {
      await closeJoplin(joplin);
    } else if (bootstrap) {
      await closeJoplin(bootstrap);
    } else if (profileDir) {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });

  test('restores the former muted heading and neutral selection', async () => {
    const panel = await agendaPanel(joplin.win);
    const body = await computedColours(panel.locator('body'));
    expect(body.backgroundColor).toBe('rgb(24, 26, 29)');

    await addThemeProbe(panel);
    const heading = await computedColours(panel.locator('#theme-probe h2'));
    expect(heading.color).toBe('rgb(153, 153, 153)');

    const selectedTodo = await computedColours(panel.locator('#theme-probe .todo.-selected'));
    expect(selectedTodo).toEqual({
      color: 'rgb(221, 221, 221)',
      backgroundColor: 'rgb(97, 97, 97)',
    });
    expect(contrastRatio(selectedTodo.color, selectedTodo.backgroundColor)).toBeGreaterThanOrEqual(
      4.5
    );

    const selectedDay = await computedColours(
      panel.locator('#theme-probe .calendar-day-button')
    );
    expect(selectedDay).toEqual(selectedTodo);
  });
});
