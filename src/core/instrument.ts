/** README ******************************************************************************************************************************************
 * Lightweight, import-free refresh instrumentation. It counts the plugin's Joplin data calls by category (search / get / put / bodies) and lets a      *
 * refresh be bracketed to log its wall time and the calls it made. It is inert unless DEBUG is turned on below - the counters are a couple of integer   *
 * increments on the data paths, and nothing is ever logged - so it costs effectively nothing in normal use but makes the before/after of the           *
 * performance work measurable when investigating.                                                                                                      *
 ***************************************************************************************************************************************************/

/** DEBUG ******************************************************************************************************************************************
 * Flip to true to log, via console.info, one line per painted refresh: its wall time and how many searches / single-note GETs / PUTs / checkbox-body   *
 * fetches it issued. Shipped false.                                                                                                                    *
 ***************************************************************************************************************************************************/
const DEBUG = false

/** counters ***************************************************************************************************************************************
 * Monotonic per-session tallies. A refresh reads a snapshot on entry and diffs it against the counters when it paints, so the numbers it logs are the  *
 * calls that refresh alone made.                                                                                                                       *
 ***************************************************************************************************************************************************/
var counters = { search: 0, listing: 0, get: 0, put: 0, post: 0, del: 0, bodies: 0, events: 0, folders: 0, tags: 0, renders: 0, paints: 0 }

/** countData ***************************************************************************************************************************************
 * Tallies one data call. A ['search'] GET counts as a search, a page of the live ['notes'] listing as a listing, a single-note body-only GET as a  *
 * body fetch, any other single-note GET as a plain get, a call of the change feed (the note store's ['events']) as events, a page of the           *
 * notebook map's ['folders'] read as folders, and a page of the tag list (the search field's autocomplete) as tags. Called from the joplin.ts data *
 * helpers and the note store, so every categorised call is captured in one place.                                                                  *
 ***************************************************************************************************************************************************/
export function countData(kind){
    if (counters[kind] === undefined) return
    counters[kind]++
}

/** countRender / countPaint (2.7 phase 4) **********************************************************************************************************
 * The panel's own work, beside the data calls: a render is one computation of the panel's markup (panel.ts's refreshPanelData got as far as        *
 * building it), a paint is one setHtml, which a render only does when its markup differs from what is on screen. The periodic tick no longer       *
 * recomputes a panel whose inputs have not moved, and these two are how the per-tick record shows it: an idle tick renders nothing at all.         *
 ***************************************************************************************************************************************************/
export function countRender(){
    counters.renders++
}

export function countPaint(){
    counters.paints++
}

/** snapshot / delta *******************************************************************************************************************************/
export function snapshot(){
    return { search: counters.search, listing: counters.listing, get: counters.get, put: counters.put, post: counters.post, del: counters.del, bodies: counters.bodies, events: counters.events, folders: counters.folders, tags: counters.tags, renders: counters.renders, paints: counters.paints }
}
function delta(before){
    return {
        search: counters.search - before.search,
        listing: counters.listing - before.listing,
        get: counters.get - before.get,
        put: counters.put - before.put,
        post: counters.post - before.post,
        del: counters.del - before.del,
        bodies: counters.bodies - before.bodies,
        events: counters.events - before.events,
        folders: counters.folders - before.folders,
        tags: counters.tags - before.tags,
        renders: counters.renders - before.renders,
        paints: counters.paints - before.paints,
    }
}

/** logRefresh *************************************************************************************************************************************
 * Emits the one-line summary for a painted refresh, when DEBUG is on. label distinguishes the trigger (fast / fill / reconcile / full), before is the  *
 * snapshot taken on entry, startedAt the entry timestamp.                                                                                              *
 ***************************************************************************************************************************************************/
export function logRefresh(label, before, startedAt){
    if (!DEBUG) return
    var d = delta(before)
    var ms = Date.now() - startedAt
    console.info(`Cockpit refresh [${label}] ${ms}ms — search:${d.search} listing:${d.listing} get:${d.get} put:${d.put} bodies:${d.bodies} events:${d.events}`)
}

/** logTick (2.7) ***********************************************************************************************************************************
 * What one periodic tick cost in data calls: timer.ts takes a snapshot when the tick starts and calls this once all of its jobs have settled. The  *
 * 2.7 acceptance target is about exactly this number - with the note store ready, a tick of an unchanged collection is ONE events call - and a     *
 * perf run has to be able to read it without a DEBUG build, so every tick is kept (the last tickHistoryCap of them) and published with the         *
 * counters on the plugin's global as CockpitInstrument, the way the note store publishes CockpitNoteStore. With DEBUG on, each tick also logs one  *
 * line.                                                                                                                                            *
 *                                                                                                                                                  *
 * Counted are the categories countData knows, and since phase 4 the panel's renders and paints (countRender, countPaint). Calls it does not see:   *
 * the folder poll's own page every few seconds (panel.ts, outside any tick), the settings note's cheap check, and the panel's writes that go       *
 * straight through joplin.data.                                                                                                                    *
 ***************************************************************************************************************************************************/
const tickHistoryCap = 30
var tickHistory = []

export function logTick(before, startedAt){
    var entry = { at: startedAt, ms: Date.now() - startedAt, ...delta(before) }
    tickHistory.push(entry)
    while (tickHistory.length > tickHistoryCap) tickHistory.shift()
    if (!DEBUG) return
    console.info(`Cockpit tick ${entry.ms}ms — search:${entry.search} listing:${entry.listing} get:${entry.get} put:${entry.put} post:${entry.post} del:${entry.del} bodies:${entry.bodies} events:${entry.events} folders:${entry.folders} tags:${entry.tags} renders:${entry.renders} paints:${entry.paints}`)
}

/** The note store's memory (2.7) *******************************************************************************************************************
 * The one figure the 2.7 acceptance list wants from the app itself: what the note store costs the plugin's renderer. noteStore.ts marks the start  *
 * of its build and the end of the build's replay; each mark reads performance.memory.usedJSHeapSize - Chromium's, in the plugin's own window - and *
 * the end also records how many notes the mirror then holds. Where the engine offers no performance.memory (Node, the harness) a reading is null.  *
 * Only the first build that reaches its replay is kept: a later rebuild starts from a heap that already holds a store, so its difference would say *
 * nothing about the store's size. Published through CockpitInstrument.snapshot() as storeHeap: { beforeBuild, afterBuild, notes }, all null until  *
 * measured.                                                                                                                                        *
 ***************************************************************************************************************************************************/
var storeHeap = { beforeBuild: null, afterBuild: null, notes: null }
var storeHeapTaken = false

function usedHeap(){
    try {
        var memory = (globalThis as any).performance && (globalThis as any).performance.memory
        return memory && typeof memory.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : null
    } catch (error) {
        return null
    }
}

export function markStoreBuildStart(){
    if (storeHeapTaken) return
    storeHeap = { beforeBuild: usedHeap(), afterBuild: null, notes: null }
}

export function markStoreBuildEnd(notes){
    if (storeHeapTaken) return
    storeHeapTaken = true
    storeHeap = { beforeBuild: storeHeap.beforeBuild, afterBuild: usedHeap(), notes: notes }
}

/** The inspection handle **************************************************************************************************************************/
// snapshot() is the counters as they always were, with storeHeap beside them (2.7); ticks() is unchanged.
;(globalThis as any).CockpitInstrument = Object.freeze({
    snapshot: () => ({ ...snapshot(), storeHeap: { ...storeHeap } }),
    ticks: () => tickHistory.map(entry => ({ ...entry })),
})
