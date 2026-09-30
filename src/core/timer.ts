/** README ******************************************************************************************************************************************
 *                                                                                                                                                  *
 *  This file refreshes the panel interface and the overview notes when the content changes, split into independent lanes so one user action no        *
 *  longer fans out into a pile of full rebuilds:                                                                                                     *
 *                                                                                                                                                    *
 *   - refreshInterfaces  : the immediate, full repaint (fast panel paint -> overview regen -> background ring fill). Used at startup, on the periodic  *
 *                          backstop tick, and by the structural UI actions that change the whole view (profile edit/delete, notebook create/move).    *
 *   - scheduleReconcile  : the note-mutation lane. ONE bounded background job per mutation burst polls the search at rising offsets and STOPS EARLY    *
 *                          the moment the index confirms the change (the optimistic layer retiring is the signal). A new mutation resets the job       *
 *                          rather than stacking a second one, which is also what keeps a slow refresh from queuing another full pass behind it.        *
 *   - scheduleOverview   : the overview-note lane. Debounced well past the index delay and decoupled from panel paints, so the overview notes are      *
 *                          rewritten at most once per burst instead of on every follow-up.                                                            *
 *   - the sync events    : flip the Synchronize button via the cheapest possible paint (a fast render, never a dataset rebuild), and arm ONE           *
 *                          reconcile job after a sync completes.                                                                                       *
 *   - the note store     : (2.7) the tick, a completed sync and a note change each also poll the change feed once (see noteStore.ts), and each of the  *
 *                          reconcile lane's polls drains it before its render. Since phase 3 the unfiltered views are drawn from the store once it is  *
 *                          ready, so a burst of polls that changed it schedules ONE fast render of its own (the note store lane below). It costs       *
 *                          nothing at all until the store's startup build has been kicked off.                                                         *
 *   - all store-served   : (2.7 phase 4) when the store serves EVERY view - the panel's and each overview note's (allConsumersStoreServed below) -     *
 *                          the machinery that exists to chase the search index stands down: a note change (outside a sync) and a completed sync drain  *
 *                          the feed and render once (no per-note read, no reconcile ladder), and the tick redraws only when something the panel or the *
 *                          notes are drawn from has moved (the redraw stamps below). One view that still needs the search puts every trigger back.     *
 *   - own writes         : (2.7 phase 5) while every view is store-served and no sync runs (storeServesAction below), the panel's own actions stop     *
 *                          feeding the optimistic layer and arming the reconcile ladder: the store has each write at once, and a drain retires the     *
 *                          layer's hold on the notes it brought (settleDrained).                                                                       *
 *                                                                                                                                                    *
 *  A profile switch is deliberately none of these: it changes no note data, so it paints (from cache / one search) and stops - see panel.ts.          *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";
import { getPanelSearchFilter, reconcileExternalNoteChange, refreshPanelData, trackEditorNoteSelection } from "../ui/panel/panel";
import { getOverviewNoteIDs, refreshNoteData } from "./markdown";
import { getCurrentProfileID, updateFrequencySettingKey } from "./settings";
import { getAllProfiles, getProfile } from "./database";
import { getSyncStatus, markSyncComplete, markSyncStart } from "./syncStatus";
import { clearAllOptimistic, clearOptimisticItem, clearTodoCompletionOverride, hasPendingItemOverlay, hasPendingOptimistic } from "./optimistic";
import { isMobile } from "./platform";
import { drainDeferredSettingsNoteWrite, isSettingsNote, pollSettingsNote, scheduleSettingsNoteRead, syncSettingsNote } from "./settingsSync";
import { catchUp, getModel as getStoreModel, pollNow, pollOnTick, scheduleNoteStorePoll, subscribe as subscribeToNoteStore } from "./noteStore";
import { getAllTags, getNotebookMap, notebookMapGeneration, storeServes, tagListGeneration, viewCriteria } from "./joplin";
import { toISODate } from "./calendar";
import { logTick, snapshot } from "./instrument";

/** Variable Initialization ************************************************************************************************************************/
const defaultUpdateFrequency = 60
// On mobile every periodic refresh is a full search/notes/body cycle across the React Native bridge and,
// unlike desktop, it is not suppressed while the panel is hidden (panels.visible() is unreliable on
// mobile, so refreshPanelData deliberately always renders there). The periodic timer only exists to roll
// to-dos across day boundaries (Today -> Overdue), which tolerates a slower beat - interactive freshness
// is covered by onNoteChange + the reconcile lane - so the mobile default is doubled to halve that waste.
const defaultMobileUpdateFrequency = 120
var timer = null
var refreshing = false
var refreshQueued = false

/** refreshInterfaces ********************************************************************************************************************************
 * The immediate full repaint: a fast first paint (no note bodies), the overview-note regen, then the background ring fill. Only one runs at a time; a  *
 * request arriving while one is in progress runs exactly once more afterwards, so the last change is never lost (and never stacks more than one extra   *
 * pass). This is the startup / periodic-backstop / structural-change path; note mutations use the lighter reconcile + overview lanes below instead.     *
 ***************************************************************************************************************************************************/
export async function refreshInterfaces(){
    if (refreshing) {
        refreshQueued = true
        return
    }
    refreshing = true
    try {
        do {
            refreshQueued = false
            // Fast first paint: render the whole list from whatever counts are cached, fetching NO note
            // bodies, so a cold start or any full refresh shows at once instead of stalling the paint on up
            // to ~600 body GETs.
            await refreshPanelData({ fast: true })
            // The overview notes never render checkbox rings, so this refresh fetches zero note bodies
            // (fetchTodos forces the fast path for markdown) and only writes a note whose content changed.
            await regenerateOverviewNotes()
            // Background count-fill: fetch the note bodies (nearest the viewport first) and repaint once with
            // the real rings. A no-op via the equality guard whenever the cache is already warm.
            await refreshPanelData({ fillCounts: true })
        } while (refreshQueued)
    } catch (error) {
        console.error("Cockpit: could not refresh the to-do list", error)
    } finally {
        refreshing = false
    }
}

/** Reconciliation lane *****************************************************************************************************************************
 * A note mutation (a tick, a create, a due-date move, an external change, a completed sync) reaches Joplin's search index only after its own indexing  *
 * timer catches up - seconds later, by a varying amount. This lane covers that gap with ONE bounded background job: it re-runs the panel search at a    *
 * handful of rising offsets, repainting only when the result actually changed. The offsets are more closely spaced early (where the index usually       *
 * settles) and reach out to 30s as a backstop.                                                                                                          *
 *                                                                                                                                                       *
 * Early stop: when the mutation left something in the host-held optimistic layer (worker A's overrides / item overlay), the job knows exactly what it   *
 * is waiting for - those entries retire the instant a search agrees with them. So as soon as none are left pending, the remaining offsets are cancelled *
 * (there is nothing more to confirm). A change that left nothing optimistic - a due-date move, a tag edit - has no such signal, so it simply runs the   *
 * bounded schedule to its end. Either way it is a SINGLE job: a fresh mutation clears the pending offsets and restarts, so bursts never stack parallel  *
 * jobs (which is also what retires claim C8's queued-second-full-pass).                                                                                 *
 *                                                                                                                                                       *
 * Since 2.7 phase 5 the panel's own actions arm it only when storeServesAction does not hold (a view needs the search, a sync runs, the store is not    *
 * ready), or when the store went stale while the action ran. Two callers arm it whatever the gate says: onNoteAlarmTrigger, and Joplin's own            *
 * moveToFolder command run from the panel, whose write an older desktop app lands after the command has returned (see runMoveCommand in panel.ts).      *
 ***************************************************************************************************************************************************/
const reconcileOffsetsMs = [1000, 3000, 7000, 15000, 30000]
var reconcileTimers = []
// Whether the lane may STOP EARLY once the optimistic layer has cleared. It may only when EVERY mutation that
// armed the current burst was optimistic - each left a host-held entry that retires the instant a search
// agrees, so "the layer is empty" means "the index has caught up with all of them". If ANY arming mutation
// was non-optimistic (a due-date move, an alarm, a tag edit: they leave no entry to retire), the burst loses
// that signal and must run its bounded offsets to the end - otherwise an unrelated optimistic override
// retiring would cut the non-optimistic change's confirmation short. So this is the STRONGEST expectation of
// the burst, weakened (never re-strengthened) by a non-optimistic arm, and reset when the burst ends.
var reconcileExpectRetire = false
// True while a burst's offsets are still live, so a re-arm can tell it is EXTENDING the same burst (and must
// keep the burst's expectation) from starting a fresh one (which resets the expectation).
var reconcileActive = false
// A generation stamp bumped on every (re)arm. A poll captures the generation it belongs to and, when it
// resumes from its await, refuses to touch the lane if a newer burst has since taken it over - otherwise a
// slow in-flight poll from an old burst could cancel the fresh burst's timers.
var reconcileGeneration = 0

export function scheduleReconcile(wasOptimistic?){
    for (var pending of reconcileTimers) clearTimeout(pending)
    var generation = ++reconcileGeneration
    // An arm is "optimistic" only when the caller performed an optimistic mutation AND that layer is actually
    // pending now. A fresh burst takes this arm's expectation; a further arm in the same live burst can only
    // WEAKEN it - a single non-optimistic arm disables the early stop for the whole burst.
    var optimisticArm = !!wasOptimistic && hasPendingOptimistic()
    if (!reconcileActive){
        reconcileExpectRetire = optimisticArm
    } else if (!optimisticArm){
        reconcileExpectRetire = false
    }
    reconcileActive = true
    // The callback returns the poll's promise so the work is awaitable (harnessable); setTimeout ignores it.
    var lastIndex = reconcileOffsetsMs.length - 1
    reconcileTimers = reconcileOffsetsMs.map((delay, index) => setTimeout(() => reconcilePoll(generation, index === lastIndex), delay))
}

function cancelReconcile(){
    for (var pending of reconcileTimers) clearTimeout(pending)
    reconcileTimers = []
    reconcileActive = false
}

async function reconcilePoll(generation, isLast){
    // A store-served view (2.7) has no index to wait for, but its store may not have heard of the change this burst is about: an app command
    // such as moveToFolder writes when its dialog closes, which an older desktop app does after the command has returned (3.6.14 awaits the
    // dialog and the move), and Joplin's onNoteChange fires for the selected note only.
    // So the store drains once first (catchUpNoteStore: one events call, no follow-up; it starts no build, though a ready store's drain past the
    // rebuild threshold rebuilds inside it and this render then waits for the walk), and the render below reads what it brought.
    await catchUpNoteStore()
    // A real, search-based refresh (not the cache/fast path): it lets the index catch up, retires any
    // optimistic entry the search now agrees with, fetches only the bodies of genuinely-changed notes, and
    // repaints only when the result actually changed (refreshPanelData's equality guard). A poll that finds
    // nothing new therefore costs a single search.
    await refreshPanelData()
    // A newer burst has taken over the lane while this poll was awaiting: it owns the timers now, so leave
    // them be (this poll's own timers were already cleared when that burst re-armed).
    if (generation !== reconcileGeneration) return
    // Nothing left to confirm: cancel the remaining offsets. Only bursts that were armed purely by optimistic
    // mutations get here (reconcileExpectRetire); a burst carrying a non-optimistic change runs to the end.
    if (reconcileExpectRetire && !hasPendingOptimistic()){
        cancelReconcile()
    } else if (isLast){
        // The bounded schedule is exhausted: the burst is over, so the next mutation starts a fresh one.
        reconcileActive = false
        reconcileTimers = []
    }
}

/** Overview lane ***********************************************************************************************************************************
 * The profile overview notes are regenerated on their own debounce, decoupled from the panel. A note mutation only needs the overview rewritten once   *
 * the index has settled, and never as urgently as the panel, so this waits well past the index delay and collapses a burst of changes into a single    *
 * pass. The scope defaults to every overview-bearing profile; a profile edit passes just its own id so only that note is regenerated. A request for     *
 * "all" wins over a scoped one within the same debounce window.                                                                                         *
 ***************************************************************************************************************************************************/
const overviewDebounceMs = 10000
var overviewTimer = null
var overviewScope: "all" | Set<any> | undefined = undefined

export function scheduleOverview(profileIDs?){
    if (profileIDs === undefined || overviewScope === "all"){
        overviewScope = "all"
    } else {
        if (!(overviewScope instanceof Set)) overviewScope = new Set()
        for (var id of profileIDs) overviewScope.add(id)
    }
    clearTimeout(overviewTimer)
    // Returns the promise so the lane is awaitable from the test harness; setTimeout ignores the return.
    overviewTimer = setTimeout(() => runOverviewLane(), overviewDebounceMs)
}

async function runOverviewLane(){
    var scope = overviewScope
    overviewScope = undefined
    try {
        await regenerateOverviewNotes(scope === "all" ? undefined : scope)
    } catch (error) {
        console.error("Cockpit: could not refresh the overview notes", error)
    }
}

/** regenerateOverviewNotes *************************************************************************************************************************
 * refreshNoteData (markdown.ts), with the overview notes' redraw stamp kept beside it (see the redraw stamps below). A pass over EVERY overview    *
 * note records what it was drawn from, taken before it read anything; a scoped pass (one profile's edit) regenerates only its own note, so it      *
 * leaves the stamp as it is unless it fails - a note left unwritten is a note the next tick must write.                                            *
 ***************************************************************************************************************************************************/
async function regenerateOverviewNotes(scope?){
    if (scope !== undefined){
        try {
            await refreshNoteData(scope)
        } catch (error) {
            overviewsRedrawnFrom = null
            throw error
        }
        return
    }
    var stamp = await redrawStamp()
    overviewsRedrawnFrom = null
    await refreshNoteData()
    overviewsRedrawnFrom = settledStamp(stamp)
}

/** Note store lane (2.7) ***************************************************************************************************************************
 * The note store (noteStore.ts) tells its subscribers when a burst of its runs has changed the mirror: a drain that brought an edit, a sync or a   *
 * trash, or the build that has just made it ready. A view drawn from the store is then out of date, and nothing else would repaint it until the    *
 * next trigger, so ONE render is scheduled: the fast one the sync events use (no note bodies, rings from the cache), followed, once the store      *
 * serves every view and the news is a drain's rather than a build's, by a ring fill (renderStoreChange). A notification that arrives while that    *
 * render is still pending folds into it, and the store itself folds a burst of drains into one notification.                                       *
 *                                                                                                                                                  *
 * The listener only schedules. It never polls - that would loop through the store's own notification - and never waits, since the store calls it   *
 * as a burst ends. The equality guard in refreshPanelData still stops a repaint when nothing visible changed, and a drain that changed nothing     *
 * notifies nobody, so an idle tick renders nothing here.                                                                                           *
 ***************************************************************************************************************************************************/
const storeRenderDelayMs = 0
var storeRenderTimer = null
// The ring fill the pending render owes, from the news folded into it (see renderStoreChange): none (only the build's news), the plain fill (a ready
// store's rebuild was among it), or the changed-only fill with the ids its drains fetched.
var storeRenderFill = null

function scheduleStoreRender(news?){
    if (!(news && news.built)){
        if (!storeRenderFill) storeRenderFill = { plain: false, fetched: new Set() }
        if (news && news.rebuilt) storeRenderFill.plain = true
        if (news && news.fetched) for (var id of news.fetched) storeRenderFill.fetched.add(id)
    }
    if (storeRenderTimer) return
    // The callback returns the render's promise so the harness can await it; setTimeout ignores it.
    storeRenderTimer = setTimeout(() => {
        storeRenderTimer = null
        var fill = storeRenderFill
        storeRenderFill = null
        return renderStoreChange(fill).catch(error => console.warn("Cockpit: could not repaint after a note store change", error))
    }, storeRenderDelayMs)
}

/** renderStoreChange *******************************************************************************************************************************
 * The render itself. While any view still needs the search, it is the fast render alone, as in phase 3: the reconcile lane that a note change or a *
 * sync arms comes after it with full renders, and those read the rings of the notes that changed. When the store serves every view (phase 4) no    *
 * such lane follows - this render is the only one a change gets - so a drain's render is followed by a ring fill, the reconcile lane's first rung  *
 * less its search, which keeps a checkbox ticked inside a note in the editor showing on its ring within the second, as it always has. The fill     *
 * reads the changed rings only: a ring read before whose note's user_updated_time has moved since, and the ring of every note the drain fetched,   *
 * which covers a note new to the mirror - created in the editor, by another plugin, over REST or synced in - whose ring was never read. Any other  *
 * ring never read is the tick's, counted as deferred, as in phase 3. A ready store's rebuild (a drain of more than 200 notes) fetched nothing by   *
 * id and any note may have changed, so its render takes the plain fill, 300 rings per list, as the lane's first rung read. The news of the build   *
 * that makes the store ready gets no fill at all: it is every note at once, most rings never read, and filling them in one go right after the      *
 * build was the one spike the perf run found.                                                                                                      *
 ***************************************************************************************************************************************************/
async function renderStoreChange(fill){
    // The drain this render draws may have settled some of the optimistic layer (settleDrained below): merge nothing it let go of.
    await settling
    var complete = !!fill && await allConsumersStoreServed()
    await refreshPanelData({ fast: true })
    if (complete) await refreshPanelData({ fillCounts: true, ringsChangedOnly: fill.plain ? null : fill.fetched })
}

/** dropStoreRender *********************************************************************************************************************************
 * Takes back the store render a drain armed, when the caller is about to render the same mirror itself (catchUpNoteStore, the tick). Answers       *
 * whether one was pending - the tick takes that as a change it owes a render for.                                                                  *
 ***************************************************************************************************************************************************/
function dropStoreRender(){
    if (!storeRenderTimer) return false
    clearTimeout(storeRenderTimer)
    storeRenderTimer = null
    storeRenderFill = null
    return true
}

/** catchUpNoteStore ********************************************************************************************************************************
 * The note store's catch-up (catchUp in noteStore.ts) for a render that must show what outside writers did: the reconcile lane's renders, and      *
 * panel.ts's truth renders. When the drain changes the mirror, its own notification arms the store render above; that render is dropped here,      *
 * because the render the caller runs next reads the same mirror - and the fast one, starting after it, would win refreshPanelData's generation     *
 * guard and paint cached rings over the fresh ones the full render has just read.                                                                  *
 ***************************************************************************************************************************************************/
export async function catchUpNoteStore(){
    await catchUp()
    dropStoreRender()
    // Taken back first, while the store render is certainly still pending; then the render the caller runs waits for what the drain settled.
    await settling
}

/** allConsumersStoreServed (2.7 phase 4) ***********************************************************************************************************
 * Whether the note store answers EVERY view Cockpit draws, right now. The consumers are the panel's current view - its profile's criteria and the  *
 * committed search text, whatever the format: the calendar formats build their criteria exactly as the lists do (fetchTodos in formats.ts) - and   *
 * each overview note, drawn from its profile's own criteria with no view state. The notebook filter plays no part: the store narrows by the        *
 * notebook's id set itself. Each view is judged by storeServes in joplin.ts, the very function its read asks, on the very string its read is built *
 * from (viewCriteria), so a trigger can never take a view for store-served while the read goes to the search, or the other way round.              *
 *                                                                                                                                                  *
 * Every trigger asks this before it picks a path: while it answers true, the reconcile ladder and the per-note read on a note change stand down    *
 * (nothing is left to chase the index for), and the tick redraws only when something has moved. One view that needs the search - a filtered        *
 * profile's overview note, a word typed into the panel - is enough to put every trigger back on its 2.6.3 path, since the ladder and the per-note  *
 * read are what that view is kept fresh by.                                                                                                        *
 *                                                                                                                                                  *
 * The store's own state is asked first, and without an await: before the build, and for the whole session when the store is off, this costs no     *
 * setting read at all. Published on the plugin's global (CockpitTriggers) for the harness, like the store's own handle.                            *
 ***************************************************************************************************************************************************/
export async function allConsumersStoreServed(){
    return !!(await storeServedConsumers())
}

// The consumers themselves when the store serves every one of them, null otherwise: the stamp below reads the same profiles it was judged on. A read
// that throws answers "not all": every trigger then takes its 2.6.3 path, whose own reads, if they fail again, fail where they always did.
async function storeServedConsumers(){
    if (!storeServes("")) return null
    try {
        var currentProfileID = await getCurrentProfileID()
        var panelProfile = await getProfile(currentProfileID)
        if (!panelProfile) return null
        if (!storeServes(viewCriteria(panelProfile.searchCriteria, getPanelSearchFilter()))) return null
        var profiles = await getAllProfiles()
        for (var profile of profiles){
            if (profile.noteID && !storeServes(viewCriteria(profile.searchCriteria, ""))) return null
        }
        return { currentProfileID: currentProfileID, panelProfile: panelProfile, profiles: profiles }
    } catch (error) {
        return null
    }
}

/** storeServesAction (2.7 phase 5) *****************************************************************************************************************
 * The one gate a panel action asks before it decides how to show its own write: every view store-served (allConsumersStoreServed above) and no     *
 * sync running - the phase 4 mid-sync rule, which the note-change trigger follows too. While it holds, the note store has the write the moment     *
 * Cockpit makes it (the write helpers update the record in the same code path), and nothing Cockpit draws reads the search, so the optimistic      *
 * layer and the reconcile ladder - which exist to show a write before Joplin's search index catches up - have nothing to do: the action renders    *
 * from the store, and the store's follow-up poll brings Joplin's own row. While it does not hold, every action takes the path it has always taken: *
 * the overlay, the completion override, the ladder.                                                                                                *
 *                                                                                                                                                  *
 * An action asks it at its start, before it feeds or writes anything (startOwnWrite below), and again around its own render (showOwnWrite in       *
 * panel.ts, afterOwnWrite below). Those later answers are the fallback: an action that started on the store path and finds the gate gone - a poll  *
 * that failed while it ran, a sync that started - takes today's path from there, so its result still shows. Published on CockpitTriggers for the   *
 * harness.                                                                                                                                         *
 ***************************************************************************************************************************************************/
export async function storeServesAction(){
    return !getSyncStatus().syncing && await allConsumersStoreServed()
}

/** startOwnWrite / afterOwnWrite (2.7 phase 5) *****************************************************************************************************
 * The two ends of a panel action that writes notes, around the gate above. startOwnWrite asks the gate at the action's start, before anything is   *
 * fed or written, and when it holds lets the optimistic layer go of the notes the action is about to write (settleOptimistic below): an override   *
 * or an entry left from a time a view needed the search would otherwise be merged over the store's truth - a note moved out of a filtered notebook *
 * drawn back in it by a stale insert, a to-do's completion by a stale tick. Answers whether the action is on the store path.                       *
 *                                                                                                                                                  *
 * afterOwnWrite is the tail of an action that feeds no overlay - a move, a due date, a trash, a duplicate, a tag or notebook edit, the alarm: its  *
 * full repaint as always (refreshInterfaces), then the reconcile ladder, unless the action started on the store path and the gate still holds once *
 * the repaint is done. The repaint then read the store, which had the write at once, and no index is left to chase. The overview lane is armed     *
 * either way. The repaint first waits for the settle queue, since a duplicate, a trashed notebook and Joplin's own move drain the store before it. *
 * The actions that do feed the overlay (the tick, the type flip, a create) render through showOwnWrite in panel.ts instead.                        *
 ***************************************************************************************************************************************************/
export async function startOwnWrite(ids){
    if (!(await storeServesAction())) return false
    settleOptimistic(ids)
    return true
}

export async function afterOwnWrite(storePath){
    // A drain the action made (a duplicate, a trashed notebook, Joplin's own move) queued its settle; the repaint must not merge what it lets go of.
    await settling
    await refreshInterfaces()
    if (!(storePath && await storeServesAction())) scheduleReconcile()
    scheduleOverview()
}

/** The optimistic layer lets go of what a drain settled (2.7 phase 5) ******************************************************************************
 * A completion override or an overlay entry holds the user's intent over a search index that has not caught up. Once every view reads the store,   *
 * the store is the truth for every note a drain has Joplin's own word on - each one it fetched by id or removed on a delete row - so the layer's   *
 * hold on those ids is at best a repeat and at worst a lie. The case that forced this: a to-do ticked while a view still needed the search, hidden *
 * by its view, then converted to a note and back in the editor (Joplin's changeNoteType resets todo_completed), or trashed and restored elsewhere, *
 * drew ticked again until the override's own 60 s timeout. So while storeServesAction holds, each drain's ids lose their override and their        *
 * overlay entry (settleOptimistic, which the panel's own store-path writes use for the ids they write), and a build or a rebuild - which re-read   *
 * every note, fetching none by id - clears the whole layer (clearAllOptimistic). While it does not hold, a view still reads the search, which is   *
 * exactly what the layer covers, and nothing is dropped. Nothing held at all - the usual case - costs no setting read.                             *
 *                                                                                                                                                  *
 * The store calls its listener synchronously as a burst ends, so the listener only queues the work; every render a drain leads to - the store      *
 * render, the catch-up before a truth render or a ladder rung, the tick's own, an own write's repaint after its drain (afterOwnWrite) - waits for  *
 * the queue first, so none of them merges an entry the drain has settled.                                                                          *
 ***************************************************************************************************************************************************/
var settling = Promise.resolve()

export function settleOptimistic(ids){
    for (var id of ids){
        clearTodoCompletionOverride(id)
        clearOptimisticItem(id)
    }
}

function settleDrained(news){
    // A build or a rebuild re-read every note, so everything held is settled, not only what a drain fetched by id.
    var everything = !!(news && (news.built || news.rebuilt))
    var ids = []
    if (news && news.fetched) for (var fetchedId of news.fetched) ids.push(fetchedId)
    if (news && news.removed) for (var removedId of news.removed) ids.push(removedId)
    if (!everything && !ids.length) return
    settling = settling.then(async () => {
        if (getSyncStatus().syncing || !hasPendingOptimistic()) return
        if (!(await storeServesAction())) return
        if (everything) clearAllOptimistic()
        else settleOptimistic(ids)
    }).catch(error => console.warn("Cockpit: could not settle the optimistic layer after a note store drain", error))
}

// The note store's listener: the settle first, so the render it schedules finds the queue already holding this drain's work.
function onStoreNews(news){
    settleDrained(news)
    scheduleStoreRender(news)
}

/** The redraw stamps (2.7 phase 4) *****************************************************************************************************************
 * The periodic tick exists for what changes with no event of its own: the date (a to-do due yesterday moving from Today to Overdue), and, before   *
 * 2.7, whatever the index had caught up with. With every view drawn from the store, the second half is gone - a change reaches the store through   *
 * the feed and renders at once - so a tick that recomputed the whole panel every minute would redo, at full cost, work whose answer is already on  *
 * screen; the equality guard in refreshPanelData only hides the identical repaint, not the computing. So each complete drawing records a STAMP of  *
 * everything it was drawn from that can change without Cockpit drawing again, and the tick draws only when the stamp no longer holds:              *
 *                                                                                                                                                  *
 *   served    - every view was store-served (a stamp taken on the search paths never holds)                                                        *
 *   revision  - the store's revision: any note that changed                                                                                        *
 *   day, zone - the local date, and the time zone it is taken in. Every day boundary in the markup is local midnight (horizons.js, the completed   *
 *               buckets, the calendars' today); the day-start setting only places a dropped to-do, so it is not an input here                      *
 *   due       - the month calendar alone depends on the time of day: a dot turns overdue the moment its to-do's due time passes. For that view,    *
 *               how many of the store's to-dos are past due; any due time passing moves it (0 for every other format)                              *
 *   folders   - the notebook map's generation (joplin.ts): notebooks write no feed row, and their names, nesting and exclusions are drawn          *
 *   tags      - the tag list's generation: the search field's autocomplete carries it, and tags write no feed row either                           *
 *   profiles  - every profile (the overview notes' views), and for the panel which one is current                                                  *
 *                                                                                                                                                  *
 * and, beside the stamp, whether the optimistic layer was empty both when the stamp was taken and when the drawing finished: an entry retires on a *
 * clock of its own (optimistic.ts), which no stamp can see - one merged into a drawing may run out before the drawing ends - so while one is held, *
 * or was at any point of the last drawing, the tick draws as it always did.                                                                        *
 *                                                                                                                                                  *
 * Two stamps are kept, because two things are drawn. The panel's is recorded by refreshPanelData for a COMPLETE render only (not a fast or an      *
 * optimistic one, and not a fill the per-refresh body cap cut short) and dropped by every other render; the overview notes' by a pass over all of  *
 * them (regenerateOverviewNotes). A render the panel skips - hidden on desktop, held on mobile while a dialog or the search field is open -        *
 * records nothing, so once something moves the stamp stays behind and the ticks go on drawing, as they always did, until the panel draws again.    *
 * The settings, the theme, the sync button and the panel's own controls (profile, notebook filter, search, sort, calendar) are not in the stamp:   *
 * each of them already draws, completely, when it changes.                                                                                         *
 ***************************************************************************************************************************************************/
const panelStampKeys = ["served", "revision", "day", "zone", "due", "folders", "tags", "profiles", "current"]
const overviewStampKeys = ["served", "revision", "day", "zone", "folders", "profiles"]
var panelRedrawnFrom = null
var overviewsRedrawnFrom = null

export async function redrawStamp(){
    var consumers = await storeServedConsumers()
    if (!consumers) return { served: false }
    var now = new Date()
    return {
        served: true,
        overlayIdle: !hasPendingOptimistic(),
        revision: getStoreModel().revision,
        day: toISODate(now),
        zone: timeZoneOf(now),
        due: consumers.panelProfile.displayFormat === "month" ? pastDueCount(now.getTime()) : 0,
        folders: notebookMapGeneration(),
        tags: tagListGeneration(),
        profiles: JSON.stringify(consumers.profiles),
        current: String(consumers.currentProfileID),
    }
}

// A render has started: until one finishes complete, the panel is not known to be current.
export function beginPanelRedraw(){
    panelRedrawnFrom = null
}

// A render has finished, drawn from `stamp` - or from something provisional, when the caller passes null.
export function recordPanelRedraw(stamp){
    panelRedrawnFrom = stamp ? settledStamp(stamp) : null
}

// The stamp as a finished drawing leaves it: the optimistic layer counts as empty only if it was when the stamp was taken AND is now. A stamp taken
// on the search paths never holds, so it is kept as it is, and those paths do not so much as sweep the layer for it.
function settledStamp(stamp){
    if (!stamp.served) return stamp
    return { ...stamp, overlayIdle: stamp.overlayIdle && !hasPendingOptimistic() }
}

function stampHolds(recorded, now, keys){
    return !!recorded && recorded.overlayIdle && now.served && keys.every(key => recorded[key] === now[key])
}

function timeZoneOf(now){
    var zone = ""
    try {
        zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""
    } catch (error) {
        zone = ""
    }
    return `${now.getTimezoneOffset()} ${zone}`
}

function pastDueCount(nowMs){
    var count = 0
    for (var todo of getStoreModel().todos()) if (todo.todo_due > 0 && todo.todo_due < nowMs) count++
    return count
}

/** nothingToRedraw *********************************************************************************************************************************
 * The tick's question: do both stamps still hold? The notebook map and the tag list are refreshed first, exactly as a render would refresh them -  *
 * one page each once their 20 s caches have lapsed, which at the default interval is every tick - so a notebook or a tag changed elsewhere moves   *
 * its generation before the stamps are compared. A read that fails answers "redraw", and the render that follows reports the failure.              *
 ***************************************************************************************************************************************************/
async function nothingToRedraw(){
    if (hasPendingOptimistic()) return false
    try {
        await getNotebookMap()
        await getAllTags()
    } catch (error) {
        return false
    }
    var now = await redrawStamp()
    return stampHolds(panelRedrawnFrom, now, panelStampKeys) && stampHolds(overviewsRedrawnFrom, now, overviewStampKeys)
}

/** setupTimer ***************************************************************************************************************************************
 * Starts, or restarts, the periodic backstop refresh. It is the date-boundary safety net (a to-do rolling from Today to Overdue as time passes, and    *
 * the same in the overview notes), so it runs the full refreshInterfaces - but that already takes the fast paint path, so it never stalls on bodies.    *
 * Since 2.7 phase 4 it runs it only when there is something to draw, once the note store serves every view (see refreshOnTick).                    *
 ***************************************************************************************************************************************************/
export async function setupTimer(){
    clearInterval(timer)
    var mobile = await isMobile()
    var updateFrequency = Number(await joplin.settings.value(updateFrequencySettingKey))
    if (!Number.isFinite(updateFrequency) || updateFrequency < 1) updateFrequency = defaultUpdateFrequency
    // Only when the user has left the interval at its default is it raised on mobile; an explicitly set
    // value is always honoured. Desktop keeps the 60s default untouched.
    if (mobile && updateFrequency === defaultUpdateFrequency) updateFrequency = defaultMobileUpdateFrequency
    // The callback returns the promise so the tick is awaitable (harnessable); setInterval ignores it. What the tick cost in data calls, renders
    // and paints is recorded once its jobs have settled (logTick in instrument.ts): the number the 2.7 perf run reads as "calls per tick".
    timer = setInterval(() => {
        var tickStartedAt = Date.now()
        var tickBefore = snapshot()
        return Promise.all([
            // The settings note's backstop, and its ONE cheap call: a single updated_time field read tells whether the note moved at all,
            // and only then is the body fetched (see pollSettingsNote). It also drains any write the editor gate deferred. With the feature
            // off it returns before touching anything, so this tick costs exactly what it cost before the feature existed. Guarded on its
            // own, so nothing about the settings note can stop the panel from being repainted.
            pollSettingsNote("tick").catch(error => console.warn("Cockpit: could not poll the settings note", error)),
            // The panel, the overview notes and the note store's poll (see refreshOnTick).
            refreshOnTick(),
        ]).then(results => {
            logTick(tickBefore, tickStartedAt)
            return results
        })
    }, updateFrequency * 1000);
}

/** refreshOnTick ***********************************************************************************************************************************
 * The tick's own work. While any view needs the search (and before the store is ready, or for the whole session when it is off), it is what it has *
 * always been: the full refreshInterfaces, and beside it the note store's poll (2.7) - one events call when nothing changed, and no follow-up,     *
 * which is for saves; every save fires onNoteChange, which arms its own. Not while a sync runs: onSyncComplete catches up once. Decided without an *
 * await when the store cannot serve, so that tick starts its work exactly as it always did.                                                        *
 *                                                                                                                                                  *
 * When the store serves every view (phase 4), the poll comes FIRST, and what it brought decides the rest:                                          *
 *  - it changed the mirror: its notification has just armed the store render, which is taken back here and replaced by ONE full refresh - the tick *
 *    owes the overview notes that change as well, and the drain is then drawn once, not twice;                                                     *
 *  - it changed nothing: the full refresh runs only when a redraw stamp no longer holds (nothingToRedraw) - the day turned, a due time passed on   *
 *    the month calendar, a notebook or a tag changed, a held optimistic entry may have run out, a render since the last tick was provisional or    *
 *    left rings unread, or an earlier change has not reached the overview notes yet. On an idle minute that is one events call, the notebook map's *
 *    and the tag list's pages once their caches lapse, and no render at all.                                                                       *
 * The poll's continuation runs before the store render's zero-delay timer can fire (a resolved promise is a microtask, the timer a task), so the   *
 * render it armed is always still there to take back.                                                                                              *
 ***************************************************************************************************************************************************/
function refreshOnTick(){
    var syncing = getSyncStatus().syncing
    if (!storeServes("")) return Promise.all([refreshInterfaces(), syncing ? null : pollOnTick()])
    return refreshOnStoreTick(syncing)
}

async function refreshOnStoreTick(syncing){
    if (!(await allConsumersStoreServed())) return Promise.all([refreshInterfaces(), syncing ? null : pollOnTick()])
    if (!syncing) await pollOnTick()
    var drainOwed = dropStoreRender()
    // After the drop, for the reason given above; the render below must not merge what the drain settled.
    await settling
    if (!drainOwed && await nothingToRedraw()) return
    await refreshInterfaces()
}

/** setupWorkspaceEvents *****************************************************************************************************************************
 * Refreshes the interfaces in response to the events that can change the to-do list. Each handler is registered separately so that an event that is  *
 * unavailable on the current platform does not prevent the others from being registered.                                                            *
 ***************************************************************************************************************************************************/
export async function setupWorkspaceEvents(){
    // Not a workspace event, but the same kind of news: the note store (2.7) changed, so a view drawn from it needs a render (see the note store
    // lane above). Subscribed once, here, with the events that feed it.
    subscribeToNoteStore(onStoreNews)
    await registerEvent("onNoteChange", async (event) => {
        // The note store (2.7) takes EVERY note change as a hint - the settings note and the overview notes are notes too, and the change feed,
        // not this event, says what actually changed - and polls once per burst. Not while a sync runs, for the reason the external-change path
        // below gives: a sync changes hundreds of notes, and onSyncComplete polls once for the whole of it.
        if (!getSyncStatus().syncing) scheduleNoteStorePoll()
        // The settings note is not content: it carries no to-dos, so it belongs in neither the reconcile lane nor the external-change
        // path (which would fetch it as an ordinary note and hand it to the optimistic layer). It gets its own short-debounced read
        // instead, which is also a drain point for a write this device still owes. Checked first, and from a mirrored id, so the
        // question costs a string comparison.
        if (event && isSettingsNote(event.id)){
            scheduleSettingsNoteRead()
            return
        }
        // Cockpit writes the overview notes itself, so refreshing on those changes would loop.
        if (event && (await getOverviewNoteIDs()).includes(event.id)) return
        // Every view read from the note store (2.7 phase 4): the debounced poll armed above IS the whole of the panel's update - its drain fetches
        // the note, and the store's notification renders it, rings and all (renderStoreChange). The per-note read and the overlay entry below, and
        // the reconcile ladder, exist to beat the search index, and no view is waiting on one. The overview notes are rewritten on their debounce,
        // from the store as well. NOT while a sync runs: no poll was armed above then, the tick does not poll either, and the reconcile ladder's
        // rungs are what drain the store until the sync completes (catchUpNoteStore) - so a change to the open note mid-sync takes that path.
        if (await storeServesAction()){
            scheduleOverview()
            return
        }
        // Targeted optimistic reconcile for a single external change, so a note created / moved / trashed
        // elsewhere shows or disappears without waiting for the periodic timer. Skipped while a sync runs -
        // sync changes hundreds of notes, which would be hundreds of per-note GETs, and the post-sync
        // reconcile lane covers that set instead. It reports whether it left a host-held optimistic entry, so
        // the reconcile lane knows this arm is optimistic (may early-stop) rather than a blind change (must run
        // its offsets out); a change reconciled during a sync, or one that touched nothing, counts as neither.
        var touchedOptimistic = false
        if (event && event.id && !getSyncStatus().syncing) touchedOptimistic = await reconcileExternalNoteChange(event.id)
        // The panel catches the index up through the bounded reconcile job; the overview notes follow on
        // their own slower debounce. Neither regenerates the whole world, and a burst collapses into one of
        // each rather than the old 1/5/15/30s cascade of full rebuilds.
        scheduleReconcile(touchedOptimistic)
        scheduleOverview()
    })
    // onSyncStart carries no payload (its withErrors is only known at the end), so the button state
    // is measured here: a start sets "syncing", and the panel is re-rendered at once so the
    // Synchronize button starts spinning without waiting for a data refresh.
    await registerEvent("onSyncStart", () => {
        markSyncStart()
        // Fast paint: the button only needs to start spinning; there is no reason to fetch note bodies or
        // rebuild any dataset for a sync-status change, so this renders the rings from cache and stops. The
        // promise is returned (not fire-and-forget) so the paint is awaitable.
        return refreshPanelData({ fast: true })
    })
    await registerEvent("onSyncComplete", async (event) => {
        markSyncComplete(event && event.withErrors)
        // Re-render at once so the button stops spinning immediately (fast: no body fetches just for the
        // button), then arm ONE reconcile job to let the index catch up with whatever the sync pulled in -
        // not an unconditional full cascade.
        await refreshPanelData({ fast: true })
        // A completed sync is when another device's settings note actually arrives, so it is the natural read point - and the drain
        // point for any write of our own the editor gate deferred. A no-op while the feature is off.
        await syncSettingsNote("sync")
        // Every view read from the note store (2.7 phase 4): no index to let catch up, so no reconcile job. The overview pass is armed as below,
        // and the poll at the end drains what the sync brought, whose notification renders it once (renderStoreChange). Asked after the settings
        // note's read, which may just have replaced the profiles - and with them the views.
        if (await allConsumersStoreServed()){
            scheduleOverview()
            await pollNow()
            return
        }
        scheduleReconcile()
        // Arm ONE overview pass too. The per-note-change lane armed DURING the sync is not enough on its own:
        // if the sync's last onNoteChange settled more than the overview debounce (10s) before completion, that
        // debounce already fired mid-sync on a stale snapshot and nothing re-armed it, so the overview notes
        // would stay stale until the periodic backstop. A single scheduleOverview here collapses with any still
        // -pending per-change debounce (it does not stack) and rewrites the notes once the index has settled.
        scheduleOverview()
        // The note store (2.7) catches up with everything the sync brought in, in one drain. Last, so the button and the lanes above are not
        // held up by it.
        await pollNow()
    })
    await registerEvent("onNoteAlarmTrigger", () => { scheduleReconcile(); scheduleOverview() })
    // The only subscription here that is NOT a refresh trigger: which note the editor is showing decides
    // which row the panel highlights, and nothing else. It changes no note data and no markup, so it arms
    // no lane and issues no search, GET or render - just a message to the webview (see panel.ts). The
    // event carries the selected ids as { value: [...] }.
    await registerEvent("onNoteSelectionChange", async (event) => {
        trackEditorNoteSelection(event && event.value)
        // The settings note's editor gate drains here: a plugin PUT evicts the mobile editor, so a write deferred while the settings
        // note was the open note goes the moment the editor moves off it. Nothing is owed on an ordinary selection change, and nothing
        // at all is done while the feature is off, so this stays the one subscription that issues no search, GET or render.
        await drainDeferredSettingsNoteWrite()
    })
}

/** registerEvent ************************************************************************************************************************************
 * Registers a single workspace event handler, logging rather than throwing when the event is not supported                                          *
 ***************************************************************************************************************************************************/
async function registerEvent(eventName, handler){
    try {
        await joplin.workspace[eventName](handler)
    } catch (error) {
        console.warn(`Cockpit: could not subscribe to ${eventName}`, error)
    }
}

/** The inspection handle **************************************************************************************************************************/
// storeServesAction is the phase 5 gate; optimisticHeld tells the harness whether the optimistic layer holds an overlay entry, and whether it holds
// anything at all (an entry or a completion override), without giving it a way to change either.
function optimisticHeld(){
    return { itemOverlay: hasPendingItemOverlay(), anything: hasPendingOptimistic() }
}
;(globalThis as any).CockpitTriggers = Object.freeze({ allConsumersStoreServed, storeServesAction, optimisticHeld })
