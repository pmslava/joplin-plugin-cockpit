import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { execSync } from 'child_process';
import type { Frame, Page } from 'playwright';
import { launchJoplin, closeJoplin, createProfile, JoplinInstance, E2E_PATHS, PLUGIN_ID } from './launch';

/**
 * Opt-in performance check: Joplin with a large collection, measured without and with Cockpit.
 *
 * Not part of the regular suite (it seeds tens of thousands of notes and watches each launch for minutes), so it
 * only runs with COCKPIT_PERF=1:
 *
 *   COCKPIT_PERF=1 PERF_NOTES=20000 xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test e2e/perf-large-vault.spec.ts
 *
 * The seeded profile is kept as a template under e2e/.profiles/perf-template-<N>, so later runs skip the seeding.
 * Each measured launch gets its own copy of the template, so every plugin run is a first run on that collection,
 * the situation of the 2026-09-29 forum report. The report is written as JSON to PERF_OUT.
 */

const NOTES = Number(process.env.PERF_NOTES || 20000);
const TODOS = Math.round(NOTES * 0.05);
const FOLDERS = 40;
const WINDOW_MS = Number(process.env.PERF_WINDOW_MS || 180_000);
const PROFILES_ROOT = path.join(E2E_PATHS.REPO_ROOT, 'e2e', '.profiles');
const TEMPLATE = path.join(PROFILES_ROOT, `perf-template-${NOTES}`);
const OUT = process.env.PERF_OUT || path.join(PROFILES_ROOT, `perf-report-${NOTES}.json`);
const API_TOKEN = 'cockpit-perf';
const API_PORT = 41207;
// Every seeded body carries this token, so one full-text search can tell when the index holds them all.
const SEED_TOKEN = 'perfseedtoken';

test.describe.configure({ mode: 'serial' });
test.skip(!process.env.COCKPIT_PERF, 'performance check, runs only with COCKPIT_PERF=1');

function apiRequest(method: string, urlPath: string, body?: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      {
        host: '127.0.0.1',
        port: API_PORT,
        method,
        path: urlPath + (urlPath.includes('?') ? '&' : '?') + `token=${API_TOKEN}`,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      (response) => {
        let text = '';
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => resolve({ status: response.statusCode || 0, text }));
      }
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function post(urlPath: string, body: unknown): Promise<any> {
  const made = await apiRequest('POST', urlPath, body);
  if (made.status !== 200) throw new Error(`POST ${urlPath} refused: ${made.status} ${made.text}`);
  return JSON.parse(made.text);
}

async function apiReady(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await apiRequest('GET', '/ping')).status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('the data API never answered');
}

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer posuere erat a ante venenatis dapibus posuere velit ' +
  'aliquet. Cras mattis consectetur purus sit amet fermentum. Vestibulum id ligula porta felis euismod semper. Donec ' +
  'ullamcorper nulla non metus auctor fringilla. Maecenas faucibus mollis interdum. Nullam quis risus eget urna mollis ';

/** A body of roughly 1 KB; every fifth one carries a short checklist, as real task notes do. */
function bodyFor(i: number): string {
  let body = `${SEED_TOKEN} item ${i}\n\n${LOREM}\n\n${LOREM}\n`;
  if (i % 5 === 0) body += '\n- [x] first step\n- [ ] second step\n- [ ] third step\n';
  return body;
}

/** Runs `work` over 0..count-1 with `width` requests in flight. */
async function pool(count: number, width: number, work: (i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: width }, async () => {
    while (next < count) {
      const i = next++;
      await work(i);
    }
  });
  await Promise.all(lanes);
}

async function seedTemplate(): Promise<void> {
  const profileDir = createProfile(false, { 'clipperServer.autoStart': true, 'api.token': API_TOKEN, 'api.port': API_PORT });
  const joplin = await launchJoplin({ profileDir });
  try {
    await apiReady();
    const folderIds: string[] = [];
    for (let f = 0; f < FOLDERS; f++) folderIds.push((await post('/folders', { title: `Perf notebook ${f}` })).id);
    const started = Date.now();
    const day = 24 * 3600 * 1000;
    await pool(NOTES + TODOS, 8, async (i) => {
      const parent_id = folderIds[i % FOLDERS];
      if (i < NOTES) {
        await post('/notes', { title: `Perf note ${i}`, body: bodyFor(i), parent_id });
      } else {
        const t = i - NOTES;
        // 40% overdue, 40% upcoming, 20% undated; a third of them completed.
        const due = t % 5 < 2 ? Date.now() - (1 + (t % 90)) * day : t % 5 < 4 ? Date.now() + (1 + (t % 90)) * day : 0;
        const completed = t % 3 === 0 ? Date.now() - day : 0;
        await post('/notes', { title: `Perf todo ${t}`, body: bodyFor(i), parent_id, is_todo: 1, todo_due: due, todo_completed: completed });
      }
      if ((i + 1) % 2000 === 0) console.log(`seeded ${i + 1} in ${Math.round((Date.now() - started) / 1000)}s`);
    });
    console.log(`seeded ${NOTES + TODOS} items in ${Math.round((Date.now() - started) / 1000)}s; waiting for the search index`);
    // The index catches up on Joplin's own 10 s timer. Ask for the page that must hold the last seeded item: once it
    // holds the right count, every item is searchable, and the measured launches start from a settled index.
    const total = NOTES + TODOS;
    const lastPage = Math.ceil(total / 100);
    const expectOnLast = total - (lastPage - 1) * 100;
    const deadline = Date.now() + 20 * 60_000;
    for (;;) {
      const got = await apiRequest('GET', `/search?query=${SEED_TOKEN}&fields=id&limit=100&page=${lastPage}`);
      const items = got.status === 200 ? JSON.parse(got.text).items || [] : [];
      if (items.length === expectOnLast) break;
      if (Date.now() > deadline) throw new Error(`the search index never caught up (last page holds ${items.length})`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
    console.log(`index settled ${Math.round((Date.now() - started) / 1000)}s after the seeding started`);
  } finally {
    await closeJoplin(joplin, { keepProfile: true });
  }
  fs.renameSync(profileDir, TEMPLATE);
}

function processTreeRssMb(pgid: number): number {
  try {
    const out = execSync(`ps -o rss= -g ${pgid}`, { encoding: 'utf8' });
    return Math.round(out.split('\n').reduce((sum, line) => sum + (Number(line.trim()) || 0), 0) / 1024);
  } catch {
    return 0;
  }
}

/** RSS of every process in the tree, largest first, labelled by Chromium process type. */
function processBreakdown(pgid: number): Array<{ type: string; rssMb: number }> {
  try {
    const out = execSync(`ps -o rss=,args= -g ${pgid}`, { encoding: 'utf8' });
    return out
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const [rss, ...args] = line.trim().split(/\s+/);
        const typeArg = args.find((a) => a.startsWith('--type='));
        const type = typeArg ? typeArg.slice(7) + (args.some((a) => a.startsWith('--utility-sub-type=')) ? ':' + args.find((a) => a.startsWith('--utility-sub-type='))!.split('=')[1].split('.').pop() : '') : 'main';
        return { type, rssMb: Math.round(Number(rss) / 1024) };
      })
      .sort((a, b) => b.rssMb - a.rssMb);
  } catch {
    return [];
  }
}

async function findPanel(win: Page): Promise<Frame | null> {
  for (const frame of win.frames()) {
    if (frame.url().includes(PLUGIN_ID) && frame.url().includes('panel')) return frame;
  }
  const handle = await win.$(`iframe[id="plugin-view-${PLUGIN_ID}-panel"]`).catch(() => null);
  return handle ? await handle.contentFrame() : null;
}

/** Resolves to the value, or to `fallback` when the renderer does not answer within `ms`. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

async function measure(withPlugin: boolean): Promise<Record<string, unknown>> {
  const profileDir = path.join(PROFILES_ROOT, `perf-run-${withPlugin ? 'plugin' : 'bare'}-${Date.now()}`);
  fs.cpSync(TEMPLATE, profileDir, { recursive: true });
  const settingsPath = path.join(profileDir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (withPlugin) settings['plugins.devPluginPaths'] = E2E_PATHS.PLUGIN_DIST;
  else delete settings['plugins.devPluginPaths'];
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  const launchedAt = Date.now();
  let joplin: JoplinInstance | null = null;
  const samples: Array<Record<string, number>> = [];
  let firstRowsAt = -1;
  let notesSectionAt = -1;
  let heartbeat: any = null;
  try {
    joplin = await launchJoplin({ profileDir });
    const readyMs = Date.now() - launchedAt;
    // The window starts once the UI is up, so a slow (or retried) launch does not eat into the time the plugin is watched for.
    const windowStart = Date.now();
    const { win, child } = joplin;
    // A 100 ms heartbeat in the main window: any gap well past 100 ms is time the window could not react to input.
    // Long tasks are recorded as well, for the share of the lag that is single blocking chunks of work.
    await win.evaluate(() => {
      const hb: any = { last: performance.now(), maxGap: 0, lagMs: 0, gapsOver1s: 0, longTaskMs: 0, longTasks: 0 };
      (window as any).__perfHb = hb;
      setInterval(() => {
        const now = performance.now();
        const gap = now - hb.last;
        hb.last = now;
        if (gap > hb.maxGap) hb.maxGap = gap;
        if (gap > 150) hb.lagMs += gap - 100;
        if (gap > 1000) hb.gapsOver1s++;
      }, 100);
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            hb.longTaskMs += entry.duration;
            hb.longTasks++;
          }
        }).observe({ entryTypes: ['longtask'] });
      } catch {
        /* longtask timing unavailable */
      }
    });
    while (Date.now() - windowStart < WINDOW_MS) {
      const probeStart = Date.now();
      const answered = await within(win.evaluate(() => 1), 30_000, 0);
      const probeMs = Date.now() - probeStart;
      let rows = 0;
      let domNodes = 0;
      if (withPlugin) {
        const panel = await within(findPanel(win), 10_000, null);
        if (panel) {
          const counts = await within(
            panel.evaluate(() => ({
              rows: document.querySelectorAll('[data-todo-id], [data-note-id]').length,
              notes: document.querySelectorAll('.notes-section').length,
              nodes: document.getElementsByTagName('*').length,
            })),
            10_000,
            { rows: 0, notes: 0, nodes: 0 }
          );
          rows = counts.rows;
          domNodes = counts.nodes;
          if (counts.rows > 0 && firstRowsAt < 0) firstRowsAt = Date.now() - windowStart;
          if (counts.notes > 0 && notesSectionAt < 0) notesSectionAt = Date.now() - windowStart;
        }
      }
      samples.push({
        t: Math.round((Date.now() - windowStart) / 1000),
        probeMs: answered ? probeMs : -1,
        rssMb: processTreeRssMb(child.pid!),
        rows,
        domNodes,
      });
      await new Promise((r) => setTimeout(r, 2000));
    }
    heartbeat = await within(win.evaluate(() => (window as any).__perfHb), 60_000, null);
    const processes = processBreakdown(child.pid!);
    // Every window and webview Joplin has open, so a renderer in the breakdown can be told apart (a plugin runs in its own window).
    const pages = joplin.browser.contexts().flatMap((ctx) => ctx.pages().map((pg) => pg.url().replace(/^file:\/\/.*\/(?=[^/]+$)/, '')));
    const mainHeapMb = await within(win.evaluate(() => Math.round(((performance as any).memory?.usedJSHeapSize || 0) / 1048576)), 10_000, -1);
    const probes = samples.map((s) => s.probeMs);
    const report = {
      withPlugin,
      notes: NOTES,
      todos: TODOS,
      windowS: WINDOW_MS / 1000,
      readyMs,
      // Both measured from the moment the UI was up.
      firstRowsAtMs: firstRowsAt,
      notesSectionAtMs: notesSectionAt,
      maxRows: Math.max(0, ...samples.map((s) => s.rows)),
      heartbeat: heartbeat && {
        maxGapMs: Math.round(heartbeat.maxGap),
        lagMs: Math.round(heartbeat.lagMs),
        gapsOver1s: heartbeat.gapsOver1s,
        longTaskMs: Math.round(heartbeat.longTaskMs),
        longTasks: heartbeat.longTasks,
      },
      probeMaxMs: Math.max(...probes),
      probesOver1s: probes.filter((p) => p > 1000 || p < 0).length,
      probesUnanswered: probes.filter((p) => p < 0).length,
      rssPeakMb: Math.max(...samples.map((s) => s.rssMb)),
      rssEndMb: samples.length ? samples[samples.length - 1].rssMb : 0,
      maxDomNodes: Math.max(0, ...samples.map((s) => s.domNodes)),
      mainHeapMb,
      processes,
      pages,
      samples,
    };
    console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));
    return report;
  } finally {
    if (joplin) await closeJoplin(joplin);
    else fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

/** Wall time of one data-API call, in ms. */
async function timed(urlPath: string): Promise<{ ms: number; items: number; hasMore: boolean }> {
  const started = Date.now();
  const got = await apiRequest('GET', urlPath);
  if (got.status !== 200) throw new Error(`GET ${urlPath} refused: ${got.status} ${got.text.slice(0, 200)}`);
  const parsed = JSON.parse(got.text);
  return { ms: Date.now() - started, items: (parsed.items || []).length, hasMore: !!parsed.has_more };
}

// What one page costs on each route, on the bare template (no plugin), so a fix can be chosen by numbers. Only with PERF_API=1.
test('large collection: data-API page costs', async () => {
  test.skip(!process.env.PERF_API, 'API timing, runs only with PERF_API=1');
  test.setTimeout(30 * 60_000);
  if (!fs.existsSync(TEMPLATE)) await seedTemplate();
  const profileDir = path.join(PROFILES_ROOT, `perf-api-${Date.now()}`);
  fs.cpSync(TEMPLATE, profileDir, { recursive: true });
  const joplin = await launchJoplin({ profileDir });
  try {
    await apiReady();
    // Let the startup work (index catch-up, first sync attempt) settle before timing.
    await new Promise((r) => setTimeout(r, 20_000));
    const fields = 'id,title,is_todo,todo_completed,todo_due,parent_id,user_updated_time,user_created_time';
    const results: Record<string, unknown> = {};
    results.searchNotePage1 = await timed(`/search?query=${encodeURIComponent('type:note')}&type=note&fields=${fields}&page=1`);
    results.searchNotePage100 = await timed(`/search?query=${encodeURIComponent('type:note')}&type=note&fields=${fields}&page=100`);
    results.searchNoteRecentPage1 = await timed(`/search?query=${encodeURIComponent('type:note')}&type=note&fields=${fields}&order_by=user_updated_time&order_dir=DESC&page=1`);
    results.searchTodoPage1 = await timed(`/search?query=${encodeURIComponent('type:todo')}&type=note&fields=${fields}&order_by=todo_due&page=1`);
    results.searchTextPage1 = await timed(`/search?query=${encodeURIComponent('ipsum')}&type=note&fields=${fields}&page=1`);
    results.listPage1 = await timed(`/notes?fields=${fields}&order_by=id&limit=100&page=1`);
    results.listPage150 = await timed(`/notes?fields=${fields}&order_by=id&limit=100&page=150`);
    const listStart = Date.now();
    let page = 1;
    let listed = 0;
    for (;;) {
      const one = await timed(`/notes?fields=${fields}&order_by=id&limit=100&page=${page++}`);
      listed += one.items;
      if (!one.hasMore) break;
    }
    results.listAll = { ms: Date.now() - listStart, items: listed, pages: page - 1 };
    const searchStart = Date.now();
    page = 1;
    let searched = 0;
    for (;;) {
      const one = await timed(`/search?query=${encodeURIComponent('type:todo')}&type=note&fields=${fields}&order_by=todo_due&page=${page++}`);
      searched += one.items;
      if (!one.hasMore) break;
    }
    results.searchAllTodos = { ms: Date.now() - searchStart, items: searched, pages: page - 1 };
    console.log(JSON.stringify(results, null, 2));
    fs.writeFileSync(OUT.replace(/\.json$/, '-api.json'), JSON.stringify(results, null, 2));
  } finally {
    await closeJoplin(joplin);
  }
});

test('large collection: Joplin without and with Cockpit', async () => {
  test.skip(!!process.env.PERF_API, 'the launch comparison is skipped while timing the API');
  test.setTimeout(60 * 60_000);
  if (!fs.existsSync(TEMPLATE)) await seedTemplate();
  // PERF_SKIP_BARE=1 re-measures only the plugin, against a baseline already on record.
  const bare = process.env.PERF_SKIP_BARE ? null : await measure(false);
  const plugin = await measure(true);
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), bare, plugin }, null, 2));
  console.log(`report written to ${OUT}`);
});
