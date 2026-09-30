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
var counters = { search: 0, listing: 0, get: 0, put: 0, post: 0, del: 0, bodies: 0, events: 0, folders: 0 }

/** countData ***************************************************************************************************************************************
 * Tallies one data call. A ['search'] GET counts as a search, a page of the live ['notes'] listing as a listing, a single-note body-only GET as a  *
 * body fetch, any other single-note GET as a plain get, a call of the change feed (the note store's ['events']) as events, and a page of the       *
 * notebook map's ['folders'] read as folders. Called from the joplin.ts data helpers and the note store, so every categorised call is captured in  *
 * one place.                                                                                                                                       *
 ***************************************************************************************************************************************************/
export function countData(kind){
    if (counters[kind] === undefined) return
    counters[kind]++
}

/** snapshot / delta *******************************************************************************************************************************/
export function snapshot(){
    return { search: counters.search, listing: counters.listing, get: counters.get, put: counters.put, post: counters.post, del: counters.del, bodies: counters.bodies, events: counters.events, folders: counters.folders }
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
 * Counted are the categories countData knows. Calls it does not see: the folder poll's own page every few seconds (panel.ts, outside any tick),    *
 * the settings note's cheap check, and the panel's writes that go straight through joplin.data.                                                    *
 ***************************************************************************************************************************************************/
const tickHistoryCap = 30
var tickHistory = []

export function logTick(before, startedAt){
    var entry = { at: startedAt, ms: Date.now() - startedAt, ...delta(before) }
    tickHistory.push(entry)
    while (tickHistory.length > tickHistoryCap) tickHistory.shift()
    if (!DEBUG) return
    console.info(`Cockpit tick ${entry.ms}ms — search:${entry.search} listing:${entry.listing} get:${entry.get} put:${entry.put} post:${entry.post} del:${entry.del} bodies:${entry.bodies} events:${entry.events} folders:${entry.folders}`)
}

/** The inspection handle **************************************************************************************************************************/
;(globalThis as any).CockpitInstrument = Object.freeze({
    snapshot,
    ticks: () => tickHistory.map(entry => ({ ...entry })),
})
