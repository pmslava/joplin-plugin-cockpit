import { acquireLock, runOrphanSweep, checkRamGate, releaseLock } from './guard';

/**
 * Runs once in Playwright's main process, before any worker spawns a Joplin. It takes the
 * one-run-machine-wide lock — queueing behind another live run until it finishes, since the sibling
 * repos share this lock and a harper run should be waited out rather than raced — reaps orphans a
 * previous crashed run left behind, then gates on available RAM. See e2e/guard.ts.
 *
 * Anything that throws AFTER the lock is taken releases it on the way out: Playwright does not run
 * globalTeardown when globalSetup throws, so a failed RAM gate would otherwise leave the lock standing
 * until the process-exit handler happened to fire — and a lock nobody owns is exactly what makes the
 * next run wait out its whole budget for a holder that is already gone.
 */
export default async function globalSetup(): Promise<void> {
  // Waits out a live run (E2E_LOCK_WAIT_MS, default 10 min); throws only if it never gets the lock.
  await acquireLock(); // also installs the crash/interrupt handlers
  try {
    await runOrphanSweep(); // reap Joplin/Xvfb/profiles left by a previous dead run
    checkRamGate(); // refuse (locally) to start when memory is already dangerously low
  } catch (err) {
    releaseLock();
    throw err;
  }
}
