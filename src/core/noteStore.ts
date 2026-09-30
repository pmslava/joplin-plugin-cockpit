/** README ******************************************************************************************************************************************
 * THE NOTE STORE (2.7) - a local mirror of every note's metadata, built once from the GET /notes listing and kept exact by Joplin's change feed,   *
 * joplin.data.get(['events'], { cursor }). This file is the driver: when to build, when to poll, what to call and what to do when a call fails.    *
 * What the mirror holds, and how a feed row or a fetched note changes it, is the pure model in noteStoreModel.js. Since phase 3 the unfiltered     *
 * views read it (getTodos and getNotes in joplin.ts, once isReady() says so); until then they take the 2.6.3 paths, which is also what they do     *
 * for the whole session when the store is off.                                                                                                     *
 *                                                                                                                                                  *
 * THE BUILD runs AFTER the first paint, from a timeout index.ts arms once refreshInterfaces has painted, and is never awaited: on a 20,000-note    *
 * collection the walk is 201 pages (the route answers has_more whenever a page is full, so an exact multiple of 100 costs one more, empty page),   *
 * and the panel must not wait for any of them. It takes the feed's cursor FIRST (a no-cursor call), then walks the listing by id, 100 at a time,   *
 * then drains the feed from that cursor, so whatever changed while the walk ran is replayed on top of it.                                          *
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
 * THE READERS' SURFACE is isAvailable, isReady, getModel, pollNow, applyLocalWrite and subscribe (pollOnTick is the tick's own); phase 3 added     *
 * applyLocalCreate and applyLocalRemoval for the panel's own creates and trashes, and catchUp for the renders that must show outside writes (see   *
 * catchUpNoteStore in timer.ts). The first six functions are also put on the plugin's global, in a frozen object called CockpitNoteStore, the way  *
 * the pure modules publish themselves, so the harness (and a DevTools console in the plugin's window) can inspect the mirror without a command or  *
 * a menu entry.                                                                                                                                    *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";
import { invalidateResultCaches, listingFields } from "./joplin";
import { countData, markStoreBuildEnd, markStoreBuildStart } from "./instrument";
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
var rerunRequested = false
var rerunMayBuild = false
var followUpTimer = null
var noteChangeTimer = null
var listeners = []
// A build is in flight from its first call until it has decided whether it is ready. A trash Cockpit applies in that window marks the build as one
// that may have missed a note (see applyLocalRemoval), and the build then ends not ready.
var building = false
var buildLostNote = false
// What the burst of runs in progress did, which its listeners are told (see timer.ts), so a render can tell the news apart:
//  - built:   it ran the build that makes the store ready (runOnce's) - every note at once, most rings never read;
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
        return requestRun(true)
    }, buildDelayMs)
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
    model.applyLocalWrite(id, fields)
    armFollowUp()
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
        await runOnce(mayBuild)
        while (rerunRequested && available){
            var queuedMayBuild = rerunMayBuild
            rerunRequested = false
            rerunMayBuild = false
            await runOnce(queuedMayBuild)
        }
    } catch (error) {
        // Every call is guarded where it is made; this only catches a bug, and a bug must not leave the mirror trusted.
        setReady(false)
        console.warn("Cockpit: the note store stopped on an unexpected error", error)
    } finally {
        running = null
        rerunRequested = false
        rerunMayBuild = false
    }
    if (model.revision !== revisionBefore) notifyListeners({ built: burstBuilt, rebuilt: burstRebuilt, fetched: burstFetched, removed: burstRemoved })
}

async function runOnce(mayBuild){
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
 * The full build: the cursor, the walk, the replay. The first call of the session is the availability guard.                                       *
 ***************************************************************************************************************************************************/
async function build(){
    building = true
    buildLostNote = false
    markStoreBuildStart()                         // the renderer's heap before the store is built (instrument.ts)
    try {
        await walk()
    } finally {
        building = false
    }
}

async function walk(){
    var head
    try {
        countData('events')
        head = await joplin.data.get(['events'], {})
    } catch (error) {
        if (!probed){
            markUnavailable("Cockpit: Joplin's change feed is not available in this app, so the note store is off for this session", error)
            return
        }
        buildFailed(error)
        return
    }
    probed = true
    try {
        // Taken BEFORE the walk: anything that changes while the pages are read is in the feed after this cursor, and is replayed below.
        var walkCursor = feedCursor(head)
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
        cursor = walkCursor
        var complete = await drainFeed(false)
        markStoreBuildEnd(model.size())               // and after its replay, with the mirror's size
        failedBuilds = 0
        // A trash Cockpit applied while this build ran may have hidden a note the walk stepped over (see applyLocalRemoval).
        setReady(complete && !buildLostNote)
    } catch (error) {
        model.abandonBuild()
        buildFailed(error)
    }
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
 * launch rebuilds anyway.                                                                                                                          *
 ***************************************************************************************************************************************************/
async function drainFeed(mayRebuild){
    var rows = []
    var nextCursor = cursor
    var response
    var plan
    do {
        var sent = nextCursor
        countData('events')
        response = await joplin.data.get(['events'], { cursor: sent })
        rows.push(...(response.items || []))
        nextCursor = feedCursor(response)
        // The route always moves the cursor to the last row it returned; a page that claims more but stays put would loop for ever.
        if (response.has_more && nextCursor === sent) throw new Error("the change feed did not advance")
        // Once the fetches pass the threshold the drain is decided: the rebuild retakes the cursor, so the pages left would be read for nothing.
        plan = model.planDrain(rows, rebuildThreshold)
    } while (response.has_more && !plan.rebuild)
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
        // Cockpit wrote the note while the fetch was out: the answer may be older than the write, so it is dropped and the note refetched.
        if (writeSerials.get(id) !== writesBefore){
            refetchIds.add(id)
            continue
        }
        if (model.applyFetched(note, id) === 'removed') removedKnown = true
    }
    for (var removeId of plan.remove){
        if (model.remove(removeId)){
            removedKnown = true
            burstRemoved.add(removeId)
        }
    }
    cursor = nextCursor
    return !removedKnown
}

/** The inspection handle **************************************************************************************************************************/
;(globalThis as any).CockpitNoteStore = Object.freeze({ isAvailable, isReady, getModel, pollNow, applyLocalWrite, subscribe })
