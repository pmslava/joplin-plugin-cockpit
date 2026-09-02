import { test, expect, Page, Frame } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  activateJoplinMenuItem,
  agendaPanel,
  clickPanelTodo,
  createProfile as createPanelProfile,
  editCurrentProfile,
  dockCockpitPanelLeft,
  panelTodoTitles,
  refreshPanel,
  screenshotDialog,
  selectCalendarDay,
  selectProfile,
  setCockpitSetting,
  setJoplinWindowSize,
  weekPlannerDays,
  PANEL_IFRAME,
} from './helpers';

/**
 * The README screenshot rig. Not an assertion suite: it stages one realistic dataset through Joplin's
 * own data API, then captures the panel, its dialogs and its themes so docs/images/ can be rebuilt
 * from scratch instead of ageing quietly. It asserts nothing about the plugin - every wait here is a
 * "has the screen settled" wait, not a promise about behaviour.
 *
 * It takes several minutes and needs a real display, so it is skipped unless asked for:
 *
 *     npm run dist && SHOWCASE=1 xvfb-run -a --server-args="-screen 0 1920x1080x24" \
 *       npx playwright test e2e/showcase.spec.ts --retries=0 --global-timeout=3600000
 *
 * Shots land in test-results/showcase/; copying them into docs/images/ is a deliberate manual step.
 *
 * THE CLOCK. Half the shot list is calendar work: a month grid that has to be busy, a week planner
 * that has to have most of its days filled and one empty, an Overdue group that has to stay short.
 * Whether the same fixture produces that or produces a nearly empty grid depends entirely on which
 * day of which month the capture happens to run on. So the harness Joplin is given a shifted
 * CLOCK_REALTIME (a tiny LD_PRELOAD shim, built here, applied to the Joplin child process only) that
 * places the capture on a midweek day early in a month. CLOCK_MONOTONIC is untouched, so every timer,
 * animation and Playwright wait behaves exactly as it always does; only "what day is it" moves. Set
 * SHOWCASE_NO_TIMESHIFT=1 to capture on the real clock instead.
 */

const OUT_DIR = path.join(__dirname, '..', 'test-results', 'showcase');
const SCRATCH = path.join(__dirname, '..', 'test-results', 'showcase-scratch');

const API_TOKEN = `cockpit-showcase-${Date.now()}`;
const API_PORT = 41199;

const WINDOW_WIDTH = 1920;
const WINDOW_HEIGHT = 1080;
/**
 * The hero is the one shot of the WHOLE window, and it is the one shot that has to survive being
 * scaled down: GitHub renders a README image at roughly 890px wide, so a 1920px window puts the panel
 * on screen about 290px wide with unreadable row text, and pays for it with two-thirds of a frame of
 * empty editor background. At 1240 the panel is half the frame and lands near 440px in the README,
 * while the open note still shows its title, its toolbar and its whole checklist beside the ring.
 * Height stays at 1080: the interval list needs it to reach the Notes group.
 *
 * 1360 rather than 1240: Joplin's note title bar carries the due date, the language chip, the alarm
 * and three icons on the same line, about 440px of them, and at 1240 the title itself is ellipsised
 * mid-word - which reads as a rendering fault in the one shot that has to look right.
 */
const HERO_WINDOW_WIDTH = 1360;
/** Wide enough that a row title, its time and its notebook pill all sit on one line. */
const PANEL_WIDTH = 620;

/** ------------------------------------------------------------------------------------------------
 * The clock
 * --------------------------------------------------------------------------------------------- */

/**
 * The instant the capture should pretend to be: the next Wednesday whose day-of-month is between the
 * 6th and the 12th, at 10:20. Midweek keeps most of the week ahead of "today" (so the week planner is
 * full and Overdue stays at two rows); early-in-the-month keeps the +11/+14/+18/+21 day fixtures
 * inside the same month, which is what makes the month grid busy.
 */
function pickCaptureInstant(realNow: Date): Date {
  const candidate = new Date(realNow);
  candidate.setHours(10, 20, 0, 0);
  for (let step = 0; step < 400; step++) {
    const day = candidate.getDate();
    if (candidate.getDay() === 3 && day >= 6 && day <= 12 && candidate.getTime() > realNow.getTime()) {
      return candidate;
    }
    candidate.setDate(candidate.getDate() + 1);
  }
  return realNow;
}

/** Build the CLOCK_REALTIME offset shim and arm it for the Joplin child process. Returns the fake now. */
function armTimeShift(): Date {
  const realNow = new Date();
  if (process.env.SHOWCASE_NO_TIMESHIFT) return realNow;

  const source = path.join(SCRATCH, 'timeshift.c');
  const library = path.join(SCRATCH, 'timeshift.so');
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.writeFileSync(source, TIMESHIFT_SOURCE, 'utf8');
  try {
    execFileSync('gcc', ['-shared', '-fPIC', '-O2', '-o', library, source, '-ldl'], { stdio: 'pipe' });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('Could not build the clock shim, capturing on the real clock:', (error as Error).message);
    return realNow;
  }

  const fakeNow = pickCaptureInstant(realNow);
  const offset = Math.round((fakeNow.getTime() - realNow.getTime()) / 1000);
  // Only child processes inherit this, and the only child this spec starts is Joplin.
  process.env.LD_PRELOAD = library;
  process.env.COCKPIT_TIME_OFFSET_SEC = String(offset);
  return fakeNow;
}

const TIMESHIFT_SOURCE = `/*
 * A CLOCK_REALTIME offset shim, LD_PRELOADed into the harness Joplin only (see showcase.spec.ts).
 * CLOCK_MONOTONIC is deliberately left alone so timers behave normally; only the calendar date moves.
 */
#define _GNU_SOURCE
#include <time.h>
#include <sys/time.h>
#include <dlfcn.h>
#include <stdlib.h>
#include <stddef.h>

static long offset_sec(void) {
    static long cached = 0;
    static int loaded = 0;
    if (!loaded) {
        const char *env = getenv("COCKPIT_TIME_OFFSET_SEC");
        cached = env ? atol(env) : 0;
        loaded = 1;
    }
    return cached;
}

static int is_real(clockid_t clk) {
#ifdef CLOCK_REALTIME_COARSE
    if (clk == CLOCK_REALTIME_COARSE) return 1;
#endif
    return clk == CLOCK_REALTIME;
}

int clock_gettime(clockid_t clk, struct timespec *tp) {
    static int (*real_fn)(clockid_t, struct timespec *) = NULL;
    if (!real_fn) real_fn = (int (*)(clockid_t, struct timespec *)) dlsym(RTLD_NEXT, "clock_gettime");
    int r = real_fn(clk, tp);
    if (r == 0 && tp && is_real(clk)) tp->tv_sec += offset_sec();
    return r;
}

int gettimeofday(struct timeval *tv, void *tz) {
    static int (*real_fn)(struct timeval *, void *) = NULL;
    if (!real_fn) real_fn = (int (*)(struct timeval *, void *)) dlsym(RTLD_NEXT, "gettimeofday");
    int r = real_fn(tv, tz);
    if (r == 0 && tv) tv->tv_sec += offset_sec();
    return r;
}

time_t time(time_t *t) {
    struct timespec ts;
    if (clock_gettime(CLOCK_REALTIME, &ts) != 0) return (time_t) -1;
    if (t) *t = ts.tv_sec;
    return ts.tv_sec;
}
`;

/** ------------------------------------------------------------------------------------------------
 * Joplin's data API - how the fixture is staged
 *
 * Twenty-odd items, several of which need checkbox BODIES for the progress rings, is not something the
 * GUI helpers can do: createTodo only types a title, and each GUI cycle costs seconds. The clipper
 * server is preset on the throwaway profile and everything is POSTed, the pattern type-flip.spec.ts
 * already proves.
 * --------------------------------------------------------------------------------------------- */

function apiRequest(method: string, requestPath: string, body?: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      {
        host: '127.0.0.1',
        port: API_PORT,
        method,
        path: requestPath,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
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

async function apiReady(win: Page): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const ping = await apiRequest('GET', '/ping');
      if (ping.status === 200) return;
    } catch {
      /* not up yet */
    }
    await win.waitForTimeout(1000);
  }
  throw new Error(`Joplin's data API never answered on 127.0.0.1:${API_PORT}`);
}

async function apiPost(requestPath: string, body: unknown): Promise<any> {
  const response = await apiRequest('POST', `${requestPath}?token=${API_TOKEN}`, body);
  if (response.status !== 200) throw new Error(`POST ${requestPath} failed: ${response.status} ${response.text}`);
  return JSON.parse(response.text);
}

/** ------------------------------------------------------------------------------------------------
 * The fixture
 * --------------------------------------------------------------------------------------------- */

interface Fixture {
  title: string;
  notebook: 'Work' | 'Home' | 'Reading' | 'Hiring';
  /** Absolute due instant, or null for an undated to-do / a regular note. */
  due: number | null;
  isTodo: boolean;
  completedAt?: number;
  body?: string;
  tags?: string[];
}

/** A markdown body with `total` checkboxes, the first `ticked` of them ticked. */
function checklist(intro: string, items: string[], ticked: number): string {
  const lines = items.map((item, index) => `- [${index < ticked ? 'x' : ' '}] ${item}`);
  return `${intro}\n\n${lines.join('\n')}\n`;
}

function buildFixtures(now: Date) {
  const at = (offsetDays: number, hour: number, minute: number) => {
    const date = new Date(now);
    date.setDate(date.getDate() + offsetDays);
    date.setHours(hour, minute, 0, 0);
    return date.getTime();
  };

  /**
   * Late in the capture month, but never ON its last day.
   *
   * The last day of the month used to fall through to "This Year": getEndOfThisMonth() returned
   * MIDNIGHT of the last day, so anything due at a normal hour on it sorted past the boundary and the
   * shot showed a lone This Year row sitting under This Month with a date one day later. A fixed +21
   * day offset landed there whenever the capture clock picked the 9th of a 30-day month. That grouping
   * bug is fixed - since v2.1.3 the helper ends at 23:59:59.999, so the last day belongs to This Month
   * like any other - but the fixture stays off the boundary anyway: the second-to-last day is inside
   * This Month for every month length, which keeps the captured layout the same from run to run.
   */
  const lateThisMonth = (hour: number, minute: number) => {
    const date = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    date.setDate(date.getDate() - 1);
    date.setHours(hour, minute, 0, 0);
    return date.getTime();
  };

  /**
   * The middle of the month AFTER the capture month: past This Month, still inside the year slice, so
   * the interval list shows every horizon it has a name for. (In December the year slice is "Next
   * Year" rather than "This Year" - since v2.2.0 a period whose remaining days are already covered by
   * the group above it hands its slot to the next period - and this row is captioned Next Year
   * instead. The clock picks a Wednesday the 6th-12th of whatever month the run happens in, so that is
   * a once-a-year shape, not the usual one; every other month captures This Week / This Month / This
   * Year exactly as before.)
   */
  const nextMonth = (hour: number, minute: number) => {
    const date = new Date(now.getFullYear(), now.getMonth() + 1, 15);
    date.setHours(hour, minute, 0, 0);
    return date.getTime();
  };

  const todos: Fixture[] = [
    // Overdue
    { title: 'Pay the electricity bill', notebook: 'Home', due: at(-3, 9, 0), isTodo: true, tags: ['home', 'bills', 'finance'] },
    { title: 'Send the Q3 invoice', notebook: 'Work', due: at(-1, 16, 0), isTodo: true, tags: ['work', 'finance'] },
    // Today - five of them, so the month grid's four-dot cap yields a "+1"
    {
      title: 'Standup',
      notebook: 'Work',
      due: at(0, 9, 30),
      isTodo: true,
      completedAt: at(0, 9, 35),
      tags: ['work'],
    },
    {
      title: 'Review the onboarding PR',
      notebook: 'Work',
      due: at(0, 11, 0),
      isTodo: true,
      tags: ['work', 'project'],
      body:
        checklist(
          'Second pass. Notes from the first round are in the thread.',
          [
            'Read through the setup guide diff',
            'Check the migration script',
            'Run it against a local install',
            'Ask about the naming of the two new flags',
            'Approve or request changes',
          ],
          2
        ) +
        '\nThe migration is the part worth reading twice: it rewrites the stored paths in place and ' +
        'there is no dry-run flag yet. Everything else is documentation and a handful of renames.\n\n' +
        'If the local run goes cleanly this can go out with the next release; if it does not, it waits ' +
        'for the one after, which is fine - nothing downstream is blocked on it.\n',
    },
    { title: 'Dentist appointment', notebook: 'Home', due: at(0, 14, 0), isTodo: true, tags: ['home', 'health'] },
    { title: 'Call the plumber', notebook: 'Home', due: at(0, 16, 30), isTodo: true, tags: ['home', 'urgent'] },
    { title: 'Buy a birthday present', notebook: 'Home', due: at(0, 18, 0), isTodo: true, tags: ['home', 'errand', 'shopping'] },
    // Tomorrow
    {
      title: 'Team retrospective',
      notebook: 'Work',
      due: at(1, 11, 0),
      isTodo: true,
      tags: ['work'],
      body: checklist(
        'Half an hour, whole team.',
        ['Collect last sprint’s notes', 'Book the small meeting room', 'Write up the actions afterwards'],
        1
      ),
    },
    // This week
    { title: 'Book the flights', notebook: 'Home', due: at(2, 8, 0), isTodo: true, tags: ['home', 'travel', 'family'] },
    { title: 'Draft the hiring plan', notebook: 'Hiring', due: at(3, 10, 0), isTodo: true, tags: ['work', 'project'] },
    { title: 'Car service', notebook: 'Home', due: at(4, 8, 30), isTodo: true, tags: ['home', 'car'] },
    // Later
    { title: 'Renew the passport', notebook: 'Home', due: at(11, 10, 0), isTodo: true, tags: ['home', 'admin', 'travel'] },
    { title: 'Sprint planning', notebook: 'Work', due: at(14, 10, 0), isTodo: true, tags: ['work'] },
    // The one This Year row: without it the list jumps from This Month straight to Future.
    { title: 'Quarterly budget review', notebook: 'Work', due: nextMonth(15, 0), isTodo: true, tags: ['work', 'finance'] },
    { title: 'Pay the rent', notebook: 'Home', due: lateThisMonth(9, 0), isTodo: true, tags: ['home', 'bills'] },
    { title: 'Annual insurance renewal', notebook: 'Home', due: at(120, 9, 0), isTodo: true, tags: ['home', 'admin'] },
    // No due date
    { title: 'Idea: split the reading list by topic', notebook: 'Reading', due: null, isTodo: true, tags: ['reading'] },
    { title: 'Someday: learn to sail', notebook: 'Home', due: null, isTodo: true, tags: ['home'] },
  ];

  // The week fillers. The week planner needs at least five populated days AND one "Nothing due" day,
  // whichever weekday the capture lands on, so these are placed by weekday from the week's MONDAY
  // rather than by offset from today - and only onto days the fixtures above left empty, stopping
  // before the last empty one so a "Nothing due" day always survives.
  const monday = new Date(now);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const weekEnd = monday.getTime() + 7 * 24 * 3600 * 1000;
  const covered = new Set<number>();
  for (const todo of todos) {
    if (todo.due == null || todo.due < monday.getTime() || todo.due >= weekEnd) continue;
    covered.add(Math.floor((todo.due - monday.getTime()) / (24 * 3600 * 1000)));
  }
  const todayIndex = (now.getDay() + 6) % 7;
  const empty = [0, 1, 2, 3, 4, 5, 6].filter((index) => !covered.has(index));
  // Prefer days still ahead of today, so a filler does not swell the Overdue group.
  const order = [...empty.filter((i) => i >= todayIndex), ...empty.filter((i) => i < todayIndex)];
  const fillable = Math.max(0, Math.min(order.length - 1, 5 - covered.size));

  const fillers: Array<Omit<Fixture, 'due'> & { hour: number; minute: number }> = [
    { title: 'Water the plants', notebook: 'Home', isTodo: true, hour: 19, minute: 0, tags: ['home', 'garden'] },
    {
      title: 'Return the library books',
      notebook: 'Home',
      isTodo: true,
      hour: 17,
      minute: 30,
      tags: ['home', 'errand', 'reading'],
    },
  ];
  // A filler the week does not need is not created at all: it would only add a row to an interval list
  // that already just fits the panel's height, for nothing anyone can see.
  fillers.slice(0, fillable).forEach((filler, index) => {
    const { hour, minute, ...rest } = filler;
    const day = new Date(monday);
    day.setDate(day.getDate() + order[index]);
    day.setHours(hour, minute, 0, 0);
    todos.push({ ...rest, due: day.getTime() });
  });

  const notes: Fixture[] = [
    {
      title: 'Decision log: hosting move',
      notebook: 'Work',
      due: null,
      isTodo: false,
      tags: ['work', 'project'],
      body: checklist(
        'Where the hosting decision stands, and what is still open.',
        [
          'List what the current setup costs per month',
          'Compare the two shortlisted providers',
          'Check what the backup story looks like on each',
          'Ask both about egress fees',
          'Draft the migration plan',
          'Get sign-off from finance',
        ],
        4
      ),
    },
    {
      title: 'Meeting notes: Tuesday sync',
      notebook: 'Work',
      due: null,
      isTodo: false,
      tags: ['work'],
      body:
        'Short one this week.\n\n' +
        'The onboarding change goes out with the next release. Hiring plan is still a draft; ' +
        'we will look at it again on Thursday. No blockers reported.\n',
    },
    {
      title: 'Reading list',
      notebook: 'Reading',
      due: null,
      isTodo: false,
      tags: ['reading'],
      body: checklist(
        'Whatever is next, in no particular order.',
        [
          'The Design of Everyday Things',
          'Thinking in Systems',
          'The Pragmatic Programmer',
          'Seeing Like a State',
          'A Pattern Language',
          'The Making of the Atomic Bomb',
          'The Soul of a New Machine',
          'How Buildings Learn',
          'Where Wizards Stay Up Late',
        ],
        3
      ),
    },
  ];

  return [...todos, ...notes];
}

/** ------------------------------------------------------------------------------------------------
 * Small capture utilities
 * --------------------------------------------------------------------------------------------- */

const captured: string[] = [];

/**
 * Wait until the panel has finished drawing its rows WITH their notebook pills.
 *
 * A pill needs the notebook map, which the host caches with a 20s TTL and drops only when its own
 * three-second folder poll notices a change - so a panel painted while the map is still the empty one
 * from before the fixture was staged draws rows with no pill at all. That is a settled-screen wait,
 * not a claim about the plugin: a shot taken during it is simply a half-painted shot.
 */
async function waitForNotebookPills(win: Page, label: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const panel = await agendaPanel(win);
    const pills = await panel.locator('.todo-notebook').count();
    const rows = await panel.locator('.todo').count();
    if (pills > 0) return;
    // eslint-disable-next-line no-console
    console.log(`[${label}] no notebook pills yet (rows=${rows}), refreshing (attempt ${attempt + 1})`);
    await refreshPanel(win);
    await win.waitForTimeout(4000);
  }
  const panel = await agendaPanel(win);
  // eslint-disable-next-line no-console
  console.log(
    `[${label}] STILL no notebook pills. First row: `,
    await panel
      .locator('.todo')
      .first()
      .evaluate((element) => element.outerHTML)
      .catch(() => '(none)')
  );
}

/**
 * Shoot the panel iframe cropped to the height its content actually uses.
 *
 * The month grid and the week planner are much shorter than the panel, and a screenshot of the whole
 * iframe is then mostly empty background. The crop is measured from the panel's own layout, so it
 * never cuts content off.
 */
async function shootPanelToContent(win: Page, name: string): Promise<string> {
  const panel = await agendaPanel(win);
  const used = await panel.evaluate(() => {
    const parts = Array.from(
      document.querySelectorAll('#searchRow, .calendar-grid, .calendar-selected, .week-day, .todo, .todos h2')
    );
    return parts.reduce((lowest, element) => Math.max(lowest, element.getBoundingClientRect().bottom), 0);
  });
  const box = await win.locator(PANEL_IFRAME).boundingBox();
  const file = path.join(OUT_DIR, name);
  if (!box || !used) return shootPanel(win, name);
  const height = Math.min(Math.ceil(box.height), Math.ceil(used) + 14);
  await win.screenshot({
    path: file,
    clip: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height },
  });
  captured.push(file);
  // eslint-disable-next-line no-console
  console.log(`captured ${name} (${Math.round(fs.statSync(file).size / 1024)} KB, ${height}px tall)`);
  return file;
}

async function shootPanel(win: Page, name: string): Promise<string> {
  const file = path.join(OUT_DIR, name);
  await win.locator(PANEL_IFRAME).screenshot({ path: file });
  captured.push(file);
  // eslint-disable-next-line no-console
  console.log(`captured ${name} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
  return file;
}

async function shootWindow(win: Page, name: string): Promise<string> {
  const file = path.join(OUT_DIR, name);
  await win.screenshot({ path: file });
  captured.push(file);
  // eslint-disable-next-line no-console
  console.log(`captured ${name} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
  return file;
}

/** Re-select the profile a couple of times and wait for the panel to hold every fixture title. */
async function settlePanel(win: Page, expectedTitles: string[]): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await refreshPanel(win);
    const titles = await panelTodoTitles(win);
    if (expectedTitles.every((wanted) => titles.some((shown) => shown.includes(wanted)))) return;
    await win.waitForTimeout(4000);
  }
  await expect
    .poll(
      async () => {
        const titles = await panelTodoTitles(win);
        return expectedTitles.filter((wanted) => !titles.some((shown) => shown.includes(wanted)));
      },
      { timeout: 120_000, intervals: [5000] }
    )
    .toEqual([]);
}

/** Drag Joplin's layout so the Cockpit panel is `target` pixels wide. */
async function setPanelWidth(win: Page, target: number): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const box = await win.locator(PANEL_IFRAME).boundingBox();
    if (!box) return;
    if (Math.abs(box.width - target) < 12) return;
    const edge = box.x + box.width;
    const y = box.y + Math.min(300, box.height / 2);
    await win.mouse.move(edge + 3, y);
    await win.mouse.down();
    await win.mouse.move(box.x + target + 3, y, { steps: 24 });
    await win.mouse.up();
    await win.waitForTimeout(900);
  }
}

/**
 * Cycle Joplin's editor layout until only the rendered note viewer is showing. Side by side, the split
 * shows the same checklist twice - once inline-rendered in the editor, once in the viewer - which reads
 * as a mistake in a hero shot. The viewer alone is what the note actually looks like.
 */
async function showNoteViewerOnly(win: Page): Promise<void> {
  const editorPane = win.locator('.cm-editor, .CodeMirror').first();
  for (let attempt = 0; attempt < 3; attempt++) {
    const editorVisible = await editorPane.isVisible().catch(() => false);
    const viewerVisible = win.frames().some((frame) => frame.url().includes('note-viewer/index.html'));
    if (!editorVisible && viewerVisible) return;
    await activateJoplinMenuItem(win, /^Toggle editor layout$/);
    await win.waitForTimeout(1500);
  }
  // eslint-disable-next-line no-console
  console.log('could not reach a viewer-only editor layout; leaving it as it is');
}

/**
 * Drop the panel's row selection.
 *
 * A selection built for one shot is still painted in the next one, where nothing in frame explains it.
 * A click on empty panel space does not clear it (the panel keeps the set until another row is
 * pressed), so the capture clears the webview's own selection state and repaints - the same globals
 * multi-context-menu.spec.ts reads when it checks what is selected.
 */
async function clearRowSelection(win: Page): Promise<void> {
  const panel = await agendaPanel(win);
  await panel.evaluate(() => {
    const scope = window as any;
    if (scope.selectedRowIDs && typeof scope.selectedRowIDs.clear === 'function') scope.selectedRowIDs.clear();
    scope.lastClickedRowID = null;
    if (typeof scope.paintTodoSelection === 'function') scope.paintTodoSelection();
  });
  await win.waitForTimeout(700);
}

/** Clear the panel's search field back to empty, so a later shot is not silently filtered. */
async function clearPanelSearch(win: Page): Promise<void> {
  const panel = await agendaPanel(win);
  const field = panel.locator('#searchFilter');
  await field.click();
  await win.keyboard.press('Control+a');
  await win.keyboard.press('Delete');
  await win.keyboard.press('Enter');
  await win.waitForTimeout(2500);
  await panel.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await win.waitForTimeout(1500);
}

/** Put the panel's list back at the top, so a selection and its menu are near the head of the frame. */
async function scrollPanelToTop(panel: Frame): Promise<void> {
  await panel.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelectorAll('*').forEach((element) => {
      if (element.scrollTop) element.scrollTop = 0;
    });
  });
  await panel.page().waitForTimeout(400);
}

/**
 * Build a multi-selection over the given row titles and, optionally, open a context menu on the last
 * one. Selection is built with real Ctrl-clicks (the path multi-context-menu.spec.ts exercises), so
 * the panel iframe genuinely has focus; the menu is opened by dispatching contextmenu on the element
 * the panel routes from - the row itself for the note menu, its tick circle for the date picker.
 */
async function selectRows(panel: Frame, titles: string[]): Promise<void> {
  for (let index = 0; index < titles.length; index++) {
    const row = panel.locator('.todo', { hasText: titles[index] }).first();
    await row.locator('.todo-title').click(index === 0 ? {} : { modifiers: ['Control'] });
    await panel.page().waitForTimeout(400);
  }
}

async function openContextMenuOn(panel: Frame, title: string, zone: 'row' | 'checkbox'): Promise<void> {
  await panel.evaluate(
    (args) => {
      const rows = Array.from(document.querySelectorAll('.todo')) as HTMLElement[];
      const row = rows.find((candidate) => (candidate.textContent || '').includes(args.title));
      if (!row) throw new Error(`No panel row matching ${args.title}`);
      const target =
        args.zone === 'checkbox' ? (row.querySelector('.todo-checkbox') as HTMLElement) || row : row;
      // Real pointer coordinates: the menu positions itself at the event, so a bare dispatch would
      // open it in the panel's top-left corner, over the header rows, instead of beside the row.
      const rect = row.getBoundingClientRect();
      target.dispatchEvent(
        new MouseEvent('contextmenu', {
          button: 2,
          bubbles: true,
          cancelable: true,
          clientX: Math.round(rect.left + Math.min(180, rect.width / 3)),
          clientY: Math.round(rect.top + rect.height / 2),
        })
      );
    },
    { title, zone }
  );
  await panel.page().waitForTimeout(1500);
}

/** ------------------------------------------------------------------------------------------------
 * The run
 * --------------------------------------------------------------------------------------------- */

test.describe('README screenshots', () => {
  test.skip(!process.env.SHOWCASE, 'Set SHOWCASE=1 to capture the README screenshots');
  test.describe.configure({ retries: 0 });

  let joplin: JoplinInstance;
  let fixtures: Fixture[] = [];
  let captureNow: Date;

  test.beforeAll(async () => {
    test.setTimeout(15 * 60_000);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.mkdirSync(SCRATCH, { recursive: true });

    captureNow = armTimeShift();
    // eslint-disable-next-line no-console
    console.log(`capture clock: ${captureNow.toString()} (real: ${new Date().toString()})`);
    fixtures = buildFixtures(captureNow);

    joplin = await launchJoplin({
      settings: {
        // Joplin's own dark theme: the owner runs Joplin dark, and the whole shot set is dark-first.
        theme: 2,
        themeAutoDetect: false,
        // Joplin's one-off "Markdown is now rendered in the editor" banner would otherwise sit across
        // the foot of the hero shot. Marking the migration done is exactly what its own button does.
        'editor.migration': 1,
        richTextBannerDismissed: true,
        'clipperServer.autoStart': true,
        'api.token': API_TOKEN,
        'api.port': API_PORT,
      },
    });
    const { win } = joplin;

    // Prove the shifted clock actually reached the renderer before anything is staged against it.
    const rendererNow = await win.evaluate(() => new Date().toISOString());
    // eslint-disable-next-line no-console
    console.log(`Joplin renderer clock: ${rendererNow}`);

    await setJoplinWindowSize(win, WINDOW_WIDTH, WINDOW_HEIGHT);
    await apiReady(win);

    // Notebooks, including a sub-notebook so the notebook picker has a real path to show.
    const work = await apiPost('/folders', { title: 'Work' });
    const home = await apiPost('/folders', { title: 'Home' });
    const reading = await apiPost('/folders', { title: 'Reading' });
    const hiring = await apiPost('/folders', { title: 'Hiring', parent_id: work.id });
    const folders: Record<string, string> = {
      Work: work.id,
      Home: home.id,
      Reading: reading.id,
      Hiring: hiring.id,
    };

    // Comfortably more than the ~fifteen rows the suggestion list shows at once, so the tag: list in
    // search-autocomplete.png is visibly cut off at its scroll height rather than ending flush.
    const tagNames = [
      'admin', 'archive', 'bills', 'car', 'errand', 'family', 'finance', 'garden',
      'gifts', 'health', 'home', 'house', 'ideas', 'meetings', 'project', 'reading',
      'receipts', 'shopping', 'travel', 'urgent', 'work',
    ];
    const tags: Record<string, string> = {};
    for (const name of tagNames) tags[name] = (await apiPost('/tags', { title: name })).id;

    for (const fixture of fixtures) {
      const note = await apiPost('/notes', {
        title: fixture.title,
        body: fixture.body ?? '',
        parent_id: folders[fixture.notebook],
        is_todo: fixture.isTodo ? 1 : 0,
        todo_due: fixture.due ?? 0,
        todo_completed: fixture.completedAt ?? 0,
      });
      for (const tag of fixture.tags ?? []) {
        if (tags[tag]) await apiPost(`/tags/${tags[tag]}/notes`, { id: note.id });
      }
    }

    // Cockpit's own settings live in Joplin's database, so they go through the Options screen.
    await setCockpitSetting(win, 'Completed to-dos', 'grayed');

    // Three profiles, same criteria, one per display format - so the picker reads a different name in
    // every shot and the three views are one dataset seen three ways.
    await editCurrentProfile(win, { name: 'Everything', displayFormat: 'interval' });
    // A profile created from the "+ New profile..." dialog does NOT inherit profileDefaults: the editor
    // opens with no profile data, so every checkbox starts clear. Without these the Month grid loses its
    // completed to-do (and with it the green done dot and the +1 overflow) and both views lose the
    // undated section.
    const inherited = { showCompleted: true, showNoDue: true, noDueDatesAtEnd: true };
    await createPanelProfile(win, { name: 'Month', displayFormat: 'month', ...inherited });
    await createPanelProfile(win, { name: 'Week', displayFormat: 'week', ...inherited });
    await selectProfile(win, 'Everything');

    // The window layout is set up here rather than in the hero test so that EVERY shot is taken against
    // the same frame - a test that fails restarts the worker, and the shots after it would otherwise be
    // captured against Joplin's default arrangement.
    await activateJoplinMenuItem(win, /^Toggle sidebar$/);
    await win.waitForTimeout(1200);
    await activateJoplinMenuItem(win, /^Toggle note list$/);
    await win.waitForTimeout(1500);
    // eslint-disable-next-line no-console
    console.log('panel box before move:', JSON.stringify(await win.locator(PANEL_IFRAME).boundingBox()));
    // eslint-disable-next-line no-console
    console.log('docked left:', await dockCockpitPanelLeft(win, PANEL_IFRAME));
    await agendaPanel(win);
    await setPanelWidth(win, PANEL_WIDTH);
    // eslint-disable-next-line no-console
    console.log('panel box after layout:', JSON.stringify(await win.locator(PANEL_IFRAME).boundingBox()));

    await settlePanel(win, [
      'Pay the electricity bill',
      'Review the onboarding PR',
      'Team retrospective',
      'Renew the passport',
      'Someday: learn to sail',
    ]);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
    delete process.env.LD_PRELOAD;
    delete process.env.COCKPIT_TIME_OFFSET_SEC;
  });

  /** ---------------------------------------------------------------------------------------------
   * hero-panel.png - the whole application, Cockpit at the left edge, a note open beside its ring
   * ------------------------------------------------------------------------------------------ */
  test('hero panel', async () => {
    test.setTimeout(6 * 60_000);
    const { win } = joplin;

    // Open the note behind one of the ringed rows, so the ring's fraction and the ticked boxes in the
    // editor are the same two ticks of the same five.
    await clickPanelTodo(win, 'Review the onboarding PR');
    await win.waitForTimeout(3000);
    await showNoteViewerOnly(win);

    // Narrow the window for this shot only. Every other capture is a crop of the panel iframe, whose
    // own width is held at PANEL_WIDTH, so the window is restored afterwards and nothing else moves.
    await setJoplinWindowSize(win, HERO_WINDOW_WIDTH, WINDOW_HEIGHT);
    await setPanelWidth(win, PANEL_WIDTH);

    await waitForNotebookPills(win, 'hero');
    const panel = await agendaPanel(win);
    // eslint-disable-next-line no-console
    console.log('panel headings:', await panel.locator('.todos h2').allTextContents());
    // eslint-disable-next-line no-console
    console.log('panel iframe box:', JSON.stringify(await win.locator(PANEL_IFRAME).boundingBox()));
    // eslint-disable-next-line no-console
    console.log(
      'panel list overflows:',
      await panel
        .locator('.todos')
        .evaluate((element) => `${element.scrollHeight} / ${element.clientHeight}`)
        .catch(() => 'n/a')
    );

    await shootWindow(win, 'hero-panel.png');

    // Back to the full frame the rest of the shot list was composed against.
    await setJoplinWindowSize(win, WINDOW_WIDTH, WINDOW_HEIGHT);
    await setPanelWidth(win, PANEL_WIDTH);
  });

  /** ---------------------------------------------------------------------------------------------
   * themes.png - the same list under two Cockpit themes, Joplin itself dark throughout
   *
   * TWO panels, not three. A three-up montage is 1908px wide, and GitHub scales a README image to
   * about 890px: each panel lands near 290px and its row text is mush, which is a poor trade for a
   * third sample. Two panels keep about 435px each and stay readable.
   *
   * And there is no light sample to reach for. The panel paints itself from Joplin's
   * backgroundColor2 - the SIDEBAR colour, which is what Cockpit replaces - and every one of the
   * seven presets is dark there: light #313640, solarizedLight #002b36, nord #434c5e, solarizedDark
   * #073642, dark/oledDark #181A1D, aritimDark #141a21. "Preset - Solarized Light" draws a dark teal
   * panel, so putting it in the montage would only look like a mislabelled shot. Nord (#434c5e,
   * blue-grey) is the furthest any preset gets from Joplin's own dark (#181A1D), so it is the one
   * that shows the setting doing something. A genuinely light panel needs Custom mode.
   * ------------------------------------------------------------------------------------------ */
  test('theme montage', async () => {
    test.setTimeout(6 * 60_000);
    const { win } = joplin;
    const modes: Array<[string, string]> = [
      ['matchJoplin', 'themes-1-match.png'],
      ['nord', 'themes-2-nord.png'],
    ];
    const parts: string[] = [];
    for (const [value, name] of modes) {
      await setCockpitSetting(win, 'Cockpit panel theme', value);
      await agendaPanel(win);
      await refreshPanel(win);
      await win.waitForTimeout(2500);
      await waitForNotebookPills(win, `theme:${value}`);
      parts.push(await shootPanel(win, name));
    }
    // Back to Match Joplin: every remaining shot belongs to the one dark story.
    await setCockpitSetting(win, 'Cockpit panel theme', 'matchJoplin');
    await agendaPanel(win);
    await refreshPanel(win);

    const montage = path.join(OUT_DIR, 'themes.png');
    execFileSync('montage', [
      '-tile', '2x1',
      '-geometry', '+8+0',
      '-background', '#1b1d21',
      ...parts,
      montage,
    ]);
    captured.push(montage);
    // eslint-disable-next-line no-console
    console.log(`captured themes.png (${Math.round(fs.statSync(montage).size / 1024)} KB)`);
  });

  /** ---------------------------------------------------------------------------------------------
   * search-autocomplete.png - the tag: suggestion list, open, with two rows marked
   * ------------------------------------------------------------------------------------------ */
  test('search autocomplete', async () => {
    test.setTimeout(6 * 60_000);
    const { win } = joplin;
    await waitForNotebookPills(win, 'search');
    const panel = await agendaPanel(win);

    await panel.locator('#searchFilter').click();
    await win.keyboard.type('tag:', { delay: 120 });
    await panel.locator('#searchSuggestions').waitFor({ state: 'visible', timeout: 30_000 });
    await win.waitForTimeout(1500);

    const rows = panel.locator('#searchSuggestions .suggest-list .dropdown-item');
    const rowCount = await rows.count();
    // eslint-disable-next-line no-console
    console.log(`tag suggestions: ${rowCount}`);
    // Mark two rows: the apply button is hidden until at least one mark exists.
    await rows.nth(3).click({ modifiers: ['Control'] });
    await win.waitForTimeout(400);
    await rows.nth(8).click({ modifiers: ['Control'] });
    await win.waitForTimeout(800);
    // Park the pointer off the list so no row also carries a hover state in the shot.
    await win.mouse.move(5, 5);
    await win.waitForTimeout(600);
    // eslint-disable-next-line no-console
    console.log(
      'marked rows:',
      await panel.locator('#searchSuggestions .dropdown-item.-marked').count(),
      'apply hidden:',
      await panel.locator('#searchSuggestions .suggest-apply').getAttribute('hidden')
    );

    await shootPanel(win, 'search-autocomplete.png');

    // Never commit the query - that would replace the list with results.
    await win.keyboard.press('Escape');
    await win.waitForTimeout(800);
    await clearPanelSearch(win);
  });

  /** ---------------------------------------------------------------------------------------------
   * row-menu-multi.png - a mixed three-row selection with Cockpit's own batch menu open
   * ------------------------------------------------------------------------------------------ */
  test('multi-row context menu', async () => {
    test.setTimeout(6 * 60_000);
    const { win } = joplin;
    await waitForNotebookPills(win, 'row-menu');
    const panel = await agendaPanel(win);

    // The note is picked FIRST and the menu opened on a to-do near the top of the list, so the menu has
    // room to open downward and all three selected rows - two to-dos and a note - stay in frame.
    const selection = ['Meeting notes: Tuesday sync', 'Review the onboarding PR', 'Call the plumber'];
    await scrollPanelToTop(panel);
    await selectRows(panel, selection);
    // eslint-disable-next-line no-console
    console.log('selected rows:', await panel.locator('.todo.-selected').count());
    await openContextMenuOn(panel, 'Call the plumber', 'row');
    // eslint-disable-next-line no-console
    console.log(
      'menu labels:',
      JSON.stringify(await panel.locator('#noteContextMenu .context-menu-item').allTextContents())
    );
    await shootPanel(win, 'row-menu-multi.png');
    await win.keyboard.press('Escape');
    await win.waitForTimeout(800);
  });

  /** ---------------------------------------------------------------------------------------------
   * alarm-picker.png - the desktop date picker for a three-to-do selection
   * ------------------------------------------------------------------------------------------ */
  test('alarm picker dialog', async () => {
    test.setTimeout(6 * 60_000);
    const { win } = joplin;
    const panel = await agendaPanel(win);
    await refreshPanel(win);
    await win.waitForTimeout(1500);

    const fresh = await agendaPanel(win);
    const selection = ['Review the onboarding PR', 'Team retrospective', 'Book the flights'];
    await selectRows(fresh, selection);
    // A right click on the tick CIRCLE routes to the date picker for the whole selection.
    await openContextMenuOn(fresh, selection[2], 'checkbox');

    await expect
      .poll(
        async () => {
          for (const frame of win.frames()) {
            if (await frame.locator('#alarmForm').count().catch(() => 0)) return true;
          }
          return false;
        },
        { timeout: 45_000 }
      )
      .toBe(true);
    await win.waitForTimeout(2500);

    // From the window's left edge, so the panel the picker was opened from stays faintly behind it.
    const file = path.join(OUT_DIR, 'alarm-picker.png');
    await screenshotDialog(win, file, { fromLeftEdge: true, pad: 44 });
    captured.push(file);
    // eslint-disable-next-line no-console
    console.log(`captured alarm-picker.png (${Math.round(fs.statSync(file).size / 1024)} KB)`);

    // Cancel, so no alarm is written and the fixture stays exactly as staged, then drop the selection:
    // three highlighted rows would otherwise still be lit in the month and week shots.
    await win.locator('button:has-text("Cancel")').last().click();
    await win.waitForTimeout(2500);
    await clearRowSelection(win);
    await refreshPanel(win);
    await win.waitForTimeout(1500);
    // eslint-disable-next-line no-console
    console.log('rows still selected:', await (await agendaPanel(win)).locator('.todo.-selected').count());
    void panel;
  });

  /** ---------------------------------------------------------------------------------------------
   * month-calendar.png - the month grid with the busiest day picked
   * ------------------------------------------------------------------------------------------ */
  test('month calendar', async () => {
    test.setTimeout(6 * 60_000);
    const { win } = joplin;
    await clearRowSelection(win);
    await selectProfile(win, 'Month');
    await refreshPanel(win);
    await win.waitForTimeout(2000);
    await refreshPanel(win);
    await win.waitForTimeout(2000);

    await selectCalendarDay(win, captureNow.getDate());
    await win.waitForTimeout(2000);
    const panel = await agendaPanel(win);
    // eslint-disable-next-line no-console
    console.log(
      'selected-day rows:',
      await panel.locator('.calendar-selected .todo-title').allTextContents()
    );
    // eslint-disable-next-line no-console
    console.log('dotted day cells:', await panel.locator('.calendar-day:has(.calendar-dot)').count());
    await shootPanelToContent(win, 'month-calendar.png');
  });

  /** ---------------------------------------------------------------------------------------------
   * week-planner.png - one section per day of the current week
   * ------------------------------------------------------------------------------------------ */
  test('week planner', async () => {
    test.setTimeout(6 * 60_000);
    const { win } = joplin;
    await clearRowSelection(win);
    await selectProfile(win, 'Week');
    await refreshPanel(win);
    await win.waitForTimeout(2000);
    await refreshPanel(win);
    await win.waitForTimeout(2000);
    // eslint-disable-next-line no-console
    console.log('week day headings:', await weekPlannerDays(win));
    await shootPanelToContent(win, 'week-planner.png');

    await selectProfile(win, 'Everything');
    // eslint-disable-next-line no-console
    console.log('captured files:', captured.join(', '));
  });
});
