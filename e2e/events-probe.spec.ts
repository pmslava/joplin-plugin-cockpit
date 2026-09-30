import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { launchJoplin, closeJoplin, createProfile, JoplinInstance, E2E_PATHS } from './launch';
import { callPluginCommand } from './helpers';

/**
 * Cockpit 2.7, phase 1: the change-feed probe. No product code; this proves how Joplin's change feed,
 * `joplin.data.get(['events'], { cursor })`, behaves for a PLUGIN, in a real Joplin, before the local note mirror
 * is built on it (docs/BRIEF-2.7-local-mirror.md, sections 4 and 6).
 *
 * Cockpit itself is NOT loaded. A throwaway dev plugin, e2e/fixtures/events-probe (plain JS, no build), registers one
 * command, `eventsProbe.call`, that this spec executes with a plain-object argument through the app's CommandService
 * (so every launch here is `--env dev`) and whose return value comes back to the spec. As a fallback channel the
 * probe also writes each answer into a note titled `events-probe-result`, read over REST if a return value ever comes
 * back undefined; that note's own change rows are excluded from every assertion by id.
 *
 * Changes are made from OUTSIDE through Joplin's REST data API (the clipper server on a port no other spec uses), and
 * the feed is read from INSIDE the plugin sandbox. Scenario 5 adds a filesystem sync target shared by two profiles.
 *
 * Opt-in, like the perf spec: it launches Joplin five times and only records findings, so it runs only with
 * COCKPIT_PROBE=1:
 *
 *   COCKPIT_PROBE=1 xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test e2e/events-probe.spec.ts --retries=0 --global-timeout=2700000
 *
 * Every scenario records its raw observations into one `findings` object, printed at the end and written to
 * e2e/.profiles/events-probe-findings.json (after every test too, so a failed run still leaves what it saw). Checks
 * are collected per scenario and asserted at the END of each test, so one wrong expectation never hides the
 * observations after it. The file is serial: a failed scenario skips the ones after it (run one alone with -g).
 *
 * Mobile is not reachable from this harness; nothing here speaks for it.
 */

test.describe.configure({ mode: 'serial' });
test.skip(!process.env.COCKPIT_PROBE, 'change-feed probe, runs only with COCKPIT_PROBE=1');

const PROBE_DIR = path.join(E2E_PATHS.REPO_ROOT, 'e2e', 'fixtures', 'events-probe');
const PROFILES_ROOT = path.join(E2E_PATHS.REPO_ROOT, 'e2e', '.profiles');
const FINDINGS_PATH = path.join(PROFILES_ROOT, 'events-probe-findings.json');
const PROBE_COMMAND = 'eventsProbe.call';
const RESULT_TITLE = 'events-probe-result';
const API_TOKEN = 'cockpit-events-probe';
// Off Joplin's 41184 default and off every other spec's port (41197, 41198, 41199, 41207). One per Joplin role, so a
// relaunch can never meet the previous instance's server.
const PORT_SHARED = 41213; // scenarios 1-4
const PORT_A = 41214; // scenario 5, profile A (no plugin)
const PORT_B = 41215; // scenario 5, profile B (the probe)

const ITEM_TYPE_NOTE = 1;
const TYPE_CREATE = 1;
const TYPE_UPDATE = 2;
const TYPE_DELETE = 3;

interface ChangeRow {
  id: number;
  item_type: number;
  item_id: string;
  type: number;
  created_time: number;
  [key: string]: unknown;
}

interface EventsPage {
  items: ChangeRow[];
  has_more: boolean;
  cursor: string;
}

interface Envelope {
  ok: boolean;
  result?: any;
  error?: string;
  seq?: number | null;
}

const findings: Record<string, any> = {
  startedAt: new Date().toISOString(),
  harness: { probeDir: PROBE_DIR, ports: { shared: PORT_SHARED, a: PORT_A, b: PORT_B } },
  checks: {},
  s6_mobile: 'not reachable by this harness; nothing recorded here',
};

function saveFindings(): void {
  try {
    fs.mkdirSync(PROFILES_ROOT, { recursive: true });
    findings.savedAt = new Date().toISOString();
    fs.writeFileSync(FINDINGS_PATH, JSON.stringify(findings, null, 2));
  } catch (error) {
    console.warn('[events-probe] could not write the findings file:', error);
  }
}

test.afterAll(() => {
  saveFindings();
  console.log(`[events-probe] findings (also in ${FINDINGS_PATH}):\n${JSON.stringify(findings, null, 2)}`);
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `fn` until it answers true or the time is up; answers whether it did. */
async function pollFor(fn: () => Promise<boolean>, timeoutMs: number, intervalMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* not yet */
    }
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/** Checks are collected, recorded with what was seen, and asserted together at the end of a test. */
class Checks {
  readonly list: Array<{ label: string; ok: boolean; detail?: unknown }> = [];

  constructor(readonly name: string) {
    findings.checks[name] = this.list;
  }

  that(label: string, ok: boolean, detail?: unknown): boolean {
    this.list.push(detail === undefined ? { label, ok } : { label, ok, detail });
    if (!ok) console.log(`[events-probe] CHECK FAILED (${this.name}) ${label}: ${JSON.stringify(detail)}`);
    return ok;
  }

  eq(label: string, actual: unknown, expected: unknown): boolean {
    return this.that(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
  }

  assertAll(): void {
    const failed = this.list.filter((check) => !check.ok);
    expect(failed, `${this.name}: ${failed.length} of ${this.list.length} checks failed`).toEqual([]);
  }
}

/** ----------------------------------------------------------------------------------------------
 * Joplin's REST data API, from outside
 * ------------------------------------------------------------------------------------------- */

class DataApi {
  constructor(readonly port: number) {}

  request(method: string, urlPath: string, body?: unknown): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
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

  /** A request that must succeed; answers the parsed JSON (null for an empty body). */
  async json(method: string, urlPath: string, body?: unknown): Promise<any> {
    const got = await this.request(method, urlPath, body);
    if (got.status < 200 || got.status > 299) throw new Error(`${method} ${urlPath} refused: ${got.status} ${got.text.slice(0, 300)}`);
    return got.text ? JSON.parse(got.text) : null;
  }

  /** Waits until OUR Joplin answers with OUR token (a stranger on the port would answer 403). */
  async ready(): Promise<void> {
    for (let attempt = 0; attempt < 90; attempt++) {
      try {
        if ((await this.request('GET', '/folders?limit=1')).status === 200) return;
      } catch {
        /* not up yet */
      }
      await sleep(1000);
    }
    throw new Error(`Joplin's data API never answered with our token on 127.0.0.1:${this.port}`);
  }

  async status(noteId: string): Promise<number> {
    return (await this.request('GET', `/notes/${noteId}?fields=id`)).status;
  }
}

function apiSettings(port: number): Record<string, unknown> {
  return { 'clipperServer.autoStart': true, 'api.token': API_TOKEN, 'api.port': port };
}

/** ----------------------------------------------------------------------------------------------
 * The probe plugin, from the spec's side
 * ------------------------------------------------------------------------------------------- */

class Probe {
  private seq = 0;
  primaryWorks: boolean | null = null;
  fallbackOn = true;
  primaryMisses = 0;
  fallbackReads = 0;
  resultNoteId = '';
  version: unknown = null;

  constructor(private readonly win: Page, private readonly api: DataApi, readonly label: string) {}

  /**
   * Waits for the probe's command, learns whether the return value reaches the spec, finds the result note, and
   * switches the fallback writes off when the primary channel works (they would only add rows to exclude).
   */
  async start(): Promise<void> {
    const deadline = Date.now() + 120_000;
    let lastError = '';
    for (;;) {
      try {
        // Any envelope means the command is registered and answering; a failed versionInfo is only recorded.
        const answer = await this.raw({ op: 'version' });
        this.version = answer.ok ? answer.result : { error: answer.error };
        break;
      } catch (error) {
        // Not registered yet: CommandService throws for an unknown command or one without a runtime.
        lastError = String(error);
      }
      if (Date.now() > deadline) throw new Error(`${this.label}: the probe command never answered: ${lastError}`);
      await sleep(1000);
    }
    this.resultNoteId = String(await this.ok({ op: 'resultNoteId' }));
    if (this.primaryWorks) {
      await this.ok({ op: 'fallback', enabled: false });
      this.fallbackOn = false;
    }
  }

  channel(): Record<string, unknown> {
    return {
      primaryReturnValueWorks: this.primaryWorks,
      fallbackWritesOn: this.fallbackOn,
      primaryMisses: this.primaryMisses,
      fallbackReads: this.fallbackReads,
      resultNoteId: this.resultNoteId,
      calls: this.seq,
    };
  }

  /** One call; the envelope comes from the return value, or from the result note when that is undefined. */
  async raw(args: Record<string, unknown>): Promise<Envelope> {
    const seq = ++this.seq;
    const returned = await callPluginCommand(this.win, PROBE_COMMAND, { ...args, seq });
    if (returned !== undefined && returned !== null) {
      if (this.primaryWorks === null) this.primaryWorks = true;
      return returned as Envelope;
    }
    this.primaryMisses++;
    if (this.primaryWorks === null) this.primaryWorks = false;
    if (!this.fallbackOn) {
      // The return value dropped an answer after all: switch the fallback back on and ask again.
      await callPluginCommand(this.win, PROBE_COMMAND, { op: 'fallback', enabled: true, seq: ++this.seq });
      this.fallbackOn = true;
      return this.raw(args);
    }
    return this.readFallback(seq);
  }

  async ok(args: Record<string, unknown>): Promise<any> {
    const answer = await this.raw(args);
    if (!answer.ok) throw new Error(`${this.label}: probe op ${JSON.stringify(args)} failed: ${answer.error}`);
    return answer.result;
  }

  private async readFallback(seq: number): Promise<Envelope> {
    this.fallbackReads++;
    const deadline = Date.now() + 20_000;
    let last = '';
    while (Date.now() < deadline) {
      if (!this.resultNoteId) this.resultNoteId = await this.findResultNoteOverRest();
      if (this.resultNoteId) {
        const got = await this.api.request('GET', `/notes/${this.resultNoteId}?fields=body`);
        if (got.status === 200) {
          try {
            const parsed = JSON.parse(JSON.parse(got.text).body);
            if (parsed && parsed.seq === seq) return parsed.envelope as Envelope;
            last = `the note holds seq ${parsed && parsed.seq}`;
          } catch (error) {
            last = String(error);
          }
        } else {
          last = `GET result note: ${got.status}`;
        }
      } else {
        last = 'no result note yet';
      }
      await sleep(250);
    }
    throw new Error(`${this.label}: neither channel delivered the answer to call ${seq} (${last})`);
  }

  private async findResultNoteOverRest(): Promise<string> {
    for (let page = 1; page <= 50; page++) {
      const listing = await this.api.json('GET', `/notes?fields=id,title&order_by=id&limit=100&page=${page}`);
      const items: Array<{ id: string; title: string }> = (listing && listing.items) || [];
      const hit = items.find((note) => note.title === RESULT_TITLE);
      if (hit) return hit.id;
      if (!listing || !listing.has_more) break;
    }
    return '';
  }

  async events(query: { cursor?: string | number; fields?: string[]; limit?: number } = {}): Promise<EventsPage> {
    return (await this.ok({ op: 'events', ...query })) as EventsPage;
  }

  /** The feed's current position: a call without a cursor answers lastChangeId. */
  async cursorNow(): Promise<string> {
    return (await this.events()).cursor;
  }

  /** Every page from `cursor` on. */
  async allSince(cursor: string): Promise<{ rows: ChangeRow[]; pages: Array<{ count: number; has_more: boolean; cursor: string }> }> {
    const rows: ChangeRow[] = [];
    const pages: Array<{ count: number; has_more: boolean; cursor: string }> = [];
    let next = cursor;
    for (let page = 0; page < 200; page++) {
      const answer = await this.events({ cursor: next });
      rows.push(...answer.items);
      pages.push({ count: answer.items.length, has_more: answer.has_more, cursor: answer.cursor });
      next = answer.cursor;
      if (!answer.has_more) break;
    }
    return { rows, pages };
  }

  /** The rows that are not the result note's own. */
  subject(rows: ChangeRow[]): ChangeRow[] {
    return rows.filter((row) => row.item_id !== this.resultNoteId);
  }

  /** Polls from `cursor` until `done` holds for the subject rows (the row is written after the save returns). */
  async waitForRows(
    cursor: string,
    done: (rows: ChangeRow[]) => boolean,
    timeoutMs = 15_000
  ): Promise<{ rows: ChangeRow[]; allRows: ChangeRow[]; waitedMs: number; timedOut: boolean }> {
    const started = Date.now();
    for (;;) {
      const { rows } = await this.allSince(cursor);
      const subject = this.subject(rows);
      if (done(subject)) return { rows: subject, allRows: rows, waitedMs: Date.now() - started, timedOut: false };
      if (Date.now() - started > timeoutMs) return { rows: subject, allRows: rows, waitedMs: Date.now() - started, timedOut: true };
      await sleep(200);
    }
  }

  /** For "no row" claims: give any row time to land, then read twice. */
  async quiet(cursor: string, settleMs = 2_000): Promise<{ first: ChangeRow[]; second: ChangeRow[] }> {
    await sleep(settleMs);
    const first = this.subject((await this.allSince(cursor)).rows);
    await sleep(700);
    const second = this.subject((await this.allSince(cursor)).rows);
    return { first, second };
  }
}

const rowsOf = (rows: ChangeRow[], id: string) => rows.filter((row) => row.item_id === id);
const brief = (rows: ChangeRow[]) => rows.map((r) => ({ id: r.id, item_type: r.item_type, item_id: r.item_id, type: r.type }));

/** ----------------------------------------------------------------------------------------------
 * The main window's own view (dev mode publishes window.joplin): sync state and the raw table
 * ------------------------------------------------------------------------------------------- */

/**
 * Counts sync starts and completions in the main window. CommandService keeps the app's Redux store (`store_`), whose
 * `syncStarted` flips on SYNC_STARTED / SYNC_COMPLETED; a store subscription sees every transition, however short the
 * sync. If the store is ever out of reach, the sidebar sync button's `-syncing` class is sampled instead.
 */
async function installSyncWatch(win: Page): Promise<string> {
  return win.evaluate(() => {
    const w = window as any;
    if (w.__eventsProbeSync) return w.__eventsProbeSync.via;
    const store = w.joplin && w.joplin.commandService && w.joplin.commandService.store_;
    const watch: any = { via: store ? 'store' : 'dom', started: 0, completed: 0, syncing: false, reports: [] };
    const syncingNow = () => {
      if (store) return !!store.getState().syncStarted;
      const button = document.querySelector('.sidebar-sync-button');
      return !!(button && button.classList.contains('-syncing'));
    };
    const report = () => {
      if (!store) return null;
      try {
        return JSON.parse(JSON.stringify(store.getState().syncReport || {}, (_k, v) => (v instanceof Error ? String(v) : v)));
      } catch (error) {
        return String(error);
      }
    };
    const step = () => {
      const now = syncingNow();
      if (now && !watch.syncing) watch.started++;
      if (!now && watch.syncing) {
        watch.completed++;
        watch.reports.push(report());
        if (watch.reports.length > 10) watch.reports.shift();
      }
      watch.syncing = now;
    };
    watch.syncing = syncingNow();
    if (store) store.subscribe(step);
    else setInterval(step, 50);
    w.__eventsProbeSync = watch;
    return watch.via;
  });
}

async function syncWatch(win: Page): Promise<{ via: string; started: number; completed: number; syncing: boolean; reports: unknown[] }> {
  return win.evaluate(() => JSON.parse(JSON.stringify((window as any).__eventsProbeSync)));
}

/**
 * Runs a full sync and waits until `satisfied` holds. The synchronize command is a toggle, so it is always called with
 * `false` ("not started": always start, never cancel), and only once the app is idle. Joplin also schedules a partial
 * upload-only sync 15 s after any note change; a manual sync asked for while one runs is dropped ("alreadyStarted"),
 * so an attempt that completes without `satisfied` is simply repeated.
 */
async function syncUntil(
  win: Page,
  label: string,
  satisfied: () => Promise<boolean>,
  probe?: Probe
): Promise<Record<string, any>> {
  const log: Record<string, any> = { label, via: await installSyncWatch(win), attempts: [], satisfied: false };
  const started = Date.now();
  for (let attempt = 1; attempt <= 3 && !log.satisfied; attempt++) {
    await pollFor(async () => !(await syncWatch(win)).syncing, 180_000, 200);
    const before = await syncWatch(win);
    const answer = probe ? await probe.ok({ op: 'sync' }) : await callPluginCommand(win, 'synchronize', false);
    const entry: Record<string, any> = { attempt, answer, askedAtMs: Date.now() - started };
    log.attempts.push(entry);
    if (answer !== 'sync') throw new Error(`${label}: the synchronize command answered ${JSON.stringify(answer)}, not "sync"`);
    // Done when a sync has completed since the ask, or (should the watch ever miss one) when the observable holds.
    entry.completed = false;
    await pollFor(
      async () => {
        const now = await syncWatch(win);
        entry.completed = now.completed > before.completed && !now.syncing;
        return entry.completed || (await satisfied());
      },
      120_000,
      300
    );
    entry.endedAtMs = Date.now() - started;
    entry.satisfied = await pollFor(satisfied, entry.completed ? 15_000 : 1_000, 300);
    log.satisfied = entry.satisfied;
  }
  await pollFor(async () => !(await syncWatch(win)).syncing, 180_000, 200);
  const watch = await syncWatch(win);
  log.syncsStarted = watch.started;
  log.syncsCompleted = watch.completed;
  log.reports = watch.reports;
  log.totalMs = Date.now() - started;
  // Give the app a moment to persist what the sync saved (the sync context is a debounced setting) before any close.
  await sleep(3000);
  return log;
}

/** The raw item_changes rows for these ids, read in the main window: ground truth to set beside the plugin's view. */
async function tableRowsFor(win: Page, itemIds: string[]): Promise<unknown> {
  return win.evaluate(async (ids) => {
    try {
      const db = (window as any).joplin.debug.db;
      const marks = ids.map(() => '?').join(',');
      const rows = await db.selectAll(`SELECT * FROM item_changes WHERE item_id IN (${marks}) ORDER BY id`, ids);
      return rows.map((row: any) => {
        const copy = { ...row };
        delete copy.before_change_item;
        return copy;
      });
    } catch (error) {
      return { error: String(error) };
    }
  }, itemIds);
}

/** The processed-change markers and the table's extent: what pruning could take (id <= min marker AND 90 days old). */
async function pruningSnapshot(win: Page): Promise<unknown> {
  return win.evaluate(async () => {
    try {
      const j = (window as any).joplin;
      const keys = ['resourceService.lastProcessedChangeId', 'searchEngine.lastProcessedChangeId', 'revisionService.lastProcessedChangeId'];
      const markers: Record<string, number> = {};
      for (const key of keys) markers[key] = Number(j.Setting.value(key)) || 0;
      const minProcessed = Math.min(...keys.map((key) => markers[key]));
      const table = await j.debug.db.selectOne(
        'SELECT COUNT(*) AS total, MIN(id) AS minId, MAX(id) AS maxId, MIN(created_time) AS oldestCreated FROM item_changes'
      );
      const processed = await j.debug.db.selectOne('SELECT COUNT(*) AS total FROM item_changes WHERE id <= ?', [minProcessed]);
      return { now: Date.now(), markers, minProcessed, table, rowsAtOrBelowMinProcessed: processed.total };
    } catch (error) {
      return { error: String(error) };
    }
  });
}

/** ================================================================================================
 * Scenarios 1-4: one Joplin with the probe and REST on (every scenario takes its own cursors, so they cannot see
 * each other's rows; one launch instead of four)
 * ============================================================================================= */

test.describe('the change feed from a plugin, on one instance', () => {
  let joplin: JoplinInstance | null = null;
  let api: DataApi;
  let probe: Probe;
  let folderId = '';

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    joplin = await launchJoplin({
      loadPlugin: false,
      envDev: true,
      settings: { ...apiSettings(PORT_SHARED), 'plugins.devPluginPaths': PROBE_DIR },
    });
    api = new DataApi(PORT_SHARED);
    await api.ready();
    probe = new Probe(joplin.win, api, 'shared instance');
    await probe.start();
    findings.version = probe.version;
    findings.channel = probe.channel();
    folderId = (await api.json('POST', '/folders', { title: 'Probe notes' })).id;
    saveFindings();
  });

  test.afterAll(async () => {
    if (probe) findings.channel = probe.channel();
    if (joplin) await closeJoplin(joplin);
    joplin = null;
  });

  test('1. reachability and shape: a plugin reads the events route', async () => {
    const checks = new Checks('s1_shape');
    const out: Record<string, any> = (findings.s1_shape = {});
    try {
      const bare = await probe.raw({ op: 'events' });
      out.noCursorEnvelope = bare;
      checks.that('events without a cursor answers', bare.ok, bare.error);
      const page = (bare.result || {}) as EventsPage;
      out.noCursorKeys = Object.keys(page).sort();
      checks.eq('no cursor: items is []', page.items, []);
      checks.eq('no cursor: has_more is false', page.has_more, false);
      checks.eq('no cursor: the cursor is a string', typeof page.cursor, 'string');
      checks.that('no cursor: the cursor is all digits', /^\d+$/.test(String(page.cursor)), page.cursor);
      const cursor = String(page.cursor);

      // Seven notes: more pending rows than a limit of 5.
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) ids.push((await api.json('POST', '/notes', { title: `s1 note ${i}`, parent_id: folderId })).id);
      const landed = await probe.waitForRows(cursor, (rows) => ids.every((id) => rowsOf(rows, id).length > 0));
      out.sevenRowsLandedMs = landed.waitedMs;
      checks.that('all seven rows landed', !landed.timedOut, brief(landed.rows));

      const full = await probe.events({ cursor });
      const keySets = (items: ChangeRow[]) => Array.from(new Set(items.map((row) => Object.keys(row).sort().join(','))));
      out.defaultKeySets = keySets(full.items);
      out.defaultSample = full.items.slice(0, 2);
      checks.eq('default fields', out.defaultKeySets, ['created_time,id,item_id,item_type,type']);

      const narrowed = await probe.events({ cursor, fields: ['id', 'item_id', 'type'] });
      out.narrowedKeySets = keySets(narrowed.items);
      out.narrowedSample = narrowed.items.slice(0, 2);
      checks.eq('fields narrowed to id, item_id, type', out.narrowedKeySets, ['id,item_id,type']);

      const limited = await probe.events({ cursor, limit: 5 });
      out.limit5 = { items: limited.items.length, subjectItems: probe.subject(limited.items).length, has_more: limited.has_more };
      checks.that('limit=5 is not honoured: the page holds all seven rows', probe.subject(limited.items).length >= 7, out.limit5);

      const numeric = await probe.events({ cursor: Number(cursor) });
      out.numericCursor = { sent: Number(cursor), echoedCursorType: typeof numeric.cursor, rows: numeric.items.length };
      checks.eq(
        'a numeric cursor reads the same rows as the string',
        probe.subject(numeric.items).map((r) => r.id),
        probe.subject(full.items).map((r) => r.id)
      );
      checks.eq('the answer to a numeric cursor still carries a string cursor', typeof numeric.cursor, 'string');
    } finally {
      saveFindings();
    }
    checks.assertAll();
  });

  test('2. single-note lifecycle over REST: create, update, move, type, tag, folder, trash, restore, delete', async () => {
    const checks = new Checks('s2_lifecycle');
    const out: Record<string, any> = (findings.s2_lifecycle = { steps: {} });
    const steps = out.steps;
    try {
      // a. create
      let cursor = await probe.cursorNow();
      const id: string = (await api.json('POST', '/notes', { title: 's2 lifecycle', parent_id: folderId })).id;
      out.noteId = id;
      let seen = await probe.waitForRows(cursor, (rows) => rowsOf(rows, id).length > 0);
      steps.create = { cursor, rows: brief(seen.rows), waitedMs: seen.waitedMs };
      let mine = rowsOf(seen.rows, id);
      checks.eq('create: one row for the note', mine.length, 1);
      checks.eq('create: item_type 1 (note)', mine[0]?.item_type, ITEM_TYPE_NOTE);
      checks.eq('create: type 1', mine[0]?.type, TYPE_CREATE);
      checks.eq('create: no other rows', seen.rows.length - mine.length, 0);

      // b. update the title
      const titleCursor = await probe.cursorNow();
      await api.json('PUT', `/notes/${id}`, { title: 's2 renamed 1' });
      seen = await probe.waitForRows(titleCursor, (rows) => rowsOf(rows, id).length > 0);
      mine = rowsOf(seen.rows, id);
      steps.title = { cursor: titleCursor, rows: brief(seen.rows), waitedMs: seen.waitedMs };
      checks.eq('title: one row', mine.length, 1);
      checks.eq('title: type 2', mine[0]?.type, TYPE_UPDATE);
      const firstUpdateRowId = mine[0]?.id ?? -1;

      // c. two more title updates, polled from the SAME cursor: coalesced into one row at a higher id
      await api.json('PUT', `/notes/${id}`, { title: 's2 renamed 2' });
      await api.json('PUT', `/notes/${id}`, { title: 's2 renamed 3' });
      seen = await probe.waitForRows(titleCursor, (rows) => rowsOf(rows, id).some((row) => row.id > firstUpdateRowId));
      await sleep(700); // let the third write's row land too
      const coalesced = probe.subject((await probe.allSince(titleCursor)).rows);
      mine = rowsOf(coalesced, id);
      steps.coalescing = { cursor: titleCursor, firstUpdateRowId, rows: brief(coalesced), table: await tableRowsFor(joplin!.win, [id]) };
      checks.eq('coalescing: still ONE row for the note since the cursor', mine.length, 1);
      checks.that('coalescing: its id is higher than the first update row', (mine[0]?.id ?? -1) > firstUpdateRowId, {
        now: mine[0]?.id,
        before: firstUpdateRowId,
      });
      checks.eq('coalescing: type 2', mine[0]?.type, TYPE_UPDATE);

      // d. move to another notebook
      const destination = (await api.json('POST', '/folders', { title: 's2 destination' })).id;
      cursor = await probe.cursorNow();
      await api.json('PUT', `/notes/${id}`, { parent_id: destination });
      seen = await probe.waitForRows(cursor, (rows) => rowsOf(rows, id).length > 0);
      mine = rowsOf(seen.rows, id);
      steps.move = { cursor, rows: brief(seen.rows), waitedMs: seen.waitedMs };
      checks.eq('move: one row', mine.length, 1);
      checks.eq('move: type 2', mine[0]?.type, TYPE_UPDATE);

      // e. note -> to-do
      cursor = await probe.cursorNow();
      await api.json('PUT', `/notes/${id}`, { is_todo: 1 });
      seen = await probe.waitForRows(cursor, (rows) => rowsOf(rows, id).length > 0);
      mine = rowsOf(seen.rows, id);
      steps.isTodo = { cursor, rows: brief(seen.rows), waitedMs: seen.waitedMs };
      checks.eq('is_todo: one row', mine.length, 1);
      checks.eq('is_todo: type 2', mine[0]?.type, TYPE_UPDATE);

      // f. attach a tag: no row
      const tag = await api.json('POST', '/tags', { title: `s2tag${Date.now()}` });
      const stampsBefore = await api.json('GET', `/notes/${id}?fields=updated_time,user_updated_time`);
      cursor = await probe.cursorNow();
      await api.json('POST', `/tags/${tag.id}/notes`, { id });
      let quiet = await probe.quiet(cursor);
      const stampsAfter = await api.json('GET', `/notes/${id}?fields=updated_time,user_updated_time`);
      steps.tagAttach = { cursor, first: brief(quiet.first), second: brief(quiet.second), stampsBefore, stampsAfter };
      checks.eq('tag attach: no row for the note', rowsOf(quiet.second, id).length, 0);
      checks.eq('tag attach: no rows at all', quiet.second.length, 0);

      // g. create and rename a folder: no rows
      cursor = await probe.cursorNow();
      const scratch = (await api.json('POST', '/folders', { title: 's2 scratch folder' })).id;
      await api.json('PUT', `/folders/${scratch}`, { title: 's2 scratch folder renamed' });
      quiet = await probe.quiet(cursor);
      steps.folderCreateRename = { cursor, first: brief(quiet.first), second: brief(quiet.second) };
      checks.eq('folder create + rename: no rows at all', quiet.second.length, 0);

      // h. to the trash: an update with deleted_time set
      cursor = await probe.cursorNow();
      const trashed = await api.request('DELETE', `/notes/${id}`);
      seen = await probe.waitForRows(cursor, (rows) => rowsOf(rows, id).length > 0);
      mine = rowsOf(seen.rows, id);
      const inTrash = await probe.raw({ op: 'note', id, fields: ['id', 'deleted_time', 'is_conflict', 'parent_id', 'is_todo'] });
      steps.trash = { cursor, httpStatus: trashed.status, rows: brief(seen.rows), waitedMs: seen.waitedMs, noteFromPlugin: inTrash };
      checks.that('trash: DELETE answered 2xx', trashed.status >= 200 && trashed.status < 300, trashed);
      checks.eq('trash: one row', mine.length, 1);
      checks.eq('trash: type 2 (an update, not a delete)', mine[0]?.type, TYPE_UPDATE);
      checks.that('trash: the plugin reads deleted_time > 0', !!inTrash.ok && Number(inTrash.result?.deleted_time) > 0, inTrash);

      // i. restore: first a plain PUT of deleted_time 0, then the app's restoreNote command if that did not restore it
      cursor = await probe.cursorNow();
      const restorePut = await api.request('PUT', `/notes/${id}`, { deleted_time: 0 });
      seen = await probe.waitForRows(cursor, (rows) => rowsOf(rows, id).length > 0, 10_000);
      let restored = await probe.raw({ op: 'note', id, fields: ['id', 'deleted_time', 'is_conflict', 'parent_id', 'is_todo'] });
      const restore: Record<string, any> = (steps.restore = {
        cursor,
        put: { httpStatus: restorePut.status, body: restorePut.text.slice(0, 300), rows: brief(seen.rows), noteFromPlugin: restored },
      });
      restore.route = 'PUT deleted_time 0';
      if (!(restored.ok && Number(restored.result?.deleted_time) === 0)) {
        restore.route = 'restoreNote command';
        restore.command = { answer: await callPluginCommand(joplin!.win, 'restoreNote', [id]) };
        seen = await probe.waitForRows(cursor, (rows) => rowsOf(rows, id).length > 0);
        await pollFor(async () => {
          restored = await probe.raw({ op: 'note', id, fields: ['id', 'deleted_time', 'is_conflict', 'parent_id', 'is_todo'] });
          return !!restored.ok && Number(restored.result?.deleted_time) === 0;
        }, 10_000);
        restore.command.rows = brief(seen.rows);
        restore.command.noteFromPlugin = restored;
      }
      await sleep(500);
      const afterRestore = probe.subject((await probe.allSince(cursor)).rows);
      mine = rowsOf(afterRestore, id);
      restore.rows = brief(afterRestore);
      checks.eq('restore: one row', mine.length, 1);
      checks.eq('restore: type 2', mine[0]?.type, TYPE_UPDATE);
      checks.that('restore: the plugin reads deleted_time 0', !!restored.ok && Number(restored.result?.deleted_time) === 0, restored);

      // j. permanent delete: type 3, and the note is gone
      cursor = await probe.cursorNow();
      const deleted = await api.request('DELETE', `/notes/${id}?permanent=1`);
      seen = await probe.waitForRows(cursor, (rows) => rowsOf(rows, id).some((row) => row.type === TYPE_DELETE));
      mine = rowsOf(seen.rows, id);
      const restAfter = await api.request('GET', `/notes/${id}?fields=id`);
      const pluginAfter = await probe.raw({ op: 'note', id, fields: ['id', 'deleted_time'] });
      steps.permanentDelete = {
        cursor,
        httpStatus: deleted.status,
        rows: brief(seen.rows),
        waitedMs: seen.waitedMs,
        restGetStatus: restAfter.status,
        noteFromPlugin: pluginAfter,
        table: await tableRowsFor(joplin!.win, [id]),
      };
      checks.that('permanent delete: DELETE answered 2xx', deleted.status >= 200 && deleted.status < 300, deleted);
      checks.eq('permanent delete: one row', mine.length, 1);
      checks.eq('permanent delete: type 3', mine[0]?.type, TYPE_DELETE);
      checks.eq('permanent delete: item_type still 1', mine[0]?.item_type, ITEM_TYPE_NOTE);
      checks.eq('permanent delete: a REST GET answers 404', restAfter.status, 404);
      checks.that('permanent delete: the plugin GET fails', !pluginAfter.ok, pluginAfter);
    } finally {
      saveFindings();
    }
    checks.assertAll();
  });

  test('3. paging and cursor edge cases: 100 per page, the cursor, a stale cursor, a bad cursor', async () => {
    test.setTimeout(300_000);
    const checks = new Checks('s3_paging');
    const out: Record<string, any> = (findings.s3_paging = {});
    try {
      const cursor = await probe.cursorNow();
      out.cursor = cursor;
      const created: string[] = [];
      const started = Date.now();
      for (let i = 0; i < 150; i++) created.push((await api.json('POST', '/notes', { title: `s3 page ${i}`, parent_id: folderId })).id);
      out.postMs = Date.now() - started;
      const landed = await probe.waitForRows(cursor, (rows) => created.every((id) => rowsOf(rows, id).length > 0), 60_000);
      out.allLandedMs = landed.waitedMs;
      checks.that('all 150 rows landed', !landed.timedOut, { seen: landed.rows.length });

      const page1 = await probe.events({ cursor });
      const last1 = page1.items[page1.items.length - 1];
      out.page1 = {
        count: page1.items.length,
        subjectCount: probe.subject(page1.items).length,
        has_more: page1.has_more,
        cursor: page1.cursor,
        cursorType: typeof page1.cursor,
        firstRowId: page1.items[0]?.id,
        lastRowId: last1?.id,
      };
      checks.eq('page 1 holds exactly 100 rows', page1.items.length, 100);
      checks.eq('page 1: has_more is true', page1.has_more, true);
      checks.eq('page 1: the cursor is the last row id, as a string', page1.cursor, String(last1?.id));

      const page2 = await probe.events({ cursor: page1.cursor });
      const last2 = page2.items[page2.items.length - 1];
      out.page2 = {
        count: page2.items.length,
        subjectCount: probe.subject(page2.items).length,
        has_more: page2.has_more,
        cursor: page2.cursor,
        firstRowId: page2.items[0]?.id,
        lastRowId: last2?.id,
      };
      const subject1 = probe.subject(page1.items);
      const subject2 = probe.subject(page2.items);
      checks.eq('page 2: has_more is false', page2.has_more, false);
      checks.eq('page 2 holds the remaining notes', subject2.length, 150 - subject1.length);
      if (!probe.fallbackOn) checks.eq('page 2 holds exactly 50 rows', page2.items.length, 50);
      checks.eq('page 2: the cursor is the last row id, as a string', page2.cursor, String(last2?.id));
      const union = new Set([...subject1, ...subject2].map((row) => row.item_id));
      checks.eq('the two pages hold 150 distinct item_ids', union.size, 150);
      checks.that('... and they are exactly the notes created', created.every((id) => union.has(id)));
      const both = [...page1.items, ...page2.items];
      checks.that('rows come in ascending id order', both.every((row, i) => i === 0 || row.id > both[i - 1].id));
      checks.that(
        'every subject row is a note create',
        [...subject1, ...subject2].every((row) => row.item_type === ITEM_TYPE_NOTE && row.type === TYPE_CREATE)
      );

      const far = String(Number(page2.cursor) + 1_000_000);
      const stale = await probe.events({ cursor: far });
      out.farCursor = { sent: far, answer: stale };
      checks.eq('a cursor far past the end: no items', stale.items, []);
      checks.eq('a cursor far past the end: has_more is false', stale.has_more, false);
      checks.eq('a cursor far past the end is echoed back as the same string', stale.cursor, far);

      const bad = await probe.raw({ op: 'events', cursor: 'abc' });
      out.badCursor = bad;
      checks.eq('cursor "abc": the call fails', bad.ok, false);
      checks.that('cursor "abc": the error says Invalid cursor', /Invalid cursor/.test(String(bad.error)), bad.error);
    } finally {
      saveFindings();
    }
    checks.assertAll();
  });

  test('4. the row lands after the save: how often an immediate poll misses it', async () => {
    test.setTimeout(300_000);
    const checks = new Checks('s4_row_after_save');
    const out: Record<string, any> = (findings.s4_row_after_save = {});
    try {
      const cursor = await probe.cursorNow();
      const id: string = (await api.json('POST', '/notes', { title: 's4 race', parent_id: folderId })).id;
      await probe.waitForRows(cursor, (rows) => rowsOf(rows, id).length > 0);
      out.noteId = id;

      // From outside: a REST PUT, then a poll from the plugin the moment the PUT has answered.
      const rest: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 20; i++) {
        const before = await probe.cursorNow();
        const putAt = Date.now();
        await api.json('PUT', `/notes/${id}`, { title: `s4 rest ${i}` });
        const answeredAt = Date.now();
        const immediate = await probe.events({ cursor: before });
        const polledAt = Date.now();
        await sleep(500);
        const later = await probe.events({ cursor: before });
        const sample = {
          i,
          putMs: answeredAt - putAt,
          pollMs: polledAt - answeredAt,
          immediateHit: rowsOf(immediate.items, id).length > 0,
          laterHit: rowsOf(later.items, id).length > 0,
        };
        rest.push(sample);
        checks.that(`REST put ${i}: the row is there 500 ms later`, sample.laterHit, sample);
      }
      out.restPut = { immediateHits: rest.filter((s) => s.immediateHit).length, of: rest.length, samples: rest };

      // From inside (record only): the plugin's OWN put, then a poll in the same call, which is the path Cockpit's
      // own writes will take in 2.7.
      const own: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 20; i++) {
        const answer = await probe.ok({ op: 'putThenPoll', id, title: `s4 own ${i}` });
        await sleep(500);
        const later = await probe.events({ cursor: answer.cursor });
        const sample = {
          i,
          putMs: answer.putMs,
          pollMs: answer.pollMs,
          immediateHit: rowsOf(answer.immediate.items, id).length > 0,
          laterHit: rowsOf(later.items, id).length > 0,
        };
        own.push(sample);
        checks.that(`plugin put ${i}: the row is there 500 ms later`, sample.laterHit, sample);
      }
      out.pluginPut = { immediateHits: own.filter((s) => s.immediateHit).length, of: own.length, samples: own };
      console.log(
        `[events-probe] row after save: REST put ${out.restPut.immediateHits}/20 immediate hits, ` +
          `plugin put ${out.pluginPut.immediateHits}/20 immediate hits`
      );
    } finally {
      saveFindings();
    }
    checks.assertAll();
  });

  test('record: the processed-change markers and the rows pruning could take (no assertions)', async () => {
    const out: Record<string, any> = (findings.pruning = {});
    try {
      // The markers move on the services' own timers; wait (bounded) until the search engine has processed this
      // session's rows, so the snapshot says something about rows that pruning is ALLOWED to consider.
      const head = Number(await probe.cursorNow());
      out.feedHead = head;
      out.markersCaughtUp = await pollFor(async () => {
        const snap: any = await pruningSnapshot(joplin!.win);
        return !snap.error && snap.minProcessed >= head - 5;
      }, 20_000, 1_000);
      out.snapshot = await pruningSnapshot(joplin!.win);
      const fromStart = await probe.events({ cursor: '0' });
      out.firstPageFromZero = { count: fromStart.items.length, firstRows: brief(fromStart.items.slice(0, 3)), has_more: fromStart.has_more };
    } finally {
      saveFindings();
    }
  });
});

/** ================================================================================================
 * Scenario 5: sync-applied changes, two profiles and one filesystem sync target
 * ============================================================================================= */

test('5. sync-applied changes reach the feed: creates, an edit, a trash and a permanent delete', async () => {
  test.setTimeout(25 * 60_000);
  const checks = new Checks('s5_sync');
  const out: Record<string, any> = (findings.s5_sync = {});
  fs.mkdirSync(PROFILES_ROOT, { recursive: true });
  // `profile-` prefix: a crashed run's leftovers are swept by the next run's global setup like any profile.
  const syncDir = fs.mkdtempSync(path.join(PROFILES_ROOT, 'profile-events-sync-'));
  const syncSettings = { 'sync.target': 2, 'sync.2.path': syncDir };
  const profileA = createProfile(false, { ...apiSettings(PORT_A), ...syncSettings });
  const profileB = createProfile(false, { ...apiSettings(PORT_B), ...syncSettings, 'plugins.devPluginPaths': PROBE_DIR });
  out.dirs = { syncDir, profileA, profileB };
  const X_TITLE = 's5 X';
  const X_RENAMED = 's5 X renamed in A';
  const syncFile = (id: string) => path.join(syncDir, `${id}.md`);
  let current: JoplinInstance | null = null;
  try {
    // ---- A, round 1: three notes, synced up
    current = await launchJoplin({ profileDir: profileA, envDev: true });
    const apiA = new DataApi(PORT_A);
    await apiA.ready();
    const folder = (await apiA.json('POST', '/folders', { title: 's5 synced notebook' })).id;
    const X: string = (await apiA.json('POST', '/notes', { title: X_TITLE, body: 'x', parent_id: folder })).id;
    const Y: string = (await apiA.json('POST', '/notes', { title: 's5 Y', body: 'y', parent_id: folder })).id;
    const Z: string = (await apiA.json('POST', '/notes', { title: 's5 Z', body: 'z', parent_id: folder })).id;
    out.ids = { X, Y, Z };
    out.aRound1 = await syncUntil(current.win, 'A round 1', async () => [X, Y, Z].every((id) => fs.existsSync(syncFile(id))));
    saveFindings();
    if (!out.aRound1.satisfied) throw new Error('A round 1: the notes never reached the sync directory');
    await closeJoplin(current, { keepProfile: true });
    current = null;

    // ---- B, round 1: cursor0 BEFORE syncing, then the three notes come in through the sync
    current = await launchJoplin({ profileDir: profileB, envDev: true });
    const apiB = new DataApi(PORT_B);
    await apiB.ready();
    let probe = new Probe(current.win, apiB, 'B round 1');
    await probe.start();
    out.bRound1Channel = probe.channel();
    const cursor0 = await probe.cursorNow();
    out.cursor0 = cursor0;
    const before = { X: await apiB.status(X), Y: await apiB.status(Y), Z: await apiB.status(Z) };
    out.bBeforeSync = before;
    checks.eq('B before its first sync: X, Y, Z are not there', before, { X: 404, Y: 404, Z: 404 });
    await probe.ok({ op: 'armSyncPoll', cursor: cursor0 });
    out.bRound1 = await syncUntil(
      current.win,
      'B round 1',
      async () => (await apiB.status(X)) === 200 && (await apiB.status(Y)) === 200 && (await apiB.status(Z)) === 200,
      probe
    );
    saveFindings();
    if (!out.bRound1.satisfied) throw new Error('B round 1: X, Y, Z never arrived through the sync');
    let seen = await probe.waitForRows(cursor0, (rows) => [X, Y, Z].every((id) => rowsOf(rows, id).length > 0), 20_000);
    out.bRound1Rows = brief(seen.rows);
    out.bRound1RowsRaw = seen.rows;
    out.syncedCreateTypes = { X: rowsOf(seen.rows, X).map((r) => r.type), Y: rowsOf(seen.rows, Y).map((r) => r.type), Z: rowsOf(seen.rows, Z).map((r) => r.type) };
    for (const [name, id] of Object.entries({ X, Y, Z })) {
      const mine = rowsOf(seen.rows, id);
      checks.eq(`round 1: one row for ${name}`, mine.length, 1);
      checks.eq(`round 1: ${name} is item_type 1`, mine[0]?.item_type, ITEM_TYPE_NOTE);
      checks.eq(`round 1: ${name} is type 1 (a synced-in create)`, mine[0]?.type, TYPE_CREATE);
    }
    checks.eq('round 1: no other note rows', seen.rows.map((r) => r.item_id).sort(), [X, Y, Z].sort());
    out.bRound1SyncState = await probe.ok({ op: 'syncState' });
    await probe.ok({ op: 'disarmSyncPoll' });
    out.bRound1OnSyncCompletePolls = summariseArmedPolls(out.bRound1SyncState, { X, Y, Z });
    out.bRound1TableAtEnd = await pruningSnapshot(current.win);
    out.bRound1Channel = probe.channel();
    await closeJoplin(current, { keepProfile: true });
    current = null;

    // ---- A, round 2: edit X, trash Y, delete Z for good; synced up
    const yFileRound1 = fs.readFileSync(syncFile(Y), 'utf8');
    current = await launchJoplin({ profileDir: profileA, envDev: true });
    await apiA.ready();
    await apiA.json('PUT', `/notes/${X}`, { title: X_RENAMED });
    const trashY = await apiA.request('DELETE', `/notes/${Y}`);
    const deleteZ = await apiA.request('DELETE', `/notes/${Z}?permanent=1`);
    out.aRound2Changes = { trashYStatus: trashY.status, deleteZStatus: deleteZ.status };
    out.aRound2 = await syncUntil(current.win, 'A round 2', async () => {
      if (!fs.existsSync(syncFile(X)) || !fs.existsSync(syncFile(Y))) return false;
      const xFirstLine = fs.readFileSync(syncFile(X), 'utf8').split('\n')[0];
      // Y's file only has to have been rewritten (the trash bumps updated_time); its deleted_time line is recorded below.
      return xFirstLine === X_RENAMED && fs.readFileSync(syncFile(Y), 'utf8') !== yFileRound1 && !fs.existsSync(syncFile(Z));
    });
    if (fs.existsSync(syncFile(Y))) {
      const line = /^deleted_time: *(\d*)$/m.exec(fs.readFileSync(syncFile(Y), 'utf8'));
      out.aRound2YDeletedTimeLine = line ? line[0] : null;
    }
    saveFindings();
    if (!out.aRound2.satisfied) throw new Error('A round 2: the edit, the trash and the delete never reached the sync directory');
    await closeJoplin(current, { keepProfile: true });
    current = null;

    // ---- B, round 2: cursor1 BEFORE syncing, then an update, a trash and a delete come in through the sync
    current = await launchJoplin({ profileDir: profileB, envDev: true });
    await apiB.ready();
    probe = new Probe(current.win, apiB, 'B round 2');
    await probe.start();
    out.bRound2TableAtStart = await pruningSnapshot(current.win);
    const cursor1 = await probe.cursorNow();
    out.cursor1 = cursor1;
    await probe.ok({ op: 'armSyncPoll', cursor: cursor1 });
    out.bRound2 = await syncUntil(
      current.win,
      'B round 2',
      async () => {
        const x = await apiB.request('GET', `/notes/${X}?fields=title`);
        const y = await apiB.request('GET', `/notes/${Y}?fields=deleted_time`);
        return (
          x.status === 200 &&
          JSON.parse(x.text).title === X_RENAMED &&
          y.status === 200 &&
          Number(JSON.parse(y.text).deleted_time) > 0 &&
          (await apiB.status(Z)) === 404
        );
      },
      probe
    );
    saveFindings();
    if (!out.bRound2.satisfied) throw new Error('B round 2: the edit, the trash and the delete never arrived through the sync');
    seen = await probe.waitForRows(
      cursor1,
      (rows) => rowsOf(rows, X).length > 0 && rowsOf(rows, Y).length > 0 && rowsOf(rows, Z).some((r) => r.type === TYPE_DELETE),
      20_000
    );
    out.bRound2Rows = brief(seen.rows);
    out.bRound2RowsRaw = seen.rows;
    const expectations: Array<[string, string, number]> = [
      ['X (edited)', X, TYPE_UPDATE],
      ['Y (trashed)', Y, TYPE_UPDATE],
      ['Z (deleted for good)', Z, TYPE_DELETE],
    ];
    for (const [name, id, type] of expectations) {
      const mine = rowsOf(seen.rows, id);
      checks.eq(`round 2: one row for ${name}`, mine.length, 1);
      checks.eq(`round 2: ${name} is item_type 1`, mine[0]?.item_type, ITEM_TYPE_NOTE);
      checks.eq(`round 2: ${name} is type ${type}`, mine[0]?.type, type);
    }
    checks.eq('round 2: no other note rows', seen.rows.map((r) => r.item_id).sort(), [X, Y, Z].sort());
    const fields = ['id', 'title', 'deleted_time', 'is_conflict', 'parent_id', 'is_todo'];
    const xNote = await probe.raw({ op: 'note', id: X, fields });
    const yNote = await probe.raw({ op: 'note', id: Y, fields });
    const zNote = await probe.raw({ op: 'note', id: Z, fields });
    out.bRound2NotesFromPlugin = { X: xNote, Y: yNote, Z: zNote };
    checks.eq('round 2: the plugin reads X with its new title', xNote.result?.title, X_RENAMED);
    checks.that('round 2: the plugin reads Y with deleted_time > 0', !!yNote.ok && Number(yNote.result?.deleted_time) > 0, yNote);
    checks.that('round 2: the plugin GET of Z fails', !zNote.ok, zNote);
    out.bRound2SyncState = await probe.ok({ op: 'syncState' });
    await probe.ok({ op: 'disarmSyncPoll' });
    out.bRound2OnSyncCompletePolls = summariseArmedPolls(out.bRound2SyncState, { X, Y, Z });
    out.bRound2Channel = probe.channel();
  } finally {
    if (current) await closeJoplin(current, { keepProfile: true });
    for (const dir of [profileA, profileB, syncDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    saveFindings();
  }
  checks.assertAll();
});

/**
 * What the probe saw when onSyncComplete fired (it polled the feed from the armed cursor at once): which of the synced
 * notes already had their row. Record only: it answers whether a poll triggered by onSyncComplete can be trusted alone.
 */
function summariseArmedPolls(syncState: any, ids: Record<string, string>): unknown {
  const polls: any[] = (syncState && syncState.armedPolls) || [];
  return polls.map((poll) => {
    const rows: ChangeRow[] = poll.rows || [];
    const present: Record<string, number[]> = {};
    for (const [name, id] of Object.entries(ids)) present[name] = rowsOf(rows, id).map((r) => r.type);
    return { completedCount: poll.completedCount, polledMs: poll.polledMs, error: poll.error, rowCount: rows.length, typesById: present };
  });
}
