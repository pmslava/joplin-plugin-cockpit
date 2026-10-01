/** README ******************************************************************************************************************************************
 * THE NOTE STORE (2.7) - a local mirror of every note's metadata, built once from the GET /notes listing and kept exact by Joplin's change feed,   *
 * joplin.data.get(['events'], { cursor }). This file is the driver: when to build, when to poll, what to call and what to do when a call fails.    *
 * What the mirror holds, and how a feed row or a fetched note changes it, is the pure model in noteStoreModel.js. Since phase 3 the unfiltered     *
 * views read it (getTodos and getNotes in joplin.ts, once isReady() says so); until then they take the 2.6.3 paths, which is also what they do     *
 * for the whole session when the store is off.                                                                                                     *
 *                                                                                                                                                  *
 * THE BUILD runs AFTER the first paint, from a timeout index.ts arms once refreshInterfaces has painted, and is never awaited: on a 20,000-note    *
 * collection the walk is about 200 pages, and the panel must not wait for any of them. It takes the feed's cursor FIRST (a no-cursor call), then   *
 * walks every notebook's notes by id, 100 at a time (walkNotebooks, 2.7.1: one notebook's rows are sorted per page rather than the whole table),   *
 * then drains the feed from that cursor, so whatever changed while the walk ran is replayed on top of it, and then counts the bare listing to      *
 * prove nothing was in no notebook (listingHolds). One render builds it sooner (2.7.1): a first paint whose to-do search proves large would walk   *
 * the whole listing for its own sake and leave the startup build to walk it again, so it awaits the build instead and reads the store              *
 * (ensureBuilt), and the startup timeout then finds the store ready and does nothing.                                                              *
 *                                                                                                                                                  *
 * THE AVAILABILITY GUARD is that first no-cursor call. The route is proven on desktop and unproven on mobile (the harness cannot reach a phone),   *
 * so a throw there means "not in this app": one warning, the store is off for the session, and the route is never called again. Every read path    *
 * keeps working exactly as before, since none of them depends on the store.                                                                        *
 *                                                                                                                                                  *
 * A POLL drains the feed from the cursor (the cursor is the STRING the route returned, passed back verbatim) and applies the rows through the      *
 * model's plan: each created or updated note is fetched by id, each deleted one removed. A fetch answering Not Found is a removal too. A drain     *
 * whose fetches would exceed rebuildThreshold rebuilds instead, and stops reading pages the moment they do: past that point one walk costs less    *
 * than the per-id reads, and the walk retakes the cursor anyway. The threshold counts FETCHES, not every id the drain names - a removal is local   *
 * and free, and a sync that deletes a thousand notes should not cost a walk for it.                                                                *
 *                                                                                                                                                  *
 * THE TRIGGERS are the existing ones, and they only add to what those triggers already do: onSyncComplete polls once, onNoteChange polls through a *
 * short debounce (a burst is one poll), and the periodic tick polls once. The last two are skipped while a sync runs, like the external-change     *
 * path, because the sync's own completion polls once for all of it. Every triggered poll but the tick's arms ONE follow-up poll half a second      *
 * later, which arms nothing further: the feed's row is written after the save returns, un-awaited, and phase 1 measured an immediate poll after    *
 * the plugin's own put missing it 8 times in 20, while all 40 rows were there 500 ms later. The tick is tied to no save (every save fires          *
 * onNoteChange, which arms its own), so it arms none, and an idle tick costs exactly one data call. Cockpit's own writes (the helpers in           *
 * joplin.ts) do not wait for the feed at all: they update the record in the same code path and arm the same follow-up, which then brings the row   *
 * as an ordinary, usually unchanged, upsert.                                                                                                       *
 *                                                                                                                                                  *
 * ONE RUN AT A TIME. A build and a poll are both a "run", and runs are single-flight: a request that arrives while one is in progress is coalesced *
 * into ONE more run after it (a poll requested during a build therefore waits for the build and then polls), never a second one alongside it.      *
 *                                                                                                                                                  *
 * WHEN THINGS FAIL. A poll that fails (the events call, or a fetch, throws) leaves the store STALE: isReady() turns false and the next trigger     *
 * rebuilds it, retaking the cursor. A build that fails is retried on the next trigger - at most one build per trigger; the follow-up poll never    *
 * builds - and after three failed builds in a row the store is off for the session, with one warning. A build whose walk may have missed a note is *
 * not trusted either (see drainFeed): it ends not ready, which is not a failure, and the next trigger walks again.                                 *
 * Cockpit's own trash counts as such a note (see applyLocalRemoval): it hides the evidence the replay would otherwise have found.                  *
 *                                                                                                                                                  *
 * PERSISTENCE (2.7.1, desktop only). The mirror is saved to a file in the plugin's data directory (noteStoreFile.ts: <dataDir>/noteStore.v1.json,  *
 * one per Joplin profile), and the next launch restores it before the first paint instead of walking: on a large collection, one file read, one    *
 * events call, a short replay and one listing page, against a walk of hundreds of pages. A wrong mirror is worse than none, so the restore trusts  *
 * the file only as far as the feed vouches for it, and every doubt ends in the ordinary build, in the same run (restoreRun):                       *
 * - the file must be format 1, from this plugin version, this app version and this client (Joplin's clientId, kept in the profile's database:      *
 *   another one is another database), with a cursor and an array of notes, or it is ignored (an unparsable one is removed);                        *
 * - the guard's no-cursor call gives the feed's head; a head below the saved cursor means another database, or this one restored from a backup:    *
 *   its ids run lower, and a cursor from elsewhere is silently empty, never refused (or a collection unchanged for 90 days, every row pruned: it   *
 *   rebuilds once, saving cursor "0", which the next launch restores);                                                                             *
 * - a file whose cursor the feed confirmed more than 60 days ago (savedAt) is discarded: Joplin prunes a row once it is 90 days old AND its        *
 *   resource, search and revision services have processed it, so the rows after an old cursor may be gone without a trace. Every row after the     *
 *   cursor is younger than savedAt, and 60 days leaves a month of margin under the 90;                                                             *
 * - the records go in through the build's staging (its dedupe, its trashed and conflict drops), and the feed is drained from the saved cursor by   *
 *   the ordinary replay. A drain past the rebuild threshold discards the file and walks, which is right: a long absence with many changes is a     *
 *   rebuild. A drain that fails discards the file too;                                                                                             *
 * - the completeness count (listingHolds), one bare page: a count that differs means the file and Joplin disagree, and the file goes.              *
 *                                                                                                                                                  *
 * The lost-note rule does not apply, since nothing is walked; Cockpit's own writes during the replay are handled as during a build's.              *
 *                                                                                                                                                  *
 * WHEN THE FILE IS WRITTEN. At once after a build or a rebuild that ends ready, and after a restore; after a drain or an own write that moved the  *
 * revision, through a 5 s debounce (scheduleSave), so a burst is one write. Never while a build is in flight, and never while a fetch an own write *
 * crossed is owed (refetchIds: the cursor is already past that note's row). The copy of the records and the JSON are synchronous - 21,000 records  *
 * take 8 to 15 ms in the harness, a 4.1 MB file, so they are not spread across timeouts - and the write is asynchronous and awaited by no run and  *
 * no render; a failure is logged once. On mobile nothing is read or written, and nothing is armed.                                                 *
 *                                                                                                                                                  *
 * THE READERS' SURFACE is isAvailable, isReady, getModel, pollNow, applyLocalWrite and subscribe (pollOnTick is the tick's own); phase 3 added     *
 * applyLocalCreate and applyLocalRemoval for the panel's own creates and trashes, and catchUp for the renders that must show outside writes (see   *
 * catchUpNoteStore in timer.ts), and 2.7.1 ensureBuilt for that early build and restoreNoteStore for the startup. The first six functions are also *
 * put on the plugin's global, in a frozen object called CockpitNoteStore, the way the pure modules publish themselves, so the harness (and a       *
 * DevTools console in the plugin's window) can inspect the mirror without a command or a menu entry; 2.7.1 adds whenSaved there, the promise of    *
 * the save in progress, which the harness awaits before it reads the file.                                                                         *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";
import { getNotebookMap, invalidateNotebookMap, invalidateResultCaches, listingFields } from "./joplin";
import { countData, markStoreBuildEnd, markStoreBuildStart, markStoreRestore, markStoreSave } from "./instrument";
import { pluginVersion, readStoreFile, storeFileAccess, storeFileFormat, writeStoreFile } from "./noteStoreFile";
const { createNoteStoreModel } = require("./noteStoreModel");

/** Timing and limits ******************************************************************************************************************************/
// How long after the first paint the build starts. The paint has finished by then (the timeout is armed after it); the delay only keeps the walk out
// of the burst of work Joplin itself does as the window comes up.
const buildDelayMs = 2000
// The follow-up poll after every triggered poll and every own write (phase 1: every row was there 500 ms after its save).
const followUpDelayMs = 500
// The note-change debounce: long enough to fold a burst of change events into one poll, short enough that an edit still lands at once.
const noteChangeDelayMs = 250
// Past this many notes to fetch in one drain, a listing walk is the cheaper way to catch up (see the README).
const rebuildThreshold = 200
// How many builds may fail in a row before the store is switched off for the session.
const maxFailedBuilds = 3
// A pause between two pages of the build's walk, in ms. Every page is a full scan and sort of the notes table in Joplin's MAIN window (10 to 32 ms a
// page at 21,000 notes, 211 pages), and the walk runs while the user is working. The pages are separate calls, so the window can react between two of
// them - but whether back-to-back pages still show as lag is for the perf run to say (docs/BRIEF-2.7-local-mirror.md, section 7). If they do, this is
// the one place to spread the walk out; 0 (the default) adds no pause and no timer at all, so the build is exactly what phase 2 shipped.
const walkPagePauseMs = 0
// The save's debounce (2.7.1): a burst of drains and own writes is one write, at most this long after the first of them.
const saveDelayMs = 5000
// How long ago the feed may have confirmed a saved cursor for the file to be restored (2.7.1): Joplin prunes a change row once it is 90 days old
// and processed, and 60 leaves a month of margin (see PERSISTENCE in the README).
const savedMaxAgeMs = 60 * 24 * 3600 * 1000

/** State ******************************************************************************************************************************************/
var model = createNoteStoreModel()
// False once the feed proved missing (the guard) or the builds kept failing: nothing is called again this session.
var available = true
// Whether the guard's no-cursor call has answered once; a later throw from the same call is a failed build, not a missing route.
var probed = false
// Set when the startup build's timeout fires. Until then every trigger is a no-op: the build that is about to run reads everything anyway.
var started = false
// The mirror is exact as of the cursor: the first build and its replay completed, and no poll has failed since.
var ready = false
// The feed position the mirror is exact to, exactly as the route returned it.
var cursor = null
var failedBuilds = 0
// The run in progress (its promise), and the one more run requested while it lasts.
var running = null
// The one run in progress inside that burst - the build, or the poll, the pump is awaiting right now - which ensureBuilt waits for rather than the
// whole burst (2.7.1).
var currentRun = null
var rerunRequested = false
var rerunMayBuild = false
var followUpTimer = null
var noteChangeTimer = null
var listeners = []
// A build is in flight from its first call until it has decided whether it is ready. A trash Cockpit applies in that window marks the build as one
// that may have missed a note (see applyLocalRemoval), and the build then ends not ready.
var building = false
var buildLostNote = false
// The per-notebook walk (2.7.1, walkNotebooks): on until the route fails or the collection proves to hold notes in no notebook. While a build that
// walked per notebook is in flight, every read with its notebook and page, and each notebook's last page, for the lost-note rule (pageShifted).
var perNotebookWalk = true
// Whether a build has run this session: the mirror's size is then what perNotebookPays weighs the notebooks against.
var builtOnce = false
var walkReads = null
var walkLastPage = null
// Joplin's conflict folder, which is not a real notebook (Folder.conflictFolderId in 3.6.14). GET /folders does not list it; skipped all the same.
const conflictFolderId = 'c04f1c7c04f1c7c04f1c7c04f1c7c04f'
// What the burst of runs in progress did, which its listeners are told (see timer.ts), so a render can tell the news apart:
//  - built:   it ran the build that makes the store ready (runOnce's), or the startup's restore (2.7.1) - every note at once, most rings never read;
//  - rebuilt: a ready store's drain was too large to fetch note by note and walked the listing instead - any note may have changed;
//  - fetched: the ids its drains fetched by id - the notes that changed, new ones included;
//  - removed: the ids its drains took out on a delete row (phase 5): with `fetched`, every note the burst has Joplin's own word on, which is
//             what lets timer.ts retire the optimistic layer's hold on them.
var burstBuilt = false
var burstRebuilt = false
var burstFetched = new Set()
var burstRemoved = new Set()
// Cockpit's own writes, counted per note (phase 5). A drain's fetch by id can be answered before one of them and arrive after it - the note read
// just before the panel trashed it, say - and applying that answer would put the old record back over the write for the half second until the
// follow-up. So drainFeed notes a note's count before its fetch and drops the answer when the count moved meanwhile; the note then goes on the
// refetch list, which the next drain (the follow-up the write armed) fetches whatever its rows say: the write's own feed row may already be behind
// the cursor, in the very page the skipped fetch came from. No clock is involved, only the order of the two events.
var writeSerials = new Map()
var refetchIds = new Set()
// PERSISTENCE (2.7.1; see the README). The store's file (noteStoreFile.ts): null until the startup's restore has asked, and for the whole session
// where the app has no file system for the plugin (mobile) - then nothing is read, written or armed.
var persistence = null
// The model's revision the last save serialised, so a burst that moved nothing writes nothing; the save's debounce timer; the latest write, which
// whenSaved hands the harness; whether a failed save has been logged this session.
var savedRevision = null
var saveTimer = null
var lastWrite: Promise<any> = Promise.resolve()
var saveFailureLogged = false
// The saved store the startup read, which the next run that would otherwise build restores instead (runOnce, restoreRun).
var pendingRestore = null
// When the feed last confirmed the cursor - the moment the drain that set it asked for its last page - and the newest feed position the store has
// seen. A save writes them as savedAt and head: every row after the cursor is younger than savedAt, which is what the restore's 60 days are about.
var cursorAt = 0
var headSeen = 0

function countWrite(id){
    var key = String(id)
    writeSerials.set(key, (writeSerials.get(key) || 0) + 1)
}

// The listing's own fields plus is_conflict, which a fetch by id needs (GET /notes/:id returns conflict copies; the listing does not). Read at
// call time rather than at load: joplin.ts imports this module for its write helpers and its store reads, so its exports are not filled in yet
// when this one loads.
function storeFields(){
    return listingFields.concat(['is_conflict'])
}

/** scheduleNoteStoreBuild **************************************************************************************************************************
 * Arms the build. Called once, from onStart, after the first paint; never awaited there.                                                           *
 ***************************************************************************************************************************************************/
export function scheduleNoteStoreBuild(){
    // The callback returns the run's promise so the harness can await the build it fires; setTimeout ignores it.
    setTimeout(() => {
        started = true
        // A render that would have walked the listing may have built the store already (ensureBuilt, 2.7.1), the startup may have restored it from
        // its file (restoreNoteStore, 2.7.1), or either may still be running: then this build has nothing to do, or joins that run. After an early
        // build or a restore that ended not ready it is the retry, as any trigger's would be.
        if (ready) return Promise.resolve()
        if (running) return running
        return requestRun(true)
    }, buildDelayMs)
}

/** ensureBuilt (2.7.1) *****************************************************************************************************************************
 * The build, now, for a render that is about to walk the whole listing anyway. Before the store is ready an unfiltered view reads the 2.6.3 paths, *
 * and when its to-do search proves large (getTodos in joplin.ts: a page slower than todoSearchPageSlowMs, or the pages so far slower than          *
 * todoSearchTotalSlowMs) that path walks the listing for the render - which the startup build then walks again two seconds later: two walks of 300 *
 * pages at 30,000 items before the panel is store-served. Building the store in that render instead costs one walk, notebook by notebook, and the  *
 * render reads the store at the end of it.                                                                                                         *
 *                                                                                                                                                  *
 * It is the ordinary build, through the single-flight gate: the cursor first, the walk, the replay, the lost-note rule, the availability guard (a  *
 * missing route answers false here and switches the store off, as at startup). It marks the store started, so Cockpit's own writes and the         *
 * triggers reach the mirror from here on, and the startup timeout then finds it ready and does nothing. Answers whether the store is ready; a      *
 * caller that gets false takes the walk it would have taken. Never rejects.                                                                        *
 *                                                                                                                                                  *
 * ONE RUN, NEVER TWO. The render waits for the run it starts, or for the run already in progress, which it joins - not for the burst around it. A  *
 * trigger landing while that run lasts (a sync completing, a note change) queues one more run on the same pump, and when the build ends untrusted  *
 * or fails, that rerun is another walk; it goes on in the background, and the render takes its answer from the run it waited for.                  *
 ***************************************************************************************************************************************************/
export async function ensureBuilt(){
    if (!available) return false
    if (ready) return true
    started = true
    if (!running) requestRun(true)
    try {
        await currentRun
    } catch (error) {
        // The pump that owns the run handles its failure; the answer below says what it left.
    }
    return isReady()
}

/** restoreNoteStore (2.7.1) ************************************************************************************************************************
 * The startup's restore, before the first paint (index.ts, through restoreNoteStoreBeforePaint in timer.ts): the mirror saved at the last launch,  *
 * made exact again by the feed, so the first paint is drawn from the store without a walk. Answers whether the store is ready from the file. Never *
 * rejects.                                                                                                                                         *
 *                                                                                                                                                  *
 * Without a file - or on mobile, where there is none to be had (noteStoreFile.ts) - nothing else happens: no store call, the store not started,    *
 * the startup exactly as it was, with the build after the first paint. So it is with a file that is not read: another plugin version or another    *
 * app version (the one every update of Cockpit or of Joplin leaves behind), another client (another database under this profile's directory),      *
 * another format, a malformed file. With a file that is read the store is started (Cockpit's own writes and the triggers reach it from here on)    *
 * and ONE run goes on the single-flight pump: the restore (restoreRun), or, where the restore finds a reason not to trust the file, the ordinary   *
 * build in the same run. The caller waits for that run, the fall-through build included. A discard is the uncommon ending - more than 200 notes    *
 * changed while Cockpit was closed (the replay past the threshold, the one that is not exotic), another database or a backup, an absence of two    *
 * months, a count that differs - and on a large collection the first paint would have waited for that build anyway, when its to-do search proves   *
 * large (ensureBuilt). ensureBuilt and the startup timeout find the run in flight and join it, as they join a build.                               *
 ***************************************************************************************************************************************************/
export async function restoreNoteStore(){
    var startedAt = Date.now()
    persistence = await storeFileAccess()
    if (!persistence){
        markStoreRestore({ attempted: false, restored: false, reason: "no file system" })
        return false
    }
    var read = await readStoreFile(persistence)
    if (!read.content){
        markStoreRestore({ attempted: read.reason !== "no saved store", restored: false, reason: read.reason, ms: Date.now() - startedAt })
        return false
    }
    if (!available) return false
    started = true
    pendingRestore = { saved: read.content, startedAt: startedAt, restored: false }
    var pending = pendingRestore
    await requestRun(true)
    return pending.restored && isReady()
}

/** pollNow *****************************************************************************************************************************************
 * A triggered poll: drains the feed now (or builds, if the store is not ready) and arms the follow-up. onSyncComplete and the note-change debounce *
 * call it. Never rejects - every failure is handled inside - so a caller never needs its own guard.                                                *
 ***************************************************************************************************************************************************/
export function pollNow(){
    if (!started || !available) return Promise.resolve()
    armFollowUp()
    return requestRun(true)
}

/** pollOnTick **************************************************************************************************************************************
 * The periodic tick's poll: the same run as pollNow, but with NO follow-up. The follow-up exists for saves, whose feed row lands after the save    *
 * returns; a tick is tied to none (every save fires onNoteChange, which arms its own, and a sync is covered by onSyncComplete), and an idle tick   *
 * must cost exactly one data call. The caller skips it while a sync runs.                                                                          *
 ***************************************************************************************************************************************************/
export function pollOnTick(){
    if (!started || !available) return Promise.resolve()
    return requestRun(true)
}

/** scheduleNoteStorePoll ***************************************************************************************************************************
 * onNoteChange's trigger: one poll per burst, through the same debounce shape as the settings note's read (the first event arms it, the rest of    *
 * the burst finds it armed).                                                                                                                       *
 ***************************************************************************************************************************************************/
export function scheduleNoteStorePoll(){
    if (!started || !available || noteChangeTimer) return
    noteChangeTimer = setTimeout(() => {
        noteChangeTimer = null
        return pollNow()   // returned so the harness can await it; setTimeout ignores it
    }, noteChangeDelayMs)
}

/** applyLocalWrite *********************************************************************************************************************************
 * Cockpit wrote these fields to this note (a PUT from a joplin.ts helper). The record changes now rather than when the feed's row arrives, and the *
 * follow-up poll fetches the rest of what the write moved (its user_updated_time).                                                                 *
 ***************************************************************************************************************************************************/
export function applyLocalWrite(id, fields){
    if (!started || !available) return
    countWrite(id)
    // A move out of a notebook the per-notebook walk is reading shifts its later pages, as a trash shifts the listing's (applyLocalRemoval below).
    if (building && walkReads && fields && fields.parent_id !== undefined) buildLostNote = true
    model.applyLocalWrite(id, fields)
    armFollowUp()
    scheduleSave()
}

/** applyLocalCreate ********************************************************************************************************************************
 * Cockpit created this note (a POST from the panel). The answer is the saved note, so it goes into the mirror now - as the fetch by id the feed's  *
 * row would lead to - and the follow-up poll brings that row as an ordinary, usually unchanged, upsert. An answer without an id changes nothing.   *
 ***************************************************************************************************************************************************/
export function applyLocalCreate(note){
    if (!started || !available) return
    if (note && note.id){
        countWrite(note.id)
        model.applyFetched(note, note.id)
    }
    armFollowUp()
    scheduleSave()
}

/** applyLocalRemoval *******************************************************************************************************************************
 * Cockpit moved this note to the trash (a DELETE from the panel). The trash IS a write of deleted_time, and the model already treats a write that  *
 * trashes a note as its removal, from a build's staging map too.                                                                                   *
 *                                                                                                                                                  *
 * A removal while a build is in flight also makes that build untrusted, for the reason drainFeed gives: the listing is paged by offset, so a note  *
 * leaving it after its page was read shifts every later page left by one, and the walk may step over the note at the next page boundary. The       *
 * replay would normally see it - it would remove a note the walk had read - but the removal applied here has taken that note out already, so the   *
 * replay finds nothing to remove and would trust the walk. So the build is marked here instead. Any removal in the window counts, including one    *
 * that lands during the replay: the DELETE may have reached the database while the walk ran even though its answer came back after it, and a       *
 * needless walk on the next trigger is the cheap side to be wrong on.                                                                              *
 ***************************************************************************************************************************************************/
export function applyLocalRemoval(id){
    if (!started || !available) return
    countWrite(id)
    if (building) buildLostNote = true
    model.applyLocalWrite(id, { deleted_time: Date.now() })
    armFollowUp()
    scheduleSave()
}

/** catchUp *****************************************************************************************************************************************
 * The drain run before a render that must show what outside writers did: each of the reconcile lane's renders, and panel.ts's truth renders (the   *
 * profile switch's truth refresh, a notebook-filter change), through catchUpNoteStore in timer.ts. A store-served view has no index to wait for,   *
 * but it does have to learn about a change nothing else announces - an app command such as moveToFolder, whose dialog lands its write seconds      *
 * after the command returned, or a write from outside (REST, another plugin) that Joplin's onNoteChange stays silent about (it fires for the       *
 * SELECTED note only).                                                                                                                             *
 *                                                                                                                                                  *
 * ONE drain and no follow-up. It never STARTS a build: a store that is not ready stays with the 2.6.3 paths until a real trigger walks. A ready    *
 * store whose drain passes the rebuild threshold does rebuild inside it, though, like any poll, and the render that awaits it then waits for that  *
 * walk.                                                                                                                                            *
 *                                                                                                                                                  *
 * Only a drain that starts now is awaited, so the render after it reads what it brought. A run already in progress - a build of 200 pages, say -   *
 * is not waited for: the drain is queued behind it, and the store's notification at the end of that burst renders whatever it brings. Never        *
 * rejects.                                                                                                                                         *
 ***************************************************************************************************************************************************/
export function catchUp(){
    if (!started || !available) return Promise.resolve()
    var inProgress = !!running
    var run = requestRun(false)
    return inProgress ? Promise.resolve() : run
}

/** The readers' surface ***************************************************************************************************************************/
// Not known to be missing: true until the guard or the failed builds say otherwise.
export function isAvailable(){
    return available
}

// The mirror can be read: built, replayed, and not stale.
export function isReady(){
    return available && ready
}

export function getModel(){
    return model
}

// Called once a burst of runs (one run and the reruns asked for while it lasted) has changed the mirror's revision; timer.ts schedules a render from
// it. A burst that changed nothing calls nobody. The listener is handed { built, rebuilt, fetched, removed } (see burstBuilt above). Returns the
// unsubscribe function.
export function subscribe(listener){
    listeners.push(listener)
    return () => { listeners = listeners.filter(entry => entry !== listener) }
}

/** armFollowUp *************************************************************************************************************************************
 * One follow-up poll, half a second from the LATEST arm: a second arm inside the window moves it rather than adding another, so a burst of writes  *
 * is still one follow-up and it still comes after the last of them. The follow-up itself arms nothing, and never builds (it only drains).          *
 ***************************************************************************************************************************************************/
function armFollowUp(){
    clearTimeout(followUpTimer)
    followUpTimer = setTimeout(() => {
        followUpTimer = null
        return requestRun(false)
    }, followUpDelayMs)
}

/** requestRun / pump *******************************************************************************************************************************
 * The single-flight gate. mayBuild says whether this request may build a store that is not ready (a trigger may; the follow-up may not). A request *
 * made while a run is in progress sets the rerun flag and shares that run's promise, which settles only after the rerun, so whoever asked can      *
 * await the work it asked for.                                                                                                                     *
 ***************************************************************************************************************************************************/
function requestRun(mayBuild){
    if (!available) return Promise.resolve()
    if (running){
        rerunRequested = true
        if (mayBuild) rerunMayBuild = true
        return running
    }
    running = pump(mayBuild)
    return running
}

async function pump(mayBuild){
    // The listeners hear about the burst, not about each run in it: a poll asked for while one runs is folded into this pump, and so is its news,
    // so a burst of drains is one notification and, in timer.ts, one render.
    var revisionBefore = model.revision
    burstBuilt = false
    burstRebuilt = false
    burstFetched = new Set()
    burstRemoved = new Set()
    try {
        currentRun = runOnce(mayBuild)
        await currentRun
        while (rerunRequested && available){
            var queuedMayBuild = rerunMayBuild
            rerunRequested = false
            rerunMayBuild = false
            currentRun = runOnce(queuedMayBuild)
            await currentRun
        }
    } catch (error) {
        // Every call is guarded where it is made; this only catches a bug, and a bug must not leave the mirror trusted.
        setReady(false)
        console.warn("Cockpit: the note store stopped on an unexpected error", error)
    } finally {
        running = null
        currentRun = null
        rerunRequested = false
        rerunMayBuild = false
    }
    if (model.revision !== revisionBefore) notifyListeners({ built: burstBuilt, rebuilt: burstRebuilt, fetched: burstFetched, removed: burstRemoved })
    // A burst that moved the revision past the last save arms the save's debounce (2.7.1); so does one whose save was put off (see saveNow).
    scheduleSave()
}

async function runOnce(mayBuild){
    // The startup's restore (2.7.1) is the first run that would otherwise build: it restores, or falls through to the build itself (restoreRun).
    if (pendingRestore){
        var pending = pendingRestore
        pendingRestore = null
        if (!ready) return await restoreRun(pending)
        markStoreRestore({ attempted: true, restored: false, reason: "built before the restore ran", notes: pending.saved.notes.length, ms: Date.now() - pending.startedAt })
    }
    if (ready) await poll()
    else if (mayBuild){
        burstBuilt = true
        await build()
    }
}

function notifyListeners(news){
    for (var listener of listeners.slice()){
        try {
            listener(news)
        } catch (error) {
            console.warn("Cockpit: a note store listener failed", error)
        }
    }
}

// The cursor an events answer carries, exactly as it came. An answer without one is refused, so the next call can never be { cursor: undefined }.
function feedCursor(answer){
    if (!answer || answer.cursor === undefined || answer.cursor === null) throw new Error("the change feed answered without a cursor")
    return answer.cursor
}

/** build *******************************************************************************************************************************************
 * The full build: the cursor, the walk, the replay. The first call of the session is the availability guard. A restore that falls through to the   *
 * build hands it the head its own guard call took, when nothing was read since (knownHead, 2.7.1): any head taken before the walk is a cursor the  *
 * replay can start from. A build that ends ready saves the mirror at once (2.7.1: the first save, and the save after every rebuild).               *
 ***************************************************************************************************************************************************/
async function build(knownHead?){
    building = true
    buildLostNote = false
    markStoreBuildStart()                         // the renderer's heap before the store is built (instrument.ts)
    try {
        await walk(knownHead)
    } finally {
        building = false
    }
    if (ready) saveNow()
}

/** takeHead ****************************************************************************************************************************************
 * The feed call without a cursor, which answers the feed's head - and, as the session's first call, is the availability guard: a throw there means *
 * the route is not in this app, and the store is off for the session. A later throw counts as a failed build. Answers the answer, or null after    *
 * handling the failure. The build's first call, and the restore's (2.7.1).                                                                         *
 ***************************************************************************************************************************************************/
async function takeHead(){
    var head
    try {
        countData('events')
        head = await joplin.data.get(['events'], {})
    } catch (error) {
        if (!probed){
            markUnavailable("Cockpit: Joplin's change feed is not available in this app, so the note store is off for this session", error)
            return null
        }
        buildFailed(error)
        return null
    }
    probed = true
    if (head && Number(head.cursor) > headSeen) headSeen = Number(head.cursor)
    return head
}

async function walk(knownHead?){
    var head = knownHead || await takeHead()
    if (!head) return
    try {
        // Taken BEFORE the walk: anything that changes while the pages are read is in the feed after this cursor, and is replayed below.
        var walkCursor = feedCursor(head)
        var notebooks = null
        if (perNotebookWalk){
            // Read afresh, AFTER the cursor was taken (see walkNotebooks).
            invalidateNotebookMap()
            var map = await getNotebookMap()
            if (await perNotebookPays(map.size)) notebooks = await walkNotebooks(map)
        }
        if (!notebooks) await walkListing()
        builtOnce = true
        cursor = walkCursor
        var complete = await drainFeed(false)
        walkReads = null
        walkLastPage = null
        // The per-notebook walk reaches every note in a notebook; the listing also holds any note whose notebook does not exist. The two counts
        // tell (listingHolds); when they differ the whole collection is walked after all, and replayed from the same cursor.
        if (notebooks && complete && !(await listingHolds(model.size()))){
            await walkListing()
            cursor = walkCursor
            complete = await drainFeed(false)
            if (holdsNotesOutside(notebooks)){
                perNotebookWalk = false
                console.info("Cockpit: some notes are in no notebook Joplin lists, so the note store walks the whole collection for this session")
            }
        }
        markStoreBuildEnd(model.size())               // and after its replay, with the mirror's size
        failedBuilds = 0
        // A trash Cockpit applied while this build ran may have hidden a note the walk stepped over (see applyLocalRemoval).
        setReady(complete && !buildLostNote)
    } catch (error) {
        walkReads = null
        walkLastPage = null
        model.abandonBuild()
        buildFailed(error)
    }
}

/** walkListing *************************************************************************************************************************************
 * The whole-collection walk: the bare GET /notes listing by id, 100 a page, into a fresh staging map. Each page is a full scan and sort of the     *
 * notes table (see walkNotebooks), so since 2.7.1 it is the fallback: for a build whose count found notes in no notebook, and for the rest of a    *
 * session that found them.                                                                                                                         *
 ***************************************************************************************************************************************************/
async function walkListing(){
    model.beginBuild()
    var pageNum = 1
    var response
    do {
        if (pageNum > 1 && walkPagePauseMs > 0) await new Promise(resolve => setTimeout(resolve, walkPagePauseMs))
        countData('listing')
        response = await joplin.data.get(['notes'], { fields: storeFields(), order_by: 'id', limit: 100, page: pageNum++ })
        model.addListingPage(response.items)
    } while (response.has_more)
    model.endBuild()
}

/** perNotebookPays (2.7.1) *************************************************************************************************************************
 * Whether this build walks notebook by notebook or the bare listing. Each page of the bare listing sorts the whole notes table, a notebook's page  *
 * only that notebook's rows, so per notebook is the cheaper walk - but it costs at least one call for every notebook, an empty one included, where *
 * the bare walk costs one for every 100 notes. A collection of many small notebooks would pay more for it: 500 notebooks holding 5,000 notes are   *
 * 500 calls and more, against the bare walk's 50. So the walk goes per notebook only while the notebooks number at most the notes over 100.        *
 *                                                                                                                                                  *
 * The note count it compares with is the mirror's, once a build has run this session (a rebuild's best guess at the collection); before the first  *
 * build there is none, and one page of the bare listing answers the question instead: page n, for n notebooks, is full exactly when the notes      *
 * reach 100 for each notebook. With one notebook, or none, the two walks cost the same calls, and nothing is read.                                 *
 ***************************************************************************************************************************************************/
async function perNotebookPays(notebookCount){
    if (notebookCount <= 1) return true
    if (builtOnce) return notebookCount <= model.size() / 100
    return await bareListingRows(notebookCount) === 100
}

/** walkNotebooks (2.7.1) ***************************************************************************************************************************
 * The walk, one notebook at a time. Joplin pages every listing with ORDER BY id COLLATE NOCASE (requestPaginationOrder in 3.6.14 marks every order *
 * case-insensitive), which its index cannot serve, so a page of the bare listing is a full scan and sort of the whole notes table: 25 ms at 20,000 *
 * notes, 211 times over. GET /folders/:id/notes pages through the same helper - the same fields, order_by, limit and page - but applies parent_id  *
 * = ? first, so each page sorts one notebook's rows. It leaves out trashed notes like the bare listing and, unlike it, lists conflict copies,      *
 * which keep their notebook; the mirror drops those as it always has. Pages are counted as `listing`, as the bare walk's are, so a perf run's      *
 * numbers compare.                                                                                                                                 *
 *                                                                                                                                                  *
 * WHICH NOTEBOOKS. The folder map (getNotebookMap in joplin.ts, the one the panel polls), read afresh by walk() AFTER the cursor was taken, so     *
 * every notebook that existed then is walked. A notebook created after that read can only hold a note that was created in it or moved into it      *
 * since, and each of those writes a feed row the replay fetches by id. A notebook deleted before its turn answers Not Found and is passed over:    *
 * its notes were trashed or deleted with it, which writes their rows too. The conflict folder and the trash are not real notebooks (no note has    *
 * their id as its parent), and GET /folders lists neither. A note whose notebook does not exist is in no notebook's list at all: the build counts  *
 * the listing afterwards (listingHolds) and walks the whole collection when the two disagree.                                                      *
 *                                                                                                                                                  *
 * THE LOST-NOTE RULE, PER NOTEBOOK. A notebook's pages are paged by offset, so a note that LEAVES a notebook after its page was read - moved out,  *
 * trashed, deleted - shifts that notebook's later pages left by one, and the walk may step over the note at the next page boundary. Each read is   *
 * kept with its notebook and page (walkReads, walkLastPage), and the replay treats the build as untrusted when a note read on any page but its     *
 * notebook's last has left that notebook (pageShifted). A note that arrives in a notebook mid-walk shifts later pages the other way, and the       *
 * double read is deduplicated by id; a note moved between two notebooks mid-walk is kept once, and the replay's fetch puts it where it ended up.   *
 * Cockpit's own moves mark the build like its own trash does (applyLocalWrite).                                                                    *
 *                                                                                                                                                  *
 * Answers the folder map it walked. A page that fails with anything but Not Found fails the build, as a page of the whole walk does: the next      *
 * trigger builds again, and three failed builds in a row switch the store off.                                                                     *
 ***************************************************************************************************************************************************/
async function walkNotebooks(notebooks){
    walkReads = new Map()
    walkLastPage = new Map()
    model.beginBuild()
    for (var folderId of notebooks.keys()){
        if (folderId === conflictFolderId) continue
        var pageNum = 1
        var response
        do {
            if (pageNum > 1 && walkPagePauseMs > 0) await new Promise(resolve => setTimeout(resolve, walkPagePauseMs))
            countData('listing')
            try {
                response = await joplin.data.get(['folders', folderId, 'notes'], { fields: storeFields(), order_by: 'id', limit: 100, page: pageNum })
            } catch (error) {
                if (String((error && error.message) || error).indexOf("Not Found") < 0) throw error
                response = { items: [], has_more: false }
            }
            for (var item of response.items || []){
                if (!item || item.id === undefined) continue
                var reads = walkReads.get(String(item.id)) || []
                reads.push({ folder: folderId, page: pageNum })
                walkReads.set(String(item.id), reads)
            }
            model.addListingPage(response.items)
            walkLastPage.set(folderId, pageNum)
            pageNum++
        } while (response.has_more)
    }
    model.endBuild()
    return notebooks
}

/** pageShifted (2.7.1) *****************************************************************************************************************************
 * Whether a note the per-notebook walk read has left a notebook whose later pages it could have shifted: it is no longer in that notebook (fetched *
 * elsewhere, trashed, or gone - null), and it was read on a page before that notebook's last.                                                      *
 ***************************************************************************************************************************************************/
function pageShifted(id, note){
    var reads = walkReads ? walkReads.get(String(id)) : null
    if (!reads) return false
    for (var read of reads){
        var stillThere = !!note && !(Number(note.deleted_time) > 0) && note.parent_id === read.folder
        if (!stillThere && read.page < (walkLastPage.get(read.folder) || 0)) return true
    }
    return false
}

/** listingHolds (2.7.1) ****************************************************************************************************************************
 * Whether the bare listing holds exactly `expected` notes - the mirror's count after the per-notebook walk and its replay - read from at most two  *
 * of its pages rather than walked: page floor(expected / 100) + 1 must hold the remainder, and, when the remainder is 0, the page before it must   *
 * be full. A non-empty page means every page before it is full, so the two pages pin the count. The listing leaves out trashed notes and conflict  *
 * copies, as the mirror does, so the counts differ only by notes in no notebook - or by a note that changed in the moment between the replay and   *
 * these pages, which costs one whole walk and nothing else. ONE KNOWN MISS, like the one the lost-note rule names in drainFeed: a note in no       *
 * notebook, and a trash that lands in the window from the replay's last events page, through its fetches by id, to this count, cancel out - the    *
 * mirror lacks the one and still holds the other, whose row the replay never read - so the counts agree and the build ends ready without the note  *
 * in no notebook. Both inside the same few hundred milliseconds, on a collection holding such a note at all; the next rebuild, the next launch at  *
 * the latest, brings it - since 2.7.1 through the restore, whose replay removes the trashed note and whose own count then differs. The restore     *
 * (replaySaved) asks the same question of a mirror that came from the file, after its replay.                                                      *
 ***************************************************************************************************************************************************/
async function listingHolds(expected){
    var lastPage = Math.floor(expected / 100) + 1
    var onLastPage = expected - (lastPage - 1) * 100
    if (await bareListingRows(lastPage) !== onLastPage) return false
    if (onLastPage > 0 || lastPage === 1) return true
    return await bareListingRows(lastPage - 1) === 100
}

// How many rows one page of the bare listing holds: the count's question (listingHolds) and the choice of walk's (perNotebookPays).
async function bareListingRows(page){
    countData('listing')
    var answer = await joplin.data.get(['notes'], { fields: storeFields(), order_by: 'id', limit: 100, page: page })
    return (answer.items || []).length
}

// Whether the mirror holds a note whose notebook the walk did not know: the case the per-notebook walk cannot reach, and the one that keeps the
// whole-collection walk for the rest of the session.
function holdsNotesOutside(notebooks){
    return model.snapshot().some(record => !notebooks.has(record.parent_id))
}

/** setReady ****************************************************************************************************************************************
 * Every change of readiness goes through here. When it DROPS - a failed poll, a failed or untrusted build, the store switched off - the views go   *
 * back to their 2.6.3 paths, whose result-cache entries are as old as the moment the store took over. An optimistic or fill render would serve     *
 * them again as if nothing had happened since, so every cached result is dropped with the readiness (invalidateResultCaches in joplin.ts).         *
 ***************************************************************************************************************************************************/
function setReady(value){
    if (ready && !value) invalidateResultCaches()
    ready = value
}

function buildFailed(error){
    setReady(false)
    failedBuilds++
    if (failedBuilds >= maxFailedBuilds) markUnavailable("Cockpit: the note store could not be built three times in a row, so it is off for this session", error)
}

function markUnavailable(message, error){
    setReady(false)
    available = false
    console.warn(message, error)
}

/** poll ********************************************************************************************************************************************
 * One drain of the feed. A failure leaves the store stale, and the next trigger rebuilds it.                                                       *
 ***************************************************************************************************************************************************/
async function poll(){
    try {
        await drainFeed(true)
    } catch (error) {
        setReady(false)
    }
}

/** drainFeed ***************************************************************************************************************************************
 * Reads every feed page after the cursor and applies it. The cursor moves only once every row has been applied, so a drain that fails part way is  *
 * read again in full by whatever recovers it. The paging stops early once the fetches pass the rebuild threshold.                                  *
 *                                                                                                                                                  *
 * mayRebuild is true for an ordinary poll, which rebuilds when the drain is too large. It is false for a build's own replay, which never walks     *
 * again inside the same run: it answers false instead ("not complete") and the next trigger walks. The replay also answers false when it removed a *
 * note the walk had read. The listing is paged by OFFSET, and a note leaving it (trashed, deleted) after its page was read shifts every later page *
 * left by one, so the walk may have stepped over the note that sat at the next page boundary - a note with no row of its own to bring it back.     *
 * Rare, invisible, and permanent if trusted, so a build that saw it is not trusted. One case gets past this: an already-read note trashed and      *
 * restored inside one walk. The two changes merge into one type-2 row, the fetch finds the note live, and nothing says a page shifted. The next    *
 * launch rebuilds anyway - since 2.7.1 it restores the saved mirror instead, and it is the restore's completeness count that finds the mirror one  *
 * note short of the listing and walks.                                                                                                             *
 *                                                                                                                                                  *
 * tally (2.7.1), when given, is told how many rows the drain read (tally.rows) and whether they passed the rebuild threshold (tally.rebuild). The  *
 * restore's replay asks with mayRebuild false and a tally: it reports the rows, and on the threshold empties the file's records and builds itself  *
 * (restoreRun).                                                                                                                                    *
 ***************************************************************************************************************************************************/
async function drainFeed(mayRebuild, tally?){
    var rows = []
    var nextCursor = cursor
    var response
    var plan
    do {
        var sent = nextCursor
        var askedAt = Date.now()
        countData('events')
        response = await joplin.data.get(['events'], { cursor: sent })
        rows.push(...(response.items || []))
        nextCursor = feedCursor(response)
        // The route always moves the cursor to the last row it returned; a page that claims more but stays put would loop for ever.
        if (response.has_more && nextCursor === sent) throw new Error("the change feed did not advance")
        // Once the fetches pass the threshold the drain is decided: the rebuild retakes the cursor, so the pages left would be read for nothing.
        plan = model.planDrain(rows, rebuildThreshold)
    } while (response.has_more && !plan.rebuild)
    if (tally){
        tally.rows = rows.length
        tally.rebuild = !!plan.rebuild
    }
    if (plan.rebuild){
        if (!mayRebuild) return false
        // build() retakes the cursor itself, and handles its own failure.
        burstRebuilt = true
        await build()
        return true
    }
    // The notes an earlier drain dropped a fetch of (see writeSerials) are fetched now, whatever the rows say.
    for (var refetchId of refetchIds) if (plan.fetch.indexOf(refetchId) < 0) plan.fetch.push(refetchId)
    refetchIds.clear()
    for (var fetchId of plan.fetch) burstFetched.add(fetchId)
    var removedKnown = false
    for (var id of plan.fetch){
        var note = null
        var writesBefore = writeSerials.get(id)
        try {
            countData('get')
            note = await joplin.data.get(['notes', id], { fields: storeFields() })
        } catch (error) {
            if (String((error && error.message) || error).indexOf("Not Found") < 0) throw error
        }
        // A build's replay after the per-notebook walk (2.7.1): a read note that has left a notebook may have shifted that notebook's later pages.
        if (pageShifted(id, note)) removedKnown = true
        // Cockpit wrote the note while the fetch was out: the answer may be older than the write, so it is dropped and the note refetched.
        if (writeSerials.get(id) !== writesBefore){
            refetchIds.add(id)
            continue
        }
        if (model.applyFetched(note, id) === 'removed') removedKnown = true
    }
    // A deletion of a note the per-notebook walk read shifts its notebook's pages whether or not the mirror held it: a conflict copy is read and
    // dropped, and planDrain lists only the deletions of ids the mirror holds, so the rows are asked directly.
    if (walkReads) for (var row of rows) if (Number(row.type) === 3 && pageShifted(row.item_id, null)) removedKnown = true
    for (var removeId of plan.remove){
        if (model.remove(removeId)){
            removedKnown = true
            burstRemoved.add(removeId)
        }
    }
    cursor = nextCursor
    // Every page up to the feed's end was read, so every row after this cursor was written after the last page was asked for: the moment a save
    // records as savedAt (2.7.1).
    cursorAt = askedAt
    if (Number(cursor) > headSeen) headSeen = Number(cursor)
    return !removedKnown
}

/** restoreRun (2.7.1) ******************************************************************************************************************************
 * The restore itself, one run on the pump (see PERSISTENCE in the README). The guard's call first, which also gives the feed's head; then the two  *
 * guards the file and the head decide alone; then the records, the replay from the saved cursor and the completeness count. Ready only after all   *
 * of them, and saved at once. Any doubt discards the file - its records emptied out of the model first, so a walk that then fails leaves none of   *
 * them behind - and builds, in this same run: with the head the guard took when nothing has been read since it, else from a fresh head - the       *
 * ordinary build, start to finish. A replay past the rebuild threshold is such a doubt too: the drain answers it rather than rebuilding inside     *
 * itself. One ending builds nothing more: a guard call that failed, which is the ordinary build's first call failed as it would have failed there  *
 * - the store is off, or this counts as a failed build, and the startup timeout retries.                                                           *
 ***************************************************************************************************************************************************/
async function restoreRun(pending){
    var saved = pending.saved
    var outcome = { attempted: true, restored: false, reason: null, notes: saved.notes.length, replayRows: null, ms: null }
    // Its news is a build's, whichever way it ends: every note at once, and most rings never read (see the burst's news above).
    burstBuilt = true
    var head = await takeHead()
    if (!head){
        outcome.reason = available ? "change feed failed" : "no change feed"
        return endRestore(pending, outcome)
    }
    var walkFrom = head
    var reason = refuseSaved(saved, head)
    if (!reason){
        walkFrom = null
        reason = await replaySaved(saved, outcome)
    }
    if (!reason){
        setReady(true)
        // The mirror's size is the collection's best estimate now, as after a build: what a later rebuild weighs the notebooks against.
        builtOnce = true
        outcome.restored = true
        pending.restored = true
        endRestore(pending, outcome)
        saveNow()
        return
    }
    outcome.reason = reason
    endRestore(pending, outcome)
    // The file's records go, so nothing of them can outlive a walk that fails before its own swap - the threshold's rebuild included.
    model.beginBuild()
    model.endBuild()
    await build(walkFrom)
}

// The two guards decided before anything is read: a head below the saved cursor (another database, or this one restored from a backup), and a
// cursor the feed confirmed more than 60 days ago, or in the future (a clock that moved). Answers the reason, or null.
function refuseSaved(saved, head){
    if (!(Number(head.cursor) >= Number(saved.cursor))) return "feed behind the cursor"
    var age = Date.now() - Number(saved.savedAt)
    if (!(age >= 0)) return "saved in the future"
    if (!(age <= savedMaxAgeMs)) return "older than 60 days"
    return null
}

// The records through the build's staging (its dedupe, its trashed and conflict drops), the ordinary replay from the saved cursor, and the count.
// Answers the reason the file is not to be trusted, or null.
async function replaySaved(saved, outcome){
    model.beginBuild()
    model.addListingPage(saved.notes)
    model.endBuild()
    cursor = saved.cursor
    var tally = { rows: null, rebuild: false }
    try {
        // A replay past the threshold does not rebuild inside the drain (mayRebuild false): it answers with tally.rebuild, and restoreRun empties the
        // file's records and builds, as for every other discard. Its other answer is the lost-note rule's, which is about a walk; there is none here,
        // and a note deleted while Cockpit was closed is news, not doubt.
        await drainFeed(false, tally)
    } catch (error) {
        outcome.replayRows = tally.rows
        return "replay failed"
    }
    outcome.replayRows = tally.rows
    if (tally.rebuild) return "replay past the threshold"
    try {
        if (!(await listingHolds(model.size()))) return "count differs"
    } catch (error) {
        return "count failed"
    }
    return null
}

function endRestore(pending, outcome){
    outcome.ms = Date.now() - pending.startedAt
    markStoreRestore(outcome)
}

/** saveNow / scheduleSave (2.7.1) ******************************************************************************************************************
 * saveNow writes the mirror now, when it may: the store ready, no build in flight, and no fetch owed that an own write crossed (refetchIds - the   *
 * cursor is already past that note's row, so a file saved now would never see it again). A save that may not is simply not made, and the end of    *
 * the run in progress (the pump's scheduleSave) arms the next one. The copy of the records and the JSON are taken here, synchronously, so the file *
 * is the mirror and the cursor of one moment; the write is queued and asynchronous (noteStoreFile.ts), awaited by no run and no render, and a      *
 * failure is logged once a session, never thrown. Answers whether a save was made. The file's head is diagnostic only: refuseSaved compares the    *
 * LIVE head, from the restore's own guard call, with the saved cursor. The app version and the clientId are the ones noteStoreFile.ts read for     *
 * this session, which its next read compares.                                                                                                      *
 *                                                                                                                                                  *
 * scheduleSave arms the debounce: once per burst - the first drain or own write that moves the revision past the last save arms it, the rest of    *
 * the burst finds it armed - so a burst is one write, at most saveDelayMs after it began. The callback returns the write's promise, so the harness *
 * can await it.                                                                                                                                    *
 ***************************************************************************************************************************************************/
function saveNow(){
    if (!persistence || !ready || building || refetchIds.size) return false
    var startedAt = Date.now()
    savedRevision = model.revision
    var text = JSON.stringify({
        format: storeFileFormat,
        pluginVersion: pluginVersion,
        appVersion: persistence.appVersion,
        clientId: persistence.clientId,
        savedAt: cursorAt,
        head: String(Math.max(headSeen, Number(cursor) || 0)),
        cursor: String(cursor),
        notes: model.snapshot(),
    })
    var serialisedMs = Date.now() - startedAt
    lastWrite = writeStoreFile(persistence, text).then(bytes => markStoreSave(serialisedMs, bytes), error => {
        if (saveFailureLogged) return
        saveFailureLogged = true
        console.warn("Cockpit: could not save the note store, so the next launch builds it from the listing", error)
    })
    return true
}

function scheduleSave(){
    if (!persistence || !ready || saveTimer || model.revision === savedRevision) return
    saveTimer = setTimeout(() => {
        saveTimer = null
        return saveNow() ? lastWrite : Promise.resolve()
    }, saveDelayMs)
}

// The latest write's promise, settled when it is on disk or has failed (never rejects): the harness awaits it before it reads the file.
function whenSaved(){
    return lastWrite
}

/** The inspection handle **************************************************************************************************************************/
;(globalThis as any).CockpitNoteStore = Object.freeze({ isAvailable, isReady, getModel, pollNow, applyLocalWrite, subscribe, whenSaved })
