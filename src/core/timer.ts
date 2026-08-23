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
import { reconcileExternalNoteChange, refreshPanelData, trackEditorNoteSelection } from "../ui/panel/panel";
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
        scheduleReconcile()
        // Arm ONE overview pass too. The per-note-change lane armed DURING the sync is not enough on its own:
        // if the sync's last onNoteChange settled more than the overview debounce (10s) before completion, that
        // debounce already fired mid-sync on a stale snapshot and nothing re-armed it, so the overview notes
        // would stay stale until the periodic backstop. A single scheduleOverview here collapses with any still
        // -pending per-change debounce (it does not stack) and rewrites the notes once the index has settled.
        scheduleOverview()
    })
    await registerEvent("onNoteAlarmTrigger", () => { scheduleReconcile(); scheduleOverview() })
    // The only subscription here that is NOT a refresh trigger: which note the editor is showing decides
    // which row the panel highlights, and nothing else. It changes no note data and no markup, so it arms
    // no lane and issues no search, GET or render - just a message to the webview (see panel.ts). The
    // event carries the selected ids as { value: [...] }.
    await registerEvent("onNoteSelectionChange", (event) => trackEditorNoteSelection(event && event.value))
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
