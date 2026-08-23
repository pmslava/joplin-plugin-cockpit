import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance, PLUGIN_ID } from './launch';
import {
  agendaPanel,
  createNotebook,
  createTodo,
  panelIsPresent,
  panelIsVisible,
  profileNames,
} from './helpers';

/**
 * Verifies the plugin is actually loaded and running in a real Joplin instance:
 *  - its background webview page exists (CDP), proving the plugin runtime started,
 *  - the panel is rendered with its default profile, and
 *  - the toolbar button is registered once a to-do is open in the editor.
 *
 * The panel rendering check is the one that would have caught the module resolution bug where the
 * webview script was bundled in place of the plugin module, leaving the plugin dead on startup.
 */
test.describe('Plugin loads', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('plugin background page is running (CDP)', async () => {
    await expect
      .poll(
        () => {
          const urls: string[] = [];
          for (const ctx of joplin.browser.contexts()) {
            for (const p of ctx.pages()) urls.push(p.url());
          }
          return urls.some((u) => u.includes(`pluginId=${PLUGIN_ID}`));
        },
        { timeout: 30_000 }
      )
      .toBe(true);
  });

  test('the panel is rendered', async () => {
    const { win } = joplin;
    await expect.poll(() => panelIsPresent(win), { timeout: 60_000 }).toBe(true);

    const panel = await agendaPanel(win);
    // The panel header is the profile picker (showing the default profile's name) plus the New
    // note / New to-do create buttons — a rendered panel, not a dead webview.
    await expect(panel.locator('#profileControls .dropdown-toggle-label')).toHaveText(
      'All todo and notes'
    );
    await expect(panel.locator('#profileControls button[title="New to-do"]')).toBeVisible();
  });

  test('a default profile exists on a fresh install', async () => {
    expect(await profileNames(joplin.win)).toEqual(['All todo and notes']);
  });

  /**
   * The profile row is one line at every width: the create buttons shorten and then drop their labels rather
   * than wrapping or being clipped. Which stage fits is measured in the webview (applyCreateButtonStage),
   * because the row's content width scales with Joplin's font-size setting. Here that measurement is checked
   * against the REAL panel at its real width: no horizontal overflow.
   */
  test('the create buttons fit the profile row without overflowing', async () => {
    const panel = await agendaPanel(joplin.win);
    const row = await panel.evaluate(() => {
      const el = document.getElementById('profileControls')!;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    expect(row.clientWidth).toBeGreaterThan(0);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
  });

  test('the profile buttons use inline icons rather than an icon font', async () => {
    const panel = await agendaPanel(joplin.win);
    // Font Awesome is not available in plugin webviews on mobile, so the icons must be inline SVG.
    await expect(panel.locator('#profileControls button[title="New to-do"] svg')).toBeVisible();
    expect(await panel.locator('.todos i.fa').count()).toBe(0);
  });

  test('the Cockpit toolbar button is registered', async () => {
    const { win } = joplin;
    await createNotebook(win, 'Loads NB');
    await createTodo(win, 'Loads Todo ' + Date.now());

    // Registered by the plugin against the note toolbar; only present when a note is open.
    await expect(win.locator('button[title="Toggle Cockpit Panel"]')).toBeVisible({
      timeout: 20_000,
    });
  });

  test('the toolbar button hides and shows the panel', async () => {
    const { win } = joplin;
    const button = win.locator('button[title="Toggle Cockpit Panel"]');

    // The button is dispatched to rather than clicked: under the virtual display used in CI the
    // panel iframe sits over the note toolbar, so Playwright's hit testing refuses a real click.
    // The dispatched event still runs the same React handler and therefore the same plugin command.
    await expect.poll(() => panelIsVisible(win), { timeout: 30_000 }).toBe(true);

    await button.dispatchEvent('click');
    await expect.poll(() => panelIsVisible(win), { timeout: 30_000 }).toBe(false);

    await button.dispatchEvent('click');
    await expect.poll(() => panelIsVisible(win), { timeout: 30_000 }).toBe(true);
  });
});
