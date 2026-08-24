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
 * This module adds:
 *   - a machine-wide lock so only ONE E2E run exists at a time, across ALL repos (a run that finds
 *     the lock held QUEUES behind the holder instead of failing on the spot) — the LOCK is the one
 *     part of this module whose semantics are kept identical to the sibling repos', because they
 *     have to agree on it to exclude each other; the rest below is this repo's own;
 *   - a deterministic pre-run sweep that reaps orphans left by a previous dead run;
 *   - best-effort in-process teardown on crash / interrupt (signal + exit handlers);
 *   - a soft RAM gate that refuses to start when memory is already dangerously low.
 *
 * Everything that touches a process or a display is anchored on THIS repo's absolute
 * `.e2e-cache/squashfs-root` (or its throwaway-profile) path, so it can never match the developer's
 * real Joplin desktop, which runs from /tmp/.mount_*, AND on the process being an orphan
 * (reparented to init), so a LIVE run of this same checkout is never a target either.
 *
 * Linux-only, matching the harness (Xvfb + AppImage). Process discovery reads /proc directly rather
 * than shelling out to pgrep/ps: no dependency, deterministic, and it cannot accidentally match its
 * own command line.
 *
 * LOCKSTEP: the machine-wide LOCK PROTOCOL below — its constants, its staleness rules and its
 * reclaim sequence — is kept in SEMANTIC lockstep with the sibling harnesses (cockpit / harper /
 * ridgeline); the repos stop excluding each other the moment those semantics diverge. The rest of
 * this file is neither byte-identical nor required to be: the sweeps, the teardown and the logging
 * style have each evolved to fit their own repo.
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
//   * the holder removes the directory to release;
//   * a stale lock is broken only from under the reclaim lock below, and only after re-checking the
//     lock directory's identity there — see reclaimStaleLock().
const LOCK_DIR = path.join(os.homedir(), '.cache', 'joplin-plugin-e2e.lock');
const LOCK_PID_FILE = path.join(LOCK_DIR, 'pid');
const LOCK_OWNER_FILE = path.join(LOCK_DIR, 'owner');

/**
 * Reclaim intent lock — the fix for the stale-reclaim race.
 *
 * Breaking a stale lock is a judge-then-rename sequence, and rename(2) is atomic but UNCONDITIONAL:
 * it moves whatever sits at the path, not the incarnation the verdict was formed about. Two
 * acquirers that both judged the SAME stale lock therefore each renamed "the lock" aside, and the
 * loser carried off the winner's freshly created LIVE lock, leaving the path free for a third
 * mkdir — two runs, one lock (reproduced in 20-40% of six-way races).
 *
 * mkdir is the only compare-and-swap a filesystem offers, so the judge-then-rename sequence is
 * serialised behind a SECOND mkdir: only the holder of this directory may break a stale lock, and
 * it re-forms its verdict while holding it.
 *
 * This directory is itself broken by the SAME rename-and-prove sequence, never by an unconditional
 * remove — breaking it the sloppy way would just move the original race down one level. It is
 * breakable only when its holder is dead, or when it never named one and has sat past its TTL: a
 * reclaimer that is merely slow (suspended, blocked on a hung filesystem) is waited out rather than
 * broken, and LOCK_RETRY_CAP bounds that wait with a diagnostic rather than a hang.
 */
const LOCK_RECLAIM_DIR = `${LOCK_DIR}.reclaim`;
const LOCK_RECLAIM_PID_FILE = path.join(LOCK_RECLAIM_DIR, 'pid');
/**
 * How long a reclaim lock that names NO pid may sit before it counts as stranded. It is held for a
 * handful of syscalls and names its holder immediately, so this is four orders of magnitude of
 * headroom. A reclaim lock that DOES name a pid is judged by that pid alone, never by age.
 */
const LOCK_RECLAIM_TTL_MS = 10_000;
/**
 * How many 'retry' rounds acquireLock() tolerates before declaring the lock pathological. A retry
 * costs 50 ms, so this is a 20 s ceiling — deliberately well past LOCK_RECLAIM_TTL_MS, so a reclaim
 * lock stranded pid-less always self-heals before an acquirer gives up on it.
 */
const LOCK_RETRY_CAP = 400;

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
/** The incarnation of LOCK_DIR this process created; see incarnationOf() and releaseLock(). */
let ourLockIncarnation: string | null = null;
/** The incarnation of LOCK_RECLAIM_DIR this process took; see releaseReclaimLock(). */
let ourReclaimIncarnation: string | null = null;
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

/** /proc entries this scan could not read for lack of permission (see reportProcDenied). */
let procDenied = 0;

/** Null-separated argv of a process, or null if it vanished / is unreadable. */
function readCmdline(pid: number): string[] | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (!raw) return [];
    return raw.split('\0').filter((s) => s.length > 0);
  } catch (err) {
    // A process that exits between readdir and read is routine and silent; a permission denial is
    // not — it means the sweep is BLIND to that process — so it is counted and reported once.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') procDenied++;
    return null;
  }
}

/** One summary line per sweep rather than per-entry noise. Resets the counter. */
function reportProcDenied(): void {
  if (procDenied === 0) return;
  const n = procDenied;
  procDenied = 0;
  log(
    `WARNING: could not read ${n} /proc entr${n === 1 ? 'y' : 'ies'} (permission denied); ` +
      `leftover E2E processes owned by another user, or hidden by a hidepid mount, are invisible ` +
      `to the sweep.`
  );
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
    if (!state || !Number.isInteger(ppid)) return null;
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

/** Parse a pid file written by the lock protocol: null when absent, empty or not a pid. */
function readPidFile(file: string): number | null {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readLockPid(): number | null {
  return readPidFile(LOCK_PID_FILE);
}

/**
 * When a lock directory was created. NOT mtime: writing `pid` and `owner` INTO the directory updates
 * its mtime, so an mtime-derived age silently resets the pid grace below. btime is stamped once at
 * mkdir and no later write moves it (verified on this machine's btrfs $HOME and on tmpfs).
 * Filesystems that record no btime report 0 or the epoch; there we fall back to mtime, which is the
 * behaviour this guard has always had.
 */
function createdMs(st: fs.Stats): number {
  const birth = st.birthtimeMs;
  return birth > 0 && birth <= Date.now() + 1_000 ? birth : st.mtimeMs;
}

/** How long the lock directory has existed, or Infinity when it cannot be stat'ed. */
function lockAgeMs(): number {
  try {
    return Date.now() - createdMs(fs.statSync(LOCK_DIR));
  } catch {
    return Infinity;
  }
}

/**
 * A token identifying one INCARNATION of a lock directory, so a reclaim can prove that what it
 * carried off is the same directory its verdict was formed about. Inode numbers are recycled after
 * a delete, so the creation timestamp is folded in: two incarnations would have to share a device,
 * an inode AND a sub-millisecond birth time to be confused. rename(2) preserves all three, so the
 * token survives the move aside.
 */
function incarnationOf(dir: string): string | null {
  try {
    const st = fs.statSync(dir);
    return `${st.dev}:${st.ino}:${createdMs(st)}`;
  } catch {
    return null;
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
  /** `contended` = another acquirer holds the reclaim lock; `broke` = a stale lock was broken. */
  | { status: 'retry'; reason: 'broke' | 'contended' };

/**
 * True when the reclaim lock was left behind by a process that died mid-reclaim.
 *
 * The pid decides FIRST, and a live pid decides outright: a reclaimer that has stalled — suspended,
 * blocked on a hung filesystem — is slow, not dead, and breaking its intent lock would put two
 * reclaimers back into the sequence this lock exists to serialise. Age is consulted ONLY for a lock
 * that names no pid at all, where it is the only way to tell "created a microsecond ago" from
 * "created by a process that died before it could write".
 */
function reclaimLockIsStranded(): boolean {
  const pid = readPidFile(LOCK_RECLAIM_PID_FILE);
  if (pid !== null) return !isAlive(pid);
  let ageMs: number;
  try {
    ageMs = Date.now() - createdMs(fs.statSync(LOCK_RECLAIM_DIR));
  } catch {
    return false; // already gone; the caller's next mkdir settles it
  }
  return ageMs >= LOCK_RECLAIM_TTL_MS;
}

/**
 * Take the reclaim intent lock, or report that another acquirer is already breaking the lock.
 *
 * Breaking a STRANDED intent lock is the same hazard one level down, so it is broken the same way
 * the outer lock is: rename the judged incarnation aside, then prove that what was carried off is
 * the incarnation the verdict was formed about. Two acquirers that both judged the same stranded
 * lock cannot therefore both end up holding it — the one whose rename carried off the other's fresh
 * intent lock puts it back and returns false.
 *
 * Once this returns true the caller's exclusivity is self-sustaining: the directory names a LIVE
 * pid, and reclaimLockIsStranded() above never reports a live-pid lock as stranded, so no other
 * acquirer may legitimately break it. The only opening is the instant between the mkdir and the pid
 * write, which the read-back below closes: a holder whose incarnation is no longer at the path lost
 * it during that instant, and is told so rather than proceeding.
 */
function tryTakeReclaimLock(): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(LOCK_RECLAIM_DIR); // the second compare-and-swap; this one serialises reclaimers
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (attempt > 0) return false; // someone re-took it the instant we cleared it
      const judged = incarnationOf(LOCK_RECLAIM_DIR);
      if (judged === null) continue; // it vanished; go straight back to the mkdir
      if (!reclaimLockIsStranded()) return false;
      log(`Clearing a stranded E2E reclaim lock at ${LOCK_RECLAIM_DIR}.`);
      const aside = `${LOCK_RECLAIM_DIR}.stale-${process.pid}-${Date.now()}`;
      try {
        fs.renameSync(LOCK_RECLAIM_DIR, aside);
      } catch {
        return false; // someone broke it first
      }
      const moved = incarnationOf(aside);
      if (moved !== null && moved !== judged) {
        // We carried off an intent lock created AFTER our verdict — someone else broke the stranded
        // one and took it. Put it back and lose deliberately, saying so: a reclaimer that stands
        // down silently is indistinguishable from one that never tried.
        log(
          `Another acquirer took the E2E reclaim lock at ${LOCK_RECLAIM_DIR} first; putting its ` +
            `lock back and standing down.`
        );
        try {
          fs.renameSync(aside, LOCK_RECLAIM_DIR);
        } catch (err2) {
          log(`WARNING: could not restore an E2E reclaim lock: ${(err2 as Error).message}; it is at ${aside}.`);
        }
        return false;
      }
      try {
        fs.rmSync(aside, { recursive: true, force: true });
      } catch {
        /* debris only; sweepLockDebris() removes it */
      }
      continue;
    }
    try {
      fs.writeFileSync(LOCK_RECLAIM_PID_FILE, String(process.pid), 'utf8');
    } catch {
      /* the read-back below turns a failed write into a clean loss, never a silent hold */
    }
    // Read back the PID FILE, not the incarnation. The incarnation token is derived from the
    // directory's creation time, and on a filesystem that records no btime that falls back to
    // mtime — which the write above has just moved, so the comparison could never match and every
    // acquirer would spin out its retry budget. The pid is stable on every filesystem and answers
    // the same question: did anyone break our lock in the instant before it named us? A lock that
    // was broken and retaken names someone else; one broken and not yet retaken names nobody.
    if (readPidFile(LOCK_RECLAIM_PID_FILE) !== process.pid) {
      log(`Lost the E2E reclaim lock at ${LOCK_RECLAIM_DIR} before it named us; retrying.`);
      return false;
    }
    // AFTER the write, for the same reason the outer lock's token is taken after its writes.
    ourReclaimIncarnation = incarnationOf(LOCK_RECLAIM_DIR);
    return true;
  }
  return false;
}

/** Release the reclaim intent lock — but only the incarnation this process actually took. */
function releaseReclaimLock(): void {
  const ours = ourReclaimIncarnation;
  ourReclaimIncarnation = null;
  // Never remove an intent lock that is not ours: if ours was broken while we held it, removing
  // what replaced it would hand a third reclaimer the sequence its holder is still inside.
  const holder = readPidFile(LOCK_RECLAIM_PID_FILE);
  if (holder !== null && holder !== process.pid) return;
  const current = incarnationOf(LOCK_RECLAIM_DIR);
  if (ours !== null && current !== null && current !== ours) return;
  try {
    fs.rmSync(LOCK_RECLAIM_DIR, { recursive: true, force: true });
  } catch {
    /* the next sweep removes anything we fail to remove */
  }
}

/**
 * Break a lock whose holder is gone. Runs under the reclaim intent lock and re-forms its verdict
 * THERE: a verdict reached before the intent lock was taken is worthless, because that interval is
 * exactly when another reclaimer can have broken the lock and a third acquirer taken it. While we
 * hold the intent lock no one else may rename the lock aside, and the dead holder cannot release
 * it, so the directory at LOCK_DIR cannot change identity between the verdict and the rename.
 */
function reclaimStaleLock(): LockAttempt {
  if (!tryTakeReclaimLock()) return { status: 'retry', reason: 'contended' };
  try {
    // The incarnation the verdict below belongs to.
    const judged = incarnationOf(LOCK_DIR);
    if (judged === null) return { status: 'retry', reason: 'broke' }; // gone already — go race the plain mkdir

    const holder = readLockPid();
    if (holder !== null && isAlive(holder)) {
      return { status: 'held', pid: holder, owner: readLockOwner() };
    }
    if (holder === null && lockAgeMs() < LOCK_PID_GRACE_MS) {
      return { status: 'held', pid: null, owner: null };
    }

    // Stale: the holder is gone (crashed / SIGKILLed before its teardown). Break it by RENAMING the
    // directory aside rather than removing it in place, so the lock disappears in ONE step and no
    // acquirer ever sees a half-emptied lock directory.
    log(`Reclaiming stale E2E lock at ${LOCK_DIR} (holder ${holder ?? 'unknown'} is not alive).`);
    const aside = `${LOCK_DIR}.stale-${process.pid}-${Date.now()}`;
    try {
      fs.renameSync(LOCK_DIR, aside);
    } catch {
      return { status: 'retry', reason: 'broke' }; // it vanished under us; the plain mkdir will settle it
    }
    // rename(2) is atomic but unconditional, so prove what we carried off IS the incarnation judged
    // above. Unreachable while the intent lock holds; kept because the cost of being wrong is two
    // concurrent runs, and because it also covers a lock removed out of protocol (a human, a stray
    // rm) and re-created in the same instant.
    const moved = incarnationOf(aside);
    if (moved !== null && moved !== judged) {
      log(
        `WARNING: E2E lock at ${LOCK_DIR} changed identity mid-reclaim (${judged} -> ${moved}); ` +
          `putting it back and treating it as live.`
      );
      try {
        fs.renameSync(aside, LOCK_DIR);
      } catch (err) {
        log(`WARNING: could not restore the E2E lock: ${(err as Error).message}; it is at ${aside}.`);
      }
      return { status: 'held', pid: readLockPid(), owner: readLockOwner() };
    }
    try {
      fs.rmSync(aside, { recursive: true, force: true });
    } catch {
      // Debris only: the lock is gone as far as the protocol is concerned, and the pre-run sweep
      // (sweepLockDebris) removes what is left behind.
    }
    return { status: 'retry', reason: 'broke' };
  } finally {
    releaseReclaimLock();
  }
}

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
    // Looks stale — but this verdict is only a fast path that decides whether to go for the reclaim
    // lock at all. The verdict that is ACTED on is re-formed under it.
    return reclaimStaleLock();
  }

  weOwnLock = true;
  try {
    fs.writeFileSync(LOCK_PID_FILE, String(process.pid), 'utf8'); // first: a pid-less lock is ambiguous
    fs.writeFileSync(LOCK_OWNER_FILE, `${REPO_ROOT} since ${new Date().toISOString()}`, 'utf8');
  } catch (err) {
    // A lock that names no pid is protected only by LOCK_PID_GRACE_MS; past that, any acquirer may
    // reclaim it while this run is still going. Give the lock back and fail the acquire rather than
    // run a real Joplin under a lock that expires underneath it.
    releaseLock();
    throw new Error(
      `Took the machine-wide E2E lock at ${LOCK_DIR} but could not record ownership in it: ` +
        `${(err as Error).message}\nThe lock has been released. Check that ` +
        `${path.dirname(LOCK_DIR)} is writable and has free space, then retry.`
    );
  }
  // AFTER the writes, never before. On a filesystem that reports no btime, createdMs() falls back
  // to mtime — and writing `pid` and `owner` INTO the directory changes its mtime, so a token taken
  // before them is one this process could never match again, and releaseLock() would refuse to
  // remove its OWN lock on every single run. On a btime filesystem this ordering is a no-op.
  ourLockIncarnation = incarnationOf(LOCK_DIR);
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
      // A retry means someone just broke a stale lock, or another acquirer is mid-reclaim; either
      // way the loop makes progress. The cap only guarantees termination if the lock directory is
      // somehow pathological.
      if (++breaks > LOCK_RETRY_CAP) {
        // Two very different outcomes share this cap. A reclaim lock held by a LIVE process is now
        // waited out by design rather than broken, so hitting the cap that way is not corruption —
        // it is one wedged reclaimer, and saying "keeps reappearing stale" would send the reader
        // hunting for the wrong thing.
        throw new Error(
          attempt.reason === 'contended'
            ? `Could not settle the E2E lock at ${LOCK_DIR}: another acquirer has held the reclaim ` +
              `lock at ${LOCK_RECLAIM_DIR} for ${formatDuration(Date.now() - startedAt)} without ` +
              `finishing, and its process is still alive, so it is being waited out rather than ` +
              `broken. If that process is genuinely wedged, end it (or remove that directory) and ` +
              `retry.`
            : `Could not settle the E2E lock at ${LOCK_DIR}: it keeps reappearing stale.`
        );
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
  const ours = ourLockIncarnation;
  ourLockIncarnation = null;
  // Never remove a directory that is no longer ours: if a stale-lock reclaim elsewhere ever took it
  // from us, deleting it would hand a third run the lock a live run is holding. Two independent
  // checks — the pid the directory names, and the incarnation we created (which also catches a
  // successor that has not written its pid yet).
  const holder = readLockPid();
  if (holder !== null && holder !== process.pid) {
    log(`E2E lock at ${LOCK_DIR} is now held by pid ${holder}; leaving it alone.`);
    return;
  }
  const current = incarnationOf(LOCK_DIR);
  if (ours !== null && current !== null && current !== ours) {
    log(`E2E lock at ${LOCK_DIR} is a newer incarnation than the one we took; leaving it alone.`);
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
  sweepLockDebris();
  reportProcDenied();
}

/**
 * Remove lock debris beside the lock: `<lock>.stale-<pid>-<ts>` directories a reclaim moved aside
 * but failed to delete, and a reclaim intent lock stranded by a process that died mid-break. Both
 * are inert, but nothing else ever removes them, so they accumulate in ~/.cache.
 */
function sweepLockDebris(): void {
  const parent = path.dirname(LOCK_DIR);
  const base = path.basename(LOCK_DIR);
  // Both kinds of rename-aside debris: from breaking the lock, and from breaking the intent lock.
  const stalePrefixes = [`${base}.stale-`, `${base}.reclaim.stale-`];
  let entries: string[];
  try {
    entries = fs.readdirSync(parent);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!stalePrefixes.some((prefix) => name.startsWith(prefix))) continue;
    const debris = path.join(parent, name);
    try {
      fs.rmSync(debris, { recursive: true, force: true });
      log(`Removed stale-lock debris ${debris}.`);
    } catch (err) {
      log(`WARNING: could not remove stale-lock debris ${debris}: ${(err as Error).message}`);
    }
  }
  // We hold the lock, so no legitimate reclaim can be in flight: a reclaim lock here is debris.
  if (reclaimLockIsStranded()) {
    try {
      fs.rmSync(LOCK_RECLAIM_DIR, { recursive: true, force: true });
      log(`Removed stranded E2E reclaim lock ${LOCK_RECLAIM_DIR}.`);
    } catch {
      /* its TTL still bounds it */
    }
  }
}

function sweepOrphanJoplins(): void {
  for (const pid of listProcPids()) {
    if (pid === process.pid) continue;
    const argv = readCmdline(pid);
    if (!argv || argv.length === 0) continue;
    // Only orphans reparented to init. This is NOT redundant with the path anchor below: the path
    // alone also matches a CONCURRENT run of this same checkout, so if the machine-wide lock were
    // ever lost — or a sibling worktree on an older protocol raced it — a second run would SIGKILL
    // the first run's live Joplin tree mid-test. A live run's Joplin has a live Playwright worker
    // for a parent; only a run that died leaves its Joplin behind on init. Same condition the Xvfb
    // sweep below has always used.
    if (readStat(pid)?.ppid !== 1) continue;
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

  // SIGHUP alongside SIGINT/SIGTERM: a run started from a terminal that is then closed (or an SSH
  // session that drops) is hung up, not interrupted, and would otherwise leak its Joplin tree.
  const SIGNAL_EXIT_CODES: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
  const onSignal = (sig: NodeJS.Signals) => {
    // If another listener is present (Playwright drives its own graceful shutdown), defer to it and
    // let 'exit' — or, failing that, the next run's sweep — do the cleanup.
    if (process.listenerCount(sig) > 1) return;
    cleanup();
    process.removeAllListeners(sig);
    try {
      process.kill(process.pid, sig); // re-raise so the exit code reflects the signal
    } catch {
      process.exit(SIGNAL_EXIT_CODES[sig] ?? 1);
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) {
    process.on(sig, onSignal);
  }

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
