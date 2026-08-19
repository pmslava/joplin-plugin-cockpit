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
 *                                                                                                                                                    *
 *  A profile switch is deliberately none of these: it changes no note data, so it paints (from cache / one search) and stops - see panel.ts.          *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";
import { reconcileExternalNoteChange, refreshPanelData } from "../ui/panel/panel";
import { getOverviewNoteIDs, refreshNoteData } from "./markdown";
import { updateFrequencySettingKey } from "./settings";
import { getSyncStatus, markSyncComplete, markSyncStart } from "./syncStatus";
import { hasPendingOptimistic } from "./optimistic";
import { isMobile } from "./platform";

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
            await refreshNoteData()
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
 ***************************************************************************************************************************************************/
const reconcileOffsetsMs = [1000, 3000, 7000, 15000, 30000]
var reconcileTimers = []
var reconcileExpectRetire = false
// A generation stamp bumped on every (re)arm. A poll captures the generation it belongs to and, when it
// resumes from its await, refuses to touch the lane if a newer burst has since taken it over - otherwise a
// slow in-flight poll from an old burst could cancel the fresh burst's timers.
var reconcileGeneration = 0

export function scheduleReconcile(){
    for (var pending of reconcileTimers) clearTimeout(pending)
    var generation = ++reconcileGeneration
    // Whether we are waiting on the optimistic layer to be confirmed by the index. Captured now, at (re)arm
    // time, so a burst that adds a new optimistic entry re-enables the early stop.
    reconcileExpectRetire = hasPendingOptimistic()
    // The callback returns the poll's promise so the work is awaitable (harnessable); setTimeout ignores it.
    reconcileTimers = reconcileOffsetsMs.map(delay => setTimeout(() => reconcilePoll(generation), delay))
}

function cancelReconcile(){
    for (var pending of reconcileTimers) clearTimeout(pending)
    reconcileTimers = []
}

async function reconcilePoll(generation){
    // A real, search-based refresh (not the cache/fast path): it lets the index catch up, retires any
    // optimistic entry the search now agrees with, fetches only the bodies of genuinely-changed notes, and
    // repaints only when the result actually changed (refreshPanelData's equality guard). A poll that finds
    // nothing new therefore costs a single search.
    await refreshPanelData()
    // A newer burst has taken over the lane while this poll was awaiting: it owns the timers now, so leave
    // them be (this poll's own timers were already cleared when that burst re-armed).
    if (generation !== reconcileGeneration) return
    // Nothing left to confirm: cancel the remaining offsets.
    if (reconcileExpectRetire && !hasPendingOptimistic()) cancelReconcile()
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
        await refreshNoteData(scope === "all" ? undefined : scope)
    } catch (error) {
        console.error("Cockpit: could not refresh the overview notes", error)
    }
}

/** setupTimer ***************************************************************************************************************************************
 * Starts, or restarts, the periodic backstop refresh. It is the date-boundary safety net (a to-do rolling from Today to Overdue as time passes, and    *
 * the same in the overview notes), so it runs the full refreshInterfaces - but that already takes the fast paint path, so it never stalls on bodies.    *
 ***************************************************************************************************************************************************/
export async function setupTimer(){
    clearInterval(timer)
    var mobile = await isMobile()
    var updateFrequency = Number(await joplin.settings.value(updateFrequencySettingKey))
    if (!Number.isFinite(updateFrequency) || updateFrequency < 1) updateFrequency = defaultUpdateFrequency
    // Only when the user has left the interval at its default is it raised on mobile; an explicitly set
    // value is always honoured. Desktop keeps the 60s default untouched.
    if (mobile && updateFrequency === defaultUpdateFrequency) updateFrequency = defaultMobileUpdateFrequency
    timer = setInterval(() => { void refreshInterfaces() }, updateFrequency * 1000);
}

/** setupWorkspaceEvents *****************************************************************************************************************************
 * Refreshes the interfaces in response to the events that can change the to-do list. Each handler is registered separately so that an event that is  *
 * unavailable on the current platform does not prevent the others from being registered.                                                            *
 ***************************************************************************************************************************************************/
export async function setupWorkspaceEvents(){
    await registerEvent("onNoteChange", async (event) => {
        // Cockpit writes the overview notes itself, so refreshing on those changes would loop.
        if (event && (await getOverviewNoteIDs()).includes(event.id)) return
        // Targeted optimistic reconcile for a single external change, so a note created / moved / trashed
        // elsewhere shows or disappears without waiting for the periodic timer. Skipped while a sync runs -
        // sync changes hundreds of notes, which would be hundreds of per-note GETs, and the post-sync
        // reconcile lane covers that set instead.
        if (event && event.id && !getSyncStatus().syncing) await reconcileExternalNoteChange(event.id)
        // The panel catches the index up through the bounded reconcile job; the overview notes follow on
        // their own slower debounce. Neither regenerates the whole world, and a burst collapses into one of
        // each rather than the old 1/5/15/30s cascade of full rebuilds.
        scheduleReconcile()
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
        // not an unconditional full cascade. The overview notes are covered by the per-note-change lane armed
        // during the sync (and by the periodic backstop), so nothing extra is scheduled here.
        await refreshPanelData({ fast: true })
        scheduleReconcile()
    })
    await registerEvent("onNoteAlarmTrigger", () => { scheduleReconcile(); scheduleOverview() })
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
