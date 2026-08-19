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
var counters = { search: 0, get: 0, put: 0, post: 0, del: 0, bodies: 0 }

/** countData **************************************************************************************************************************************
 * Tallies one data call. A ['search'] GET counts as a search; a single-note body-only GET counts as a body fetch; any other single-note GET counts as  *
 * a plain get. Called from the joplin.ts data helpers so every categorised call is captured in one place.                                              *
 ***************************************************************************************************************************************************/
export function countData(kind){
    if (counters[kind] === undefined) return
    counters[kind]++
}

/** snapshot / delta *******************************************************************************************************************************/
export function snapshot(){
    return { search: counters.search, get: counters.get, put: counters.put, post: counters.post, del: counters.del, bodies: counters.bodies }
}
function delta(before){
    return {
        search: counters.search - before.search,
        get: counters.get - before.get,
        put: counters.put - before.put,
        bodies: counters.bodies - before.bodies,
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
    console.info(`Cockpit refresh [${label}] ${ms}ms — search:${d.search} get:${d.get} put:${d.put} bodies:${d.bodies}`)
}
