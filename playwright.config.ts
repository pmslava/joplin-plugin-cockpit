import { defineConfig } from '@playwright/test';
import { LOCK_WAIT_MS } from './e2e/guard';

/**
 * Playwright config for the real-app Joplin end-to-end tests.
 *
 * These tests launch the actual Joplin desktop (Electron) build with this plugin loaded as a
 * development plugin, and drive the genuine GUI. They are intentionally serial (a single Joplin
 * instance, one profile at a time) and have generous timeouts because launching Joplin and waiting
 * for the plugin/runtime to initialise is slow.
 *
 * Run with:  npm run test:e2e   (which wraps `playwright test` in xvfb-run for a virtual display)
 */
export default defineConfig({
  testDir: './e2e',
  // Resource-safety guard (see e2e/guard.ts): a machine-wide lock so only one Joplin E2E run exists
  // at a time across all sibling repos — queueing behind a run that is already going — a pre-run
  // sweep that reaps orphans a previous crashed run left behind, and a soft RAM gate.
  // globalTeardown releases the lock.
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  // Launching Joplin + waiting for the plugin to register can take a while on a cold profile, and
  // some tests wait out more than one of the panel's fallback refresh intervals.
  timeout: 240_000,
  // A stuck suite must stop itself before the CI job's timeout-minutes hard-cancels it: a global
  // timeout ends the run gracefully and still writes the HTML report and traces (a hard cancel does
  // not), so failures stay diagnosable. Kept comfortably under the workflow's 20-minute job cap.
  //
  // globalTimeout covers globalSetup too, so time spent queueing for the machine-wide lock would
  // otherwise come out of the suite's budget. Locally the lock-wait budget is therefore ADDED on top
  // (the suite still gets its full 18 minutes once its turn comes); on CI each repo has its own VM,
  // the lock is never contended, and the cap stays exactly where the job's own limit needs it.
  //
  // Raised from 18 to 25 minutes when the mobile touch-drag spec became the seventeenth file: each file launches
  // its own Joplin, and this one seeds ~55 to-dos through the data API and then runs eleven gesture cases that
  // each wait out a settle and a panel refresh. A healthy full run is still well under the cap; what the cap is
  // for is a stuck one ending itself gracefully, with its report and traces written.
  globalTimeout: 25 * 60_000 + (process.env.CI ? 0 : LOCK_WAIT_MS),
  expect: { timeout: 20_000 },
  // A single Joplin instance at a time.
  fullyParallel: false,
  workers: 1,
  // How quickly a change reaches the panel depends on when Joplin next brings its search index up
  // to date, which it does on a timer of its own and which slows down when the machine is busy. The
  // specs pass consistently on their own, but back to back a run occasionally overshoots even a
  // generous timeout, so a failed test gets one retry rather than failing the whole run.
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
