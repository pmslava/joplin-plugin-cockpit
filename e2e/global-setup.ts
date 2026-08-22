import { acquireLock, runOrphanSweep, checkRamGate } from './guard';

/**
 * Runs once in Playwright's main process, before any worker spawns a Joplin. It takes the
 * one-run-machine-wide lock (failing fast if another run holds it), reaps orphans a previous crashed
 * run left behind, then gates on available RAM. See e2e/guard.ts for the details.
 */
export default async function globalSetup(): Promise<void> {
  acquireLock(); // installs crash/interrupt handlers; throws if another run is active
  await runOrphanSweep(); // reap Joplin/Xvfb/profiles left by a previous dead run
  checkRamGate(); // refuse (locally) to start when memory is already dangerously low
}
