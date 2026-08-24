/**
 * Shared resource-safety guard for the real-app Joplin E2E harness.
 *
 * The suite launches a real Joplin desktop (Electron) build under Xvfb. Two failure modes have
 * repeatedly hurt the developer laptop this runs on:
 *
 *   1. A SIGKILLed / crashed run skips Playwright's per-spec `afterAll` teardown, orphaning the
 *      Joplin process tree, the Xvfb server, /tmp/.X<n>-lock files and throwaway profile dirs.
 *   2. Two runs at once (different repos / worktrees / shells) stack multiple real Joplins on a
 *      16 GB machine and drive it into swap / OOM.
 *
 * This module adds, with identical semantics across the sibling plugin repos that share this
 * harness:
 *   - a machine-wide lock so only ONE E2E run exists at a time, across ALL repos (a run that finds
 *     the lock held QUEUES behind the holder instead of failing on the spot);
 *   - a deterministic pre-run sweep that reaps orphans left by a previous dead run;
 *   - best-effort in-process teardown on crash / interrupt (signal + exit handlers);
 *   - a soft RAM gate that refuses to start when memory is already dangerously low.
 *
 * Everything that touches a process or a display is anchored on THIS repo's absolute
 * `.e2e-cache/squashfs-root` (or its throwaway-profile) path, so it can never match the developer's
 * real Joplin desktop, which runs from /tmp/.mount_*.
 *
 * Linux-only, matching the harness (Xvfb + AppImage). Process discovery reads /proc directly rather
 * than shelling out to pgrep/ps: no dependency, deterministic, and it cannot accidentally match its
 * own command line.
 *
 * The file is deliberately free of any repo-specific constant (paths are derived from __dirname) so
 * it can stay byte-identical across the sibling repos that fork this harness.
 */
import { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Repo-relative anchors, derived the same way launch.ts derives them.
const REPO_ROOT = path.resolve(__dirname, '..');
const EXTRACT_DIR = path.join(REPO_ROOT, '.e2e-cache', 'squashfs-root');
const PROFILES_ROOT = path.join(REPO_ROOT, 'e2e', '.profiles');

// One lock for ALL repos on this machine: a run in any sibling repo blocks the others.
//
// PROTOCOL — must stay identical in every sibling repo, or the repos stop excluding each other:
//   * the lock IS the directory below (mkdir is an atomic test-and-set on every filesystem);
//   * the holder writes its pid into `<lock>/pid`; a lock whose pid is not alive is stale and may be
//     reclaimed; `<lock>/owner` is an advisory extra (repo path + start time) a waiter reports, and a
//     sibling repo that writes only `pid` stays fully compatible;
//   * the holder removes the directory to release.
const LOCK_DIR = path.join(os.homedir(), '.cache', 'joplin-plugin-e2e.lock');
const LOCK_PID_FILE = path.join(LOCK_DIR, 'pid');
const LOCK_OWNER_FILE = path.join(LOCK_DIR, 'owner');

/**
 * How long to QUEUE behind a live run before giving up (`E2E_LOCK_WAIT_MS` overrides; 0 = fail fast,
 * the pre-2.1.0 behaviour). Two sibling repos are routinely driven from two sessions, and a run that
 * simply waits its turn is worth far more than one that aborts and leaves a human polling by hand.
 * The budget is ADDED to the suite's globalTimeout locally (see playwright.config.ts), so queueing
 * never eats into the suite's own time.
 */
export const LOCK_WAIT_MS = resolveLockWaitMs();
const LOCK_POLL_MS = 2_000;
const LOCK_PROGRESS_MS = 30_000;
/**
 * A lock whose `pid` file has not appeared yet is presumed LIVE for this long. The holder writes its
 * pid microseconds after the mkdir, so a pid-less lock is almost always a run that has just this
 * instant taken it — reading that as "stale" is exactly how a second run breaks a LIVE lock. Only a
 * pid-less lock older than this is debris.
 */
const LOCK_PID_GRACE_MS = 30_000;

function resolveLockWaitMs(): number {
  const raw = process.env.E2E_LOCK_WAIT_MS;
  if (raw === undefined || raw.trim() === '') return 10 * 60_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10 * 60_000;
}

// Refuse to start a fresh Joplin below this much available memory. The heaviest E2E Joplin (the
// 3.7.x AppImage some repos pin) needs well over a GiB, and the real desktop is already resident.
const MIN_AVAILABLE_KIB = 3 * 1024 * 1024; // 3 GiB

// The exact server-args the harness passes to xvfb-run; used to recognise our own orphaned Xvfb and
// never someone else's (or the real :0 display, which is an Xorg server with different args).
const XVFB_ARGS_NEEDLE = '-screen 0 1920x1080x24';

interface TrackedInstance {
  child: ChildProcess;
  profileDir: string;
}

const liveInstances = new Set<TrackedInstance>();
let weOwnLock = false;
let handlersInstalled = false;
let cleanedUp = false;

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[e2e-guard] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** True if the pid exists (or exists but is not ours — treated as alive, conservatively). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (dead). EPERM = exists but not ours — be conservative, treat as alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ---- /proc helpers -------------------------------------------------------------------------------

function listProcPids(): number[] {
  const pids: number[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return pids;
  }
  for (const e of entries) {
    if (/^\d+$/.test(e)) pids.push(Number(e));
  }
  return pids;
}

/** Null-separated argv of a process, or null if it vanished / is unreadable. */
function readCmdline(pid: number): string[] | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (!raw) return [];
    return raw.split('\0').filter((s) => s.length > 0);
  } catch {
    return null;
  }
}

/** Parse the pieces of /proc/<pid>/stat we need, robust to spaces/parens inside the comm field. */
function readStat(pid: number): { state: string; ppid: number } | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm (field 2) is wrapped in parens and may itself contain spaces/parens: parse after the
    // last ')'. What follows is: state ppid pgrp ...
    const rparen = stat.lastIndexOf(')');
    if (rparen < 0) return null;
    const rest = stat.slice(rparen + 2).trim().split(/\s+/);
    const state = rest[0];
    const ppid = Number(rest[1]);
    if (!state || !Number.isFinite(ppid)) return null;
    return { state, ppid };
  } catch {
    return null;
  }
}

/** Confirm a pid is really gone (reaped, or a zombie whose resources are already released). */
async function confirmDead(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (!isAlive(pid)) return true; // reaped
    if (readStat(pid)?.state === 'Z') return true; // zombie — its X socket is already gone
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
}

// ---- Machine-wide lock ---------------------------------------------------------------------------

function readLockPid(): number | null {
  try {
    const pid = Number(fs.readFileSync(LOCK_PID_FILE, 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** How long the lock directory has existed, or Infinity when it cannot be stat'ed. */
function lockAgeMs(): number {
  try {
    return Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
  } catch {
    return Infinity;
  }
}

/** The holder's advisory description ("<repo> since <time>"), or null when it wrote none. */
function readLockOwner(): string | null {
  try {
    const owner = fs.readFileSync(LOCK_OWNER_FILE, 'utf8').trim();
    return owner.length > 0 ? owner : null;
  } catch {
    return null;
  }
}

function describeHolder(pid: number | null, owner: string | null): string {
  const who = pid === null ? 'unknown pid' : `pid ${pid}`;
  return owner ? `${who}, ${owner}` : who;
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return mins > 0 ? `${mins}m${String(secs).padStart(2, '0')}s` : `${secs}s`;
}

type LockAttempt =
  | { status: 'acquired' }
  /** A live run holds the lock; the caller decides whether to wait. */
  | { status: 'held'; pid: number | null; owner: string | null }
  /** A stale lock was broken, or another process won a race — retry immediately. */
  | { status: 'retry' };

/** One atomic attempt at the lock. Never blocks: the waiting policy lives in acquireLock(). */
function tryTakeLock(): LockAttempt {
  try {
    fs.mkdirSync(LOCK_DIR); // atomic test-and-set: throws EEXIST if the lock is held
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const holder = readLockPid();
    if (holder !== null && isAlive(holder)) {
      return { status: 'held', pid: holder, owner: readLockOwner() };
    }
    if (holder === null && lockAgeMs() < LOCK_PID_GRACE_MS) {
      // The lock exists but names no pid yet: whoever won the mkdir a moment ago is about to write
      // it. Treat that as held — breaking it here is exactly how two runs both end up "owning" it.
      return { status: 'held', pid: null, owner: null };
    }
    // Stale: the holder is gone (crashed / SIGKILLed before its teardown). Break it by RENAMING the
    // directory aside rather than removing it in place — rename(2) succeeds for exactly one process,
    // so two reclaimers racing cannot both conclude they own the lock (the loser gets ENOENT, sees
    // 'retry' and comes back round to a plain mkdir).
    log(`Reclaiming stale E2E lock at ${LOCK_DIR} (holder ${holder ?? 'unknown'} is not alive).`);
    const aside = `${LOCK_DIR}.stale-${process.pid}-${Date.now()}`;
    try {
      fs.renameSync(LOCK_DIR, aside);
    } catch {
      return { status: 'retry' }; // another process broke it first
    }
    try {
      fs.rmSync(aside, { recursive: true, force: true });
    } catch {
      /* the lock is already gone as far as the protocol is concerned */
    }
    return { status: 'retry' };
  }

  weOwnLock = true;
  try {
    fs.writeFileSync(LOCK_PID_FILE, String(process.pid), 'utf8'); // first: a pid-less lock is ambiguous
    fs.writeFileSync(LOCK_OWNER_FILE, `${REPO_ROOT} since ${new Date().toISOString()}`, 'utf8');
  } catch {
    /* both files are advisory; the directory itself is the lock */
  }
  installSignalHandlers();
  return { status: 'acquired' };
}

/**
 * Acquire the machine-wide lock, QUEUEING behind a live run rather than failing on the spot: the
 * sibling repos are routinely driven from two sessions, and the point of the lock is to serialise
 * them, not to make a human poll. A stale lock left by a dead run is reclaimed at once. Gives up
 * after LOCK_WAIT_MS with an error that names the holder. Must be called before anything spawns.
 */
export async function acquireLock(): Promise<void> {
  fs.mkdirSync(path.dirname(LOCK_DIR), { recursive: true });
  const startedAt = Date.now();
  const deadline = startedAt + LOCK_WAIT_MS;
  let announced = false;
  let lastProgress = startedAt;
  let breaks = 0;

  for (;;) {
    const attempt = tryTakeLock();
    if (attempt.status === 'acquired') {
      const waited = Date.now() - startedAt;
      log(
        `Acquired machine-wide E2E lock (pid ${process.pid}) at ${LOCK_DIR}` +
          (announced ? ` after waiting ${formatDuration(waited)}` : '')
      );
      return;
    }
    if (attempt.status === 'retry') {
      // Each retry means someone (us or another acquirer) just broke a stale lock, so the loop makes
      // progress; the cap only guarantees termination if the lock directory is somehow pathological.
      if (++breaks > 100) {
        throw new Error(`Could not settle the E2E lock at ${LOCK_DIR}: it keeps reappearing stale.`);
      }
      await sleep(50);
      continue;
    }

    const holder = describeHolder(attempt.pid, attempt.owner);
    if (LOCK_WAIT_MS === 0) {
      throw new Error(
        `Another Joplin E2E run is active (${holder}); one run machine-wide — resource ` +
          `discipline.\nLock: ${LOCK_DIR}\nUnset E2E_LOCK_WAIT_MS=0 to queue behind it instead.`
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Another Joplin E2E run is STILL active after waiting ` +
          `${formatDuration(Date.now() - startedAt)} (${holder}); one run machine-wide — resource ` +
          `discipline.\nLock: ${LOCK_DIR}\nRetry once that run finishes, raise the budget with ` +
          `E2E_LOCK_WAIT_MS=<ms>, or — only if you are certain no run is active — remove that ` +
          `directory.`
      );
    }
    if (!announced) {
      announced = true;
      lastProgress = Date.now();
      log(
        `Machine-wide E2E lock is held by a live run (${holder}); one run machine-wide — waiting ` +
          `up to ${formatDuration(LOCK_WAIT_MS)} for it to finish (E2E_LOCK_WAIT_MS to change).`
      );
    } else if (Date.now() - lastProgress >= LOCK_PROGRESS_MS) {
      lastProgress = Date.now();
      log(
        `Still waiting for the E2E lock — ${formatDuration(Date.now() - startedAt)} elapsed, ` +
          `${formatDuration(deadline - Date.now())} left (holder ${holder} is alive).`
      );
    }
    await sleep(LOCK_POLL_MS);
  }
}

/** Release the lock, but only if this process is the one that took it. Safe to call repeatedly. */
export function releaseLock(): void {
  if (!weOwnLock) return;
  weOwnLock = false;
  // Never remove a directory that is no longer ours: if a stale-lock reclaim elsewhere ever took it
  // from us, deleting it would hand a third run the lock a live run is holding.
  const holder = readLockPid();
  if (holder !== null && holder !== process.pid) {
    log(`E2E lock at ${LOCK_DIR} is now held by pid ${holder}; leaving it alone.`);
    return;
  }
  try {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    log('Released machine-wide E2E lock.');
  } catch {
    /* ignore */
  }
}

// ---- Pre-run orphan sweep ------------------------------------------------------------------------

/**
 * Reap resources left behind by a previous run that died without teardown. Deterministic and strictly
 * anchored on this repo's own paths, so the real desktop Joplin can never be a target. Runs after the
 * lock is held, so no concurrent run of this harness can be mid-launch while we sweep.
 */
export async function runOrphanSweep(): Promise<void> {
  sweepOrphanJoplins();
  await sweepOrphanXvfb();
  sweepStaleProfiles();
}

function sweepOrphanJoplins(): void {
  for (const pid of listProcPids()) {
    if (pid === process.pid) continue;
    const argv = readCmdline(pid);
    if (!argv || argv.length === 0) continue;
    const cmd = argv.join(' ');
    // Anchor strictly on THIS repo's extracted binary dir or its throwaway-profile dir. Every process
    // in the Electron tree (main, renderers, GPU, zygotes) re-execs the same binary, so this one
    // needle catches the whole tree. The real desktop runs from /tmp/.mount_* and can never match.
    if (cmd.includes(EXTRACT_DIR) || cmd.includes(PROFILES_ROOT)) {
      try {
        process.kill(pid, 'SIGKILL');
        log(`Swept leftover Joplin process pid ${pid} from a previous dead run.`);
      } catch {
        /* already gone */
      }
    }
  }
}

async function sweepOrphanXvfb(): Promise<void> {
  for (const pid of listProcPids()) {
    if (pid === process.pid) continue;
    const argv = readCmdline(pid);
    if (!argv || argv.length === 0) continue;
    if (path.basename(argv[0]) !== 'Xvfb') continue;
    // Only OUR harness's Xvfb (its exact server-args) and only if orphaned (reparented to init). A
    // live run's Xvfb is a child of its xvfb-run wrapper, not of pid 1, so it is never matched.
    if (!argv.join(' ').includes(XVFB_ARGS_NEEDLE)) continue;
    if (readStat(pid)?.ppid !== 1) continue;

    const display = parseDisplayNumber(argv);
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    log(`Swept orphaned Xvfb pid ${pid}${display !== null ? ` (display :${display})` : ''}.`);

    // Remove the X lock only for a display whose Xvfb we have confirmed dead, and never :0 (the real
    // display), so xvfb-run's `-a` auto-picker sees the display as free again.
    if (display !== null && display !== 0 && (await confirmDead(pid, 1000))) {
      for (const f of [`/tmp/.X${display}-lock`, `/tmp/.X11-unix/X${display}`]) {
        try {
          fs.rmSync(f, { force: true });
          log(`Removed stale ${f}.`);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/** Xvfb's display is the first ":N" token, e.g. `Xvfb :99 -screen 0 ...`. */
function parseDisplayNumber(argv: string[]): number | null {
  for (const a of argv) {
    const m = /^:(\d+)$/.exec(a);
    if (m) return Number(m[1]);
  }
  return null;
}

function sweepStaleProfiles(): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(PROFILES_ROOT);
  } catch {
    return; // no profiles dir yet
  }
  for (const name of entries) {
    if (!name.startsWith('profile-')) continue;
    const dir = path.join(PROFILES_ROOT, name);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      log(`Removed stale profile dir ${dir}.`);
    } catch {
      /* ignore */
    }
  }
}

// ---- Soft RAM gate -------------------------------------------------------------------------------

function readMemAvailableKib(): number | null {
  try {
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Refuse (locally) to start a run when memory is already dangerously low, so an E2E Joplin cannot
 * tip the live desktop into OOM. On CI, or with E2E_IGNORE_RAM set, warn instead of abort.
 */
export function checkRamGate(): void {
  const availKib = readMemAvailableKib();
  if (availKib === null) {
    log('Could not read MemAvailable from /proc/meminfo; skipping RAM gate.');
    return;
  }
  if (availKib >= MIN_AVAILABLE_KIB) return;

  const availMib = Math.round(availKib / 1024);
  const minMib = Math.round(MIN_AVAILABLE_KIB / 1024);
  if (process.env.CI || process.env.E2E_IGNORE_RAM) {
    log(
      `WARNING: only ${availMib} MiB available (< ${minMib} MiB); proceeding anyway ` +
        `(${process.env.CI ? 'CI' : 'E2E_IGNORE_RAM'} set).`
    );
    return;
  }
  throw new Error(
    `Only ${availMib} MiB RAM available (< ${minMib} MiB): refusing to launch a Joplin E2E run and ` +
      `risk an OOM on the desktop. Close things and retry, or set E2E_IGNORE_RAM=1 to override.`
  );
}

// ---- Best-effort in-process teardown -------------------------------------------------------------

/**
 * Track a spawned Joplin so a crash/interrupt handler can reap its whole process group and remove
 * its profile. The happy-path closeJoplin() stays the authority: entries whose child the runtime has
 * already reaped are skipped here, which also prevents ever acting on a recycled pid.
 */
export function registerInstance(child: ChildProcess, profileDir: string): void {
  // Prune already-exited entries so the set does not grow across a long suite.
  for (const inst of liveInstances) {
    if (inst.child.exitCode !== null || inst.child.signalCode !== null) liveInstances.delete(inst);
  }
  liveInstances.add({ child, profileDir });
  installSignalHandlers();
}

function killInstanceGroup(inst: TrackedInstance): void {
  const { child, profileDir } = inst;
  // Only touch instances the runtime has NOT already reaped: if exitCode/signalCode is set the pid is
  // done and may have been recycled, so we must not signal it.
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (typeof pid === 'number') {
    try {
      // Joplin is spawned detached (own process group), so a negative pid nukes the whole Electron
      // tree — main, renderers, GPU, zygotes — not just the group leader.
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function cleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const inst of liveInstances) killInstanceGroup(inst);
  liveInstances.clear();
  releaseLock();
}

/**
 * Install crash/interrupt handlers once per process. Deliberately non-invasive: when another owner
 * (e.g. Playwright's own handlers) is present, defer to it and let the always-safe 'exit' handler be
 * the backstop, so the happy path and CI are never disturbed.
 */
export function installSignalHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  // Always-safe backstop: runs on every clean process exit, including a process.exit() that another
  // owner triggers after handling a signal. Only acts on still-live instances, so it no-ops once the
  // happy-path teardown has run.
  process.on('exit', () => cleanup());

  const onSignal = (sig: NodeJS.Signals) => {
    // If another listener is present (Playwright drives its own graceful shutdown), defer to it and
    // let 'exit' — or, failing that, the next run's sweep — do the cleanup.
    if (process.listenerCount(sig) > 1) return;
    cleanup();
    process.removeAllListeners(sig);
    try {
      process.kill(process.pid, sig); // re-raise so the exit code reflects the signal
    } catch {
      process.exit(sig === 'SIGINT' ? 130 : 143);
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  process.on('uncaughtException', (err) => {
    // If an owner (e.g. Playwright) also handles this, let it attribute the error and decide; our
    // 'exit' handler will still free resources when the process eventually ends.
    if (process.listenerCount('uncaughtException') > 1) return;
    // eslint-disable-next-line no-console
    console.error('[e2e-guard] uncaughtException — tearing down E2E resources:', err);
    cleanup();
    process.exit(1);
  });
}
