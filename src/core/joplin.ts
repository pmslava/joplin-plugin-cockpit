/** README *****************************************************************************************************************************************
 * This file handles misc calls to the joplin plugin api                                                                                           *
 **************************************************************************************************************************************************/

/* Imports *****************************************************************************************************************************************/
import joplin from 'api';
import { applyTodoCompletionOverrides, mergeOptimisticNotes, mergeOptimisticTodos } from './optimistic';
import { EXCLUDED_NOTEBOOK_IDS_KEY, buildExclusionClauses, excludedDescendantIdSet, parseExcludedIds } from './exclusion';
import { countData } from './instrument';

/** Excluded notebooks *****************************************************************************************************************************
 * The "Excluded notebooks" feature evaluates exclusion by notebook ID (the hidden excludedNotebookIds setting is the single source of truth). Two      *
 * things are derived from it at query time, both from the CURRENT notebook map so a later rename/move or a newly created sub-notebook is honoured:      *
 *  - a set of every excluded id AND its descendants, used to filter results client-side (the authority);                                               *
 *  - "-notebook:\"Title\"" clauses appended to the search query as a server-side optimisation, omitting any title shared with a kept notebook.          *
 * When nothing is excluded the whole thing short-circuits to a no-op with no extra work (empty = feature off).                                          *
 ***************************************************************************************************************************************************/
async function excludedContext(){
    var ids = parseExcludedIds(await joplin.settings.value(EXCLUDED_NOTEBOOK_IDS_KEY))
    if (!ids.length) return { set: null, clauses: "" }
    var map = await getNotebookMap()
    return { set: excludedDescendantIdSet(map, ids), clauses: buildExclusionClauses(map, ids) }
}

/** getExcludedNotebookIdSet ************************************************************************************************************************
 * The set of every excluded notebook id and its descendants, from the current map, for callers outside the search paths - the notebook picker/filter   *
 * (which must not offer an excluded notebook) and the optimistic-insert guards (which must not surface a note that lives in one). Empty when the        *
 * feature is off.                                                                                                                                       *
 ***************************************************************************************************************************************************/
export async function getExcludedNotebookIdSet(){
    var ids = parseExcludedIds(await joplin.settings.value(EXCLUDED_NOTEBOOK_IDS_KEY))
    if (!ids.length) return new Set()
    return excludedDescendantIdSet(await getNotebookMap(), ids)
}

/** filterExcluded *********************************************************************************************************************************
 * Drops every item that lives in an excluded notebook (or one of its descendants). A no-op when the feature is off (set is null).                      *
 ***************************************************************************************************************************************************/
function filterExcluded(items, set){
    return set ? items.filter(item => !set.has(item.parent_id)) : items
}

/** Result-set cache ********************************************************************************************************************************
 * The last search result for each distinct query, so an optimistic re-render (a tick, a Cockpit create, an external note change) can repaint from    *
 * the item already in hand without issuing another search. Keyed by the full query string and bounded, so the panel query is not evicted by the       *
 * overview-note queries that run in the same refresh cycle. Only read when the caller asks for the cache (useCache); an ordinary refresh always        *
 * searches and refreshes the entry, so the cache never serves stale data on its own - it is a fast lane for the optimistic paths, which layer the      *
 * host-held overlay/overrides on top so the just-changed item still shows.                                                                            *
 ***************************************************************************************************************************************************/
const resultCacheCap = 24
var todosResultCache = new Map()
var notesResultCache = new Map()
// The unfiltered "results outside current filters" peek, keyed by the verbatim search text. Read only on the
// non-primary renders (optimistic / fill), so the fast-paint -> fill -> optimistic sequence of one logical
// refresh reuses a single outside search instead of issuing one per render; a primary (committed) search
// always refreshes the entry. Each entry keeps hasMore too, since it drives the peek's "+more" footer.
var peekResultCache = new Map()
// The deep last-resort tier's search (searchExcludedNotebooks), keyed by the verbatim search text, cached the
// same way as the peek so the fast-paint -> fill -> optimistic sequence of one refresh re-uses a single deep
// search instead of one per render. Separate from peekResultCache because the two run DIFFERENT queries for the
// same text (the peek appends the exclusion clauses, the deep tier does not), so a shared key would collide.
var excludedResultCache = new Map()

/** invalidateResultCaches **************************************************************************************************************************
 * Drops every cached search result. Called when a change makes the cached sets wrong for a reason other than a fresh search of their own query - the    *
 * "Excluded notebooks" setting changing is the case: the excluded id set and the query clauses both shift, so any previously cached (pre-exclusion)     *
 * result must not be reused by an optimistic repaint. The outside-results peek cache is dropped alongside them.                                          *
 ***************************************************************************************************************************************************/
export function invalidateResultCaches(){
    todosResultCache = new Map()
    notesResultCache = new Map()
    peekResultCache = new Map()
    excludedResultCache = new Map()
}

function cloneItems(items){
    return items.map(item => ({ ...item }))
}

function cacheResult(cache, query, items){
    if (cache.has(query)) cache.delete(query)
    cache.set(query, cloneItems(items))
    while (cache.size > resultCacheCap) cache.delete(cache.keys().next().value)
}

// Like cacheResult, but stores the peek's { items, hasMore } wrapper (hasMore feeds the footer) with the same
// clone-on-write and bounded LRU eviction.
function cachePeek(query, items, hasMore){
    if (peekResultCache.has(query)) peekResultCache.delete(query)
    peekResultCache.set(query, { items: cloneItems(items), hasMore: hasMore })
    while (peekResultCache.size > resultCacheCap) peekResultCache.delete(peekResultCache.keys().next().value)
}

// The deep last-resort tier's equivalent of cachePeek, in its own map (see excludedResultCache above).
function cacheExcluded(query, items, hasMore){
    if (excludedResultCache.has(query)) excludedResultCache.delete(query)
    excludedResultCache.set(query, { items: cloneItems(items), hasMore: hasMore })
    while (excludedResultCache.size > resultCacheCap) excludedResultCache.delete(excludedResultCache.keys().next().value)
}

/** any:1 and Cockpit's own narrowing ***************************************************************************************************************
 * Joplin's `any:1` turns a query into an OR of its terms - and it does that to EVERY term in the string, not just the ones the user typed. Cockpit    *
 * builds its searches by concatenating its own narrowing onto the user's criteria (`type:todo`, `iscompleted:0`, `due:...`, the excluded-notebook     *
 * clauses), so under any:1 each of those became an ALTERNATIVE instead of a constraint. `type:todo` matches every to-do, so the whole filter          *
 * collapsed and the panel listed everything - the reported "any:1 shows notes with none of the tags".                                                  *
 *                                                                                                                                                     *
 * The fix keeps Cockpit's narrowing OUT of such a query and applies it to the results instead, so it stays a constraint whatever the user's terms do.  *
 * The user's own string is sent verbatim, so `any:1` means exactly what Joplin says it means across the terms the user wrote. `notebook:` is left in   *
 * the query on purpose: Joplin's query builder keeps notebook scope as AND even under any:1, so it is still a constraint there. The excluded-notebook  *
 * ids were always filtered client-side as the authority (filterExcluded), so dropping their query clauses costs nothing but a wider first page.        *
 *                                                                                                                                                     *
 * Detection is a whitespace-delimited any:1 token. A false positive (the text appearing inside a quoted phrase) only takes the client-side path, which *
 * returns the same rows - it is the safe direction to be wrong in.                                                                                     *
 ***************************************************************************************************************************************************/
const ANY_MODE_PATTERN = /(^|\s)any:1(\s|$)/i

export function usesAnyMode(criteria){
    return ANY_MODE_PATTERN.test(String(criteria || ""))
}

// The floor `due:19700201` encodes: a to-do with a real due date set. Mirrored here so the client-side path
// keeps the same boundary as the query it replaces.
const DUE_DATE_FLOOR = Date.UTC(1970, 1, 1)

/** applyTodoNarrowing *****************************************************************************************************************************
 * The client-side equivalent of the `type:todo` / `iscompleted:0` / `due:19700201` terms, for the any:1 path where they cannot be sent as query      *
 * terms. Same three questions, same order, asked of the returned rows instead of the index.                                                          *
 ***************************************************************************************************************************************************/
export function applyTodoNarrowing(items, showCompleted, showNoDue){
    return (items || []).filter(function(item){
        if (!item.is_todo) return false                                   // type:todo
        if (!showCompleted && item.todo_completed) return false            // iscompleted:0
        if (!showNoDue && !(item.todo_due >= DUE_DATE_FLOOR)) return false // due:19700201
        return true
    })
}

// The client-side equivalent of `type:note`: the notes format lists only regular notes.
export function applyNoteNarrowing(items){
    return (items || []).filter(function(item){ return !item.is_todo })
}

/** getTodos ****************************************************************************************************************************************
 * Returns the list of todos, sorted by due date. If show completed is true, it will include completed todos. If show no due is true, it will       *
 * include todos without due dates.                                                                                                                 *
 ***************************************************************************************************************************************************/
 export async function getTodos(showCompleted, showNoDue, searchCritera, fast?, useCache?, opts?){
    const completed = showCompleted ? "" : "iscompleted:0"
    const noDue = showNoDue ? "" : "due:19700201"
    // Excluded notebooks: append the server-side "-notebook:" clauses (an optimisation) and keep the id set
    // for the authoritative client-side filter below. Both derive from the current map, so a rename/move or a
    // newly created sub-notebook is honoured at once. The clauses are part of the query, hence part of the
    // cache key, so a cached set is never reused across an exclusion change (the setting change also clears
    // the caches outright).
    var excluded = await excludedContext()
    // Under any:1 Cockpit's own terms would become OR alternatives (see usesAnyMode); send the user's string
    // alone and narrow the results instead. Without any:1 the query is byte-identical to what it always was.
    var anyMode = usesAnyMode(searchCritera)
    var query = anyMode
        ? String(searchCritera || "")
        : `type:todo ${completed} ${noDue} ${searchCritera}${excluded.clauses ? " " + excluded.clauses : ""}`
    // The ordinary query encodes the whole view (its narrowing terms ARE the query), so it doubles as the cache
    // key. An any:1 query does not: the narrowing moved out of it, while the value cached under it is the
    // NARROWED list. Two views differing only in "show completed" would then share one entry. Unreachable today
    // (the key is per-render and the flags cannot change within one), but a cache key that does not describe
    // what it caches is a trap for the next change, so the any-mode key carries the narrowing state.
    var cacheKey = anyMode
        ? `any|c${showCompleted ? 1 : 0}|d${showNoDue ? 1 : 0}|x${excluded.clauses}|${query}`
        : query
    // fillCounts is the background pass of the fast-first-paint flow: reuse the search the fast paint
    // already cached (no new round-trip) but this time DO fetch the note bodies so the checkbox rings
    // fill in. priorityStart is the estimated first-visible row, so the bodies nearest the viewport are
    // fetched before the rest of the (body-fetch-capped) set.
    var fillCounts = !!(opts && opts.fillCounts)
    var priorityStart = (opts && opts.priorityStart) || 0
    var allTodos;
    if ((useCache || fillCounts) && todosResultCache.has(cacheKey)){
        // Optimistic / fill re-render: reuse the last search for this query instead of searching again.
        // The overlay/overrides below still layer the just-changed item on top, so the user's action shows
        // without waiting on the index.
        allTodos = cloneItems(todosResultCache.get(cacheKey))
        if (fillCounts){
            // The fast paint cached these with empty rings; fetch the bodies now (viewport first) and
            // refresh the cache so the follow-up render and any later optimistic paint show real counts.
            await attachCheckboxCounts(allTodos, false, priorityStart)
            cacheResult(todosResultCache, cacheKey, allTodos)
        }
    } else {
        allTodos = [];
        let pageNum = 1;
        do {
            countData('search')
            var response = await joplin.data.get(['search'], {
                query: query,
                // is_todo rides along so the any:1 path can apply `type:todo` itself; it costs nothing on the
                // ordinary path, where the query already guarantees it.
                fields: ['id', 'title', 'is_todo', 'todo_completed', 'todo_due', 'parent_id', 'user_updated_time', 'user_created_time'],
                type: 'note',
                order_by: 'todo_due',
                page: pageNum++,
            })
            allTodos = allTodos.concat(response.items)
        } while (response.has_more)
        // The any:1 path asked for none of Cockpit's narrowing in the query, so it is applied here - in the
        // same place, and before the same body fetch and cache write, as the query terms it replaces.
        if (anyMode) allTodos = applyTodoNarrowing(allTodos, showCompleted, showNoDue)
        // Excluded rows are dropped BEFORE the checkbox-body fetch, so an excluded note never costs a body
        // GET, and BEFORE the cache is written, so the cache holds only kept rows.
        allTodos = filterExcluded(allTodos, excluded.set)
        await attachCheckboxCounts(allTodos, fast, priorityStart)
        cacheResult(todosResultCache, cacheKey, allTodos)
    }
    // Fold in the host-held optimistic layer: created/newly-matching to-dos the index has not returned
    // yet, then the completion overrides (applied last so they also correct an overlay record). The item
    // overlay is view-scoped: opts.viewKey identifies the consuming view so only ITS own entries apply
    // (the overview-note path passes none, so it folds in no inserts/removes). The completion overrides
    // stay global - they are id-keyed user intent and correct a to-do's state in every view.
    mergeOptimisticTodos(allTodos, opts && opts.viewKey)
    applyTodoCompletionOverrides(allTodos)
    // Re-apply the id filter after the merge so an optimistic overlay entry can never surface an excluded
    // notebook's note. The id set is the authority; the server clauses above are only an optimisation on top.
    allTodos = filterExcluded(allTodos, excluded.set)
    // The search only orders by due date, which leaves to-dos sharing a due date - and the whole
    // "No Due Date" group - in arbitrary order. Ties are broken by title, so that a naming scheme
    // gives a deliberate order. The comparison is case insensitive and number aware ("2" < "10").
    allTodos.sort((first, second) => {
        return (first.todo_due - second.todo_due)
            || String(first.title).localeCompare(String(second.title), undefined, { numeric: true, sensitivity: "base" })
    })
    return allTodos
}

/** searchTitleSuggestions **************************************************************************************************************************
 * Returns the distinct note titles for the search field's title: autocomplete, up to titleSuggestionLimit. Joplin's search wildcard is suffix only   *
 * and quoting a phrase with a trailing * is unreliable, so the query matches the LAST typed word with a suffix wildcard (title:word*) and the results  *
 * are then filtered case-insensitively against the whole typed partial. An empty partial (the bare "title:" state) has nothing to match on, so it      *
 * returns the most recently updated notes/to-dos instead, mirroring how tag:/notebook: list their whole set immediately after the colon.               *
 *                                                                                                                                                     *
 * The limit is well above the ~15 rows the dropdown shows at once because that dropdown is now MULTI-select: the user marks several titles across a    *
 * scrolled list, so a cap that stopped at what fits on screen would put the rest out of reach. It costs no extra round-trip - the same single request   *
 * simply asks for a bigger page.                                                                                                                       *
 ***************************************************************************************************************************************************/
const titleSuggestionLimit = 50

export async function searchTitleSuggestions(partial){
    var typed = String(partial || "").trim()
    if (!typed) {
        // Bare "title:" with nothing typed yet: offer the most recently updated notes/to-dos so the
        // list appears immediately after the colon, the same way tag:/notebook: do. A single ['notes']
        // fetch ordered by updated_time covers both regular notes and to-dos.
        var recent = await joplin.data.get(['notes'], {
            fields: ['id', 'title', 'deleted_time'],
            order_by: 'updated_time',
            order_dir: 'DESC',
            // Over-fetch a little: trashed and untitled notes are dropped below, so the page must be able to
            // yield titleSuggestionLimit survivors.
            limit: titleSuggestionLimit * 2,
        })
        var recentTitles = []
        var recentSeen = new Set()
        for (var r of (recent.items || [])) {
            // The ['notes'] endpoint returns trashed notes too, and trashing bumps updated_time so they
            // sort to the top. Search (which both the non-empty title: path and the applied query use)
            // excludes trash, so a trashed suggestion would find nothing when selected. Skip them here.
            if (r.deleted_time && r.deleted_time > 0) continue
            var recentTitle = String(r.title || "").trim()
            if (!recentTitle) continue                  // skip untitled notes (empty-title to-dos exist and would render as blank rows)
            var recentKey = recentTitle.toLowerCase()
            if (recentSeen.has(recentKey)) continue
            recentSeen.add(recentKey)
            recentTitles.push(recentTitle)
            if (recentTitles.length >= titleSuggestionLimit) break
        }
        return recentTitles
    }
    var words = typed.split(/\s+/)
    var lastWord = words[words.length - 1]
    // Escape the wildcard characters Joplin's search treats specially so a stray * or " in the typed
    // text cannot break the query; the field-scoped title: filter matches the last word as a prefix.
    var safeLastWord = lastWord.replace(/["*]/g, "")
    if (!safeLastWord) return []
    var response = await joplin.data.get(['search'], {
        // No type: filter, so both regular notes and to-dos are matched - the panel's primary content
        // is to-dos, which type:note would exclude (type:note and type:todo are mutually exclusive).
        query: `title:${safeLastWord}*`,
        fields: ['title'],
        type: 'note',
        limit: titleSuggestionLimit,
    })
    var needle = typed.toLowerCase()
    var seen = new Set()
    var titles = []
    for (var item of (response.items || [])){
        var title = String(item.title || "")
        if (title.toLowerCase().indexOf(needle) < 0) continue
        var key = title.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        titles.push(title)
        if (titles.length >= titleSuggestionLimit) break
    }
    return titles
}

/** getNotes ****************************************************************************************************************************************
 * Returns the regular (non to-do) notes matching the given search criteria, sorted by title, each with its checkbox counts. Used when a profile     *
 * shows notes alongside the to-dos.                                                                                                                *
 ***************************************************************************************************************************************************/
export async function getNotes(searchCriteria, fast?, useCache?, opts?){
    var excluded = await excludedContext()
    // See usesAnyMode: under any:1 `type:note` would be an alternative, not a constraint.
    var anyMode = usesAnyMode(searchCriteria)
    var query = anyMode
        ? String(searchCriteria || "")
        : `type:note ${searchCriteria}${excluded.clauses ? " " + excluded.clauses : ""}`
    // Self-describing on the any-mode path, for the reason given in getTodos.
    var cacheKey = anyMode ? `any|x${excluded.clauses}|${query}` : query
    var fillCounts = !!(opts && opts.fillCounts)
    var priorityStart = (opts && opts.priorityStart) || 0
    var allNotes;
    if ((useCache || fillCounts) && notesResultCache.has(cacheKey)){
        allNotes = cloneItems(notesResultCache.get(cacheKey))
        if (fillCounts){
            await attachCheckboxCounts(allNotes, false, priorityStart)
            cacheResult(notesResultCache, cacheKey, allNotes)
        }
    } else {
        allNotes = [];
        let pageNum = 1;
        do {
            countData('search')
            var response = await joplin.data.get(['search'], {
                query: query,
                fields: ['id', 'title', 'is_todo', 'parent_id', 'user_updated_time', 'user_created_time'],
                type: 'note',
                page: pageNum++,
            })
            allNotes = allNotes.concat(response.items)
        } while (response.has_more)
        // The any:1 path applies `type:note` itself, for the same reason getTodos does.
        if (anyMode) allNotes = applyNoteNarrowing(allNotes)
        allNotes = filterExcluded(allNotes, excluded.set)
        await attachCheckboxCounts(allNotes, fast, priorityStart)
        cacheResult(notesResultCache, cacheKey, allNotes)
    }
    // A created regular note (is_todo 0) shows here before the index returns it; the overlay filters to
    // the notes list, so a created to-do never leaks into this section. View-scoped by opts.viewKey, so a
    // note created in one profile's view never surfaces in another's (the overview-note path passes none).
    mergeOptimisticNotes(allNotes, opts && opts.viewKey)
    allNotes = filterExcluded(allNotes, excluded.set)
    return allNotes.sort((first, second) => String(first.title).localeCompare(String(second.title), undefined, { numeric: true, sensitivity: "base" }))
}

/** searchOutsideFilters ****************************************************************************************************************************
 * The read-only "results outside current filters" peek. When the panel's search box has text but nothing matches inside the active profile's        *
 * filters, this runs the user's search text VERBATIM - no profile searchCriteria, no notebook:"..." narrowing, no iscompleted:/type: tokens the       *
 * plugin would otherwise add - so it finds whatever that text matches anywhere in the vault. Tokens the user typed themselves (notebook:, tag:, ...)  *
 * are kept exactly as typed, since they are passed through untouched. Both regular notes and to-dos come back: type:'note' is the item type searched   *
 * (to-dos are notes), not a query filter, and no type: token is added. is_todo is fetched too, so the caller can tell the two apart and render each in  *
 * kind. The Joplin search API already excludes trashed notes. One page only, capped at 50, with the API's has_more surfaced so the caller can show a     *
 * "+more" hint. Checkbox rings fill from cache like the main lists (skipped under fast).                                                                 *
 *                                                                                                                                                        *
 * The item overlay is deliberately NOT consulted here: no viewKey is threaded and neither mergeOptimistic* runs, so a profile-scoped optimistic insert/  *
 * remove computed for another view can never leak into this unfiltered search. Like getTodos/getNotes it reuses a query-keyed cache on the optimistic /  *
 * fill re-renders (useCache / opts.fillCounts) so the fast-paint -> fill -> optimistic sequence of one refresh costs ONE outside search, not one each; a  *
 * primary (committed) search always issues the request and refreshes the entry, so the cache never serves stale data on its own.                         *
 ***************************************************************************************************************************************************/
export async function searchOutsideFilters(searchText, fast?, useCache?, opts?){
    // Excluded notebooks are a HARDER boundary than the profile filters this peek deliberately lifts: an
    // excluded notebook's notes must never surface, not even here. So the same exclusion the list paths apply
    // is wired in - the server-side "-notebook:" clauses appended to the query (an optimisation, part of the
    // cache key), and the recursive id set as the authority the client filter enforces below. Both derive from
    // the current map, so a rename/move or a newly created sub-notebook is honoured at once, and the setting
    // change clears the peek cache (invalidateResultCaches), so a pre-exclusion result is never reused.
    var excluded = await excludedContext()
    var query = String(searchText || "") + (excluded.clauses ? " " + excluded.clauses : "")
    var fillCounts = !!(opts && opts.fillCounts)
    var priorityStart = (opts && opts.priorityStart) || 0
    var items
    var hasMore
    if ((useCache || fillCounts) && peekResultCache.has(query)){
        // Optimistic / fill re-render: reuse the unfiltered search already run for this text this refresh. The
        // cached entry already holds only kept rows (the primary search below filtered before caching), and no
        // optimistic overlay runs here to reintroduce one, so no re-filter is needed on this lane.
        var cached = peekResultCache.get(query)
        items = cloneItems(cached.items)
        hasMore = cached.hasMore
        if (fillCounts){
            // The fast paint cached these with empty rings; fetch the bodies now and refresh the entry so the
            // follow-up render (and any later optimistic paint) shows the real counts.
            await attachCheckboxCounts(items, false, priorityStart)
            cachePeek(query, items, hasMore)
        }
    } else {
        var response = await joplin.data.get(['search'], {
            query: query,
            fields: ['id', 'title', 'is_todo', 'todo_completed', 'parent_id', 'user_updated_time'],
            type: 'note',
            limit: 50,
            page: 1,
        })
        items = response.items || []
        hasMore = !!response.has_more
        // Drop excluded rows BEFORE the checkbox-body fetch (so an excluded note never costs a body GET) and
        // BEFORE the cache write (so the cache holds only kept rows). This is the authority - the server clauses
        // above are only an optimisation - and because both the rendered rows and the peek's header/footer
        // counts are computed from this returned set, every count reflects the filtered result too.
        items = filterExcluded(items, excluded.set)
        await attachCheckboxCounts(items, fast, priorityStart)
        cachePeek(query, items, hasMore)
    }
    return { items: items, hasMore: hasMore }
}

/** searchExcludedNotebooks *************************************************************************************************************************
 * The deep, last-resort tier below the peek. It runs the user's search text VERBATIM with NEITHER the exclusion boundary the peek applies: no server-  *
 * side "-notebook:" clauses AND no client-side id filter - so it reaches into the excluded notebooks the peek deliberately skips. It exists only to     *
 * answer explicit name-hunting ("where is my note called X?") when everything else came up empty, so the caller runs it in ONE narrow cascade only:     *
 * committed search text -> zero in-filter rows -> zero peek rows (searchOutsideFilters, exclusions respected). Because that peek came out empty, no KEPT *
 * notebook's note matched the text (the peek's clauses/filter only ever drop excluded content), so every hit this returns necessarily lives in an       *
 * excluded notebook - which is what lets the caller head the section "Results in excluded notebooks" without re-filtering.                              *
 *                                                                                                                                                       *
 * Like searchOutsideFilters this is a pure read that consults no optimistic overlay, fetches one page capped at 50 with has_more surfaced for the        *
 * "+more" footer, fills checkbox rings from cache (skipped under fast), and reuses a query-keyed cache (its own map, cleared alongside the others by     *
 * invalidateResultCaches) on the optimistic / fill re-renders so the fast-paint -> fill -> optimistic sequence of one refresh costs ONE deep search.     *
 ***************************************************************************************************************************************************/
export async function searchExcludedNotebooks(searchText, fast?, useCache?, opts?){
    // When nothing is excluded, the ordinary peek already searched the WHOLE vault (no clauses, no client
    // filter), so its coming out empty means there is genuinely nothing to find and this tier would only re-run
    // the identical search. Short-circuit to empty so the cascade's one extra search is spent ONLY when an
    // exclusion is actually hiding something. A pure setting read, and no cache entry is written (there is no
    // result to cache), so a later exclusion being switched on is honoured at once.
    var excludedIds = parseExcludedIds(await joplin.settings.value(EXCLUDED_NOTEBOOK_IDS_KEY))
    if (!excludedIds.length) return { items: [], hasMore: false }
    // Verbatim text, no exclusion clauses - the whole point is to see past the exclusion the peek honours.
    var query = String(searchText || "")
    var fillCounts = !!(opts && opts.fillCounts)
    var priorityStart = (opts && opts.priorityStart) || 0
    var items
    var hasMore
    if ((useCache || fillCounts) && excludedResultCache.has(query)){
        // Optimistic / fill re-render: reuse the deep search already run for this text this refresh.
        var cached = excludedResultCache.get(query)
        items = cloneItems(cached.items)
        hasMore = cached.hasMore
        if (fillCounts){
            await attachCheckboxCounts(items, false, priorityStart)
            cacheExcluded(query, items, hasMore)
        }
    } else {
        var response = await joplin.data.get(['search'], {
            query: query,
            fields: ['id', 'title', 'is_todo', 'todo_completed', 'parent_id', 'user_updated_time'],
            type: 'note',
            limit: 50,
            page: 1,
        })
        items = response.items || []
        hasMore = !!response.has_more
        // No filterExcluded here (unlike the peek): the excluded rows are exactly what this tier exists to surface.
        await attachCheckboxCounts(items, fast, priorityStart)
        cacheExcluded(query, items, hasMore)
    }
    return { items: items, hasMore: hasMore }
}

/** attachCheckboxCounts ****************************************************************************************************************************
 * Fills in checkboxDone/checkboxTotal for each item. The counts need the note bodies, which are by far the heaviest thing to transfer, so they are  *
 * cached per note and a body is only re-fetched when the note's updated time has changed. A refresh therefore usually fetches no bodies at all.     *
 * On a cold start over a large set, at most maxBodyFetchesPerRefresh bodies are fetched per refresh and the rest fill in on following refreshes,    *
 * so the panel appears quickly instead of stalling.                                                                                                 *
 *                                                                                                                                                  *
 * fast (mobile first-paint after a profile switch/create): skip the body fetches entirely and render each row from whatever is already cached (an    *
 * uncached row shows an empty ring). The ring is display-only, so a momentarily-empty ring is harmless, and this keeps the interactive switch off    *
 * the up-to-300 serial bridge round-trips a fresh result set would otherwise need. It writes NOTHING to the cache, so the per-note stamp invariant    *
 * (a cache entry always matches the body it was computed from) is preserved and the follow-up background refresh fetches the still-stale rows.        *
 ***************************************************************************************************************************************************/
var checkboxCounts = new Map()
const bodyFetchChunk = 20
const maxBodyFetchesPerRefresh = 300

/** viewportRank ************************************************************************************************************************************
 * Orders a row for the background body-fetch pass by its distance from the viewport: rows at or below the estimated first-visible row rank first     *
 * (nearest first), then the rows above it (nearest-above next). So when the per-refresh cap truncates a large set, the on-screen rings fill before    *
 * the off-screen ones, which fill on the following refreshes.                                                                                        *
 ***************************************************************************************************************************************************/
function viewportRank(idx, start, total){
    return idx >= start ? idx - start : total + (start - idx)
}

async function attachCheckboxCounts(items, fast?, priorityStart?){
    if (!fast){
        // Collect the rows whose body needs (re)fetching, keeping each row's position in the rendered
        // list so the fetch order can be biased toward the viewport.
        var staleEntries = []
        items.forEach((item, idx) => {
            var cached = checkboxCounts.get(item.id)
            if (!cached || cached.stamp !== item.user_updated_time) staleEntries.push({ item: item, idx: idx })
        })
        // Viewport-first: when the caller passed the estimated first-visible row (from the host-held
        // scroll position), fetch the rows at/after it before the rows above it, so what the user is
        // looking at fills its rings first when the per-refresh body-fetch cap truncates a large set.
        if (priorityStart && priorityStart > 0 && staleEntries.length){
            var total = items.length
            staleEntries.sort((first, second) => viewportRank(first.idx, priorityStart, total) - viewportRank(second.idx, priorityStart, total))
        }
        var stale = staleEntries.slice(0, maxBodyFetchesPerRefresh).map(entry => entry.item)
        for (var index = 0; index < stale.length; index += bodyFetchChunk){
            await Promise.all(stale.slice(index, index + bodyFetchChunk).map(async item => {
                try {
                    countData('bodies')
                    var note = await joplin.data.get(['notes', item.id], { fields: ['body'] })
                    var counts = countCheckboxes(note.body)
                    checkboxCounts.set(item.id, { stamp: item.user_updated_time, done: counts.done, total: counts.total })
                } catch (error) {
                    checkboxCounts.set(item.id, { stamp: item.user_updated_time, done: 0, total: 0 })
                }
            }))
        }
    }
    for (var item of items){
        var counts = checkboxCounts.get(item.id)
        item.checkboxDone = counts ? counts.done : 0
        item.checkboxTotal = counts ? counts.total : 0
    }
}

/** countCheckboxes *********************************************************************************************************************************
 * Counts the markdown checkboxes ("- [ ]" and "- [x]") in the given note body. The patterns are the same ones Joplin's own note list uses for its   *
 * checkbox completion chart, so the two always agree.                                                                                              *
 ***************************************************************************************************************************************************/
function countCheckboxes(body){
    var text = String(body || "")
    var unchecked = (text.match(/(^|\n)[ \t>]*- \[ \]/g) || []).length
    var checked = (text.match(/(^|\n)[ \t>]*- \[[xX]\]/g) || []).length
    return { done: checked, total: checked + unchecked }
}

/** getNotebookMap ***********************************************************************************************************************************
 * Returns a Map of notebook ID to { id, title, path }, where path is the notebook's full "Parent / Child" breadcrumb. Used to show which notebook    *
 * a to-do lives in and to build the notebook filter.                                                                                                *
 ***************************************************************************************************************************************************/
var notebookMapCache = { stamp: 0, map: null }
const notebookMapTTL = 20000

/** invalidateNotebookMap ***************************************************************************************************************************
 * Drops the cached notebook map. Called after the panel itself creates, renames, moves or deletes a notebook, so the change shows immediately       *
 * rather than when the cache expires.                                                                                                              *
 ***************************************************************************************************************************************************/
export function invalidateNotebookMap(){
    notebookMapCache = { stamp: 0, map: null }
}

export async function getNotebookMap(){
    if (notebookMapCache.map && Date.now() - notebookMapCache.stamp < notebookMapTTL) return notebookMapCache.map
    var folders = new Map()
    let pageNum = 1;
    do {
        var response = await joplin.data.get(['folders'], {
            fields: ['id', 'title', 'parent_id'],
            page: pageNum++,
        })
        for (var folder of response.items) folders.set(folder.id, folder)
    } while (response.has_more)
    var notebooks = new Map()
    for (var [id, folder] of folders){
        var titles = [folder.title]
        var parent = folders.get(folder.parent_id)
        // The guard stops a corrupted parent chain from looping forever
        var guard = 0
        while (parent && guard++ < 32){
            titles.unshift(parent.title)
            parent = folders.get(parent.parent_id)
        }
        notebooks.set(id, { id: id, title: folder.title, path: titles.join(" / "), parentID: folder.parent_id || "" })
    }
    notebookMapCache = { stamp: Date.now(), map: notebooks }
    return notebooks
}

/** getAllTags **************************************************************************************************************************************
 * Returns every tag as { id, title }, for the search field's tag: autocomplete. Paginated and TTL-cached the same way as the notebook map, so the    *
 * whole list is fetched at most once every few seconds no matter how often the panel re-renders. Joplin stores tag titles lowercased.               *
 ***************************************************************************************************************************************************/
var tagsCache = { stamp: 0, list: null }
const tagsTTL = 20000

/** invalidateTagsCache *****************************************************************************************************************************
 * Drops the cached tag list. Called after the panel itself creates a tag (the mobile setTags fallback) so the new tag shows in the search field's    *
 * tag: autocomplete immediately rather than when the cache expires.                                                                                 *
 ***************************************************************************************************************************************************/
export function invalidateTagsCache(){
    tagsCache = { stamp: 0, list: null }
}

export async function getAllTags(){
    if (tagsCache.list && Date.now() - tagsCache.stamp < tagsTTL) return tagsCache.list
    var tags = []
    let pageNum = 1;
    do {
        var response = await joplin.data.get(['tags'], {
            fields: ['id', 'title'],
            page: pageNum++,
        })
        tags = tags.concat(response.items)
    } while (response.has_more)
    tagsCache = { stamp: Date.now(), list: tags }
    return tags
}

/** notebookWithDescendants *************************************************************************************************************************
 * The IDs of the given notebook and every notebook nested under it, so that filtering to a notebook includes its sub-notebooks                     *
 ***************************************************************************************************************************************************/
export function notebookWithDescendants(notebooks, folderID){
    var ids = new Set([folderID])
    // Notebooks point at their parents, so sweep until no new descendants turn up
    var addedNew = true
    while (addedNew){
        addedNew = false
        for (var notebook of notebooks.values()){
            if (!ids.has(notebook.id) && ids.has(notebook.parentID)){
                ids.add(notebook.id)
                addedNew = true
            }
        }
    }
    return ids
}

/** getTodoDues *************************************************************************************************************************************
 * The current due timestamp of each given to-do as { id, due } (due 0 when it has no alarm). The multi-select alarm plan needs every selected      *
 * to-do's own current due, fetched fresh at OK time, to shift each from its own schedule.                                                          *
 ***************************************************************************************************************************************************/
export async function getTodoDues(todoIDs){
    var result = []
    for (var todoID of todoIDs){
        countData('get')
        var note = await joplin.data.get(['notes', todoID], { fields: ['todo_due'] })
        result.push({ id: todoID, due: note.todo_due && note.todo_due > 0 ? note.todo_due : 0 })
    }
    return result
}

/** setTodoDuesPerId ********************************************************************************************************************************
 * Writes a computed per-to-do due timestamp: applies [{ id, due }] entries, one PUT each (due 0 clears the alarm). This is how the multi-select     *
 * alarm plan lands its result, where different to-dos receive different due times.                                                                 *
 ***************************************************************************************************************************************************/
export async function setTodoDuesPerId(entries){
    for (var entry of entries){
        countData('put')
        await joplin.data.put(['notes', entry.id], null, { todo_due: entry.due })
    }
}

/** setTodoDueDates *********************************************************************************************************************************
 * Sets the due date of each given to-do to the given local YYYY-MM-DD date, or removes the due date when the date is null. A to-do that already     *
 * had a due time keeps its time of day on the new date; one that had none becomes due at the given day start time.                                  *
 ***************************************************************************************************************************************************/
export async function setTodoDueDates(todoIDs, dateISO, dayStart){
    var parts = dateISO ? String(dateISO).split("-").map(Number) : null
    for (var todoID of todoIDs){
        var dueTimestamp = 0
        if (parts && parts.length === 3 && parts.every(part => Number.isFinite(part))){
            var target = new Date(parts[0], parts[1] - 1, parts[2])
            countData('get')
            var note = await joplin.data.get(['notes', todoID], { fields: ['todo_due'] })
            if (note.todo_due && note.todo_due > 0){
                var previous = new Date(note.todo_due)
                target.setHours(previous.getHours(), previous.getMinutes(), 0, 0)
            } else {
                target.setHours(dayStart.hours, dayStart.minutes, 0, 0)
            }
            dueTimestamp = target.getTime()
        }
        countData('put')
        await joplin.data.put(['notes', todoID], null, { todo_due: dueTimestamp })
    }
}

/** openTodo ****************************************************************************************************************************************
 * Opens the todo with the given todo ID                                                                                                            *
 ***************************************************************************************************************************************************/
export async function openTodo(todoID){
    await joplin.commands.execute('openNote', todoID);
}

/** focusNewItemEditor ******************************************************************************************************************************
 * After Cockpit creates and opens a fresh note/to-do, put the cursor where Joplin's own "When creating a new note/to-do" setting says. A note      *
 * created through the data API is not provisional, so Joplin's own auto-focus (useFormNote's handleAutoFocus, which only runs for provisional       *
 * notes) never fires for it - which is exactly why the panel has to honour the setting itself. Joplin keeps two separate desktop-only settings,     *
 * newTodoFocus (default "title") and newNoteFocus (default "body"), each valued "title" or "body"; its editor focuses the title on "title" and the  *
 * body otherwise. This mirrors that: "title" runs focusElementNoteTitle, "body" runs focusElementNoteBody, and any other value (a hypothetical      *
 * "none") leaves the focus wherever the app placed it. Both the setting and the two focus commands are desktop-only, so on mobile the globalValue    *
 * read throws (guarded) and, even if a value came through, the command execute throws (guarded) - a silent no-op there, never a message box.        *
 ***************************************************************************************************************************************************/
export async function focusNewItemEditor(isTodo){
    var settingKey = isTodo ? 'newTodoFocus' : 'newNoteFocus'
    var focusValue
    try {
        focusValue = await joplin.settings.globalValue(settingKey)
    } catch (error) {
        // The setting is registered on desktop only; on mobile (or any app without it) there is nothing to honour.
        return
    }
    var command = focusValue === 'title' ? 'focusElementNoteTitle'
        : focusValue === 'body' ? 'focusElementNoteBody'
        : null
    // Anything that is neither "title" nor "body" (e.g. a future "none") means "do not move the focus", so leave it be.
    if (!command) return
    try {
        await joplin.commands.execute(command)
    } catch (error) {
        // The focus commands exist on desktop only; on mobile this is a guarded no-op rather than a "not available here" box.
        console.warn(`Cockpit: could not focus the new note (${command})`, error)
    }
}

/** getNoteContent **********************************************************************************************************************************
 * Gets the body of the note with the given noteID                                                                                                  *
 ***************************************************************************************************************************************************/
export async function getNoteContent(noteID){
    countData('get')
    return await joplin.data.get(['notes', noteID], { fields: ['id', 'title', 'body']})
}

/** setNoteContent **********************************************************************************************************************************
 * Sets the body of the note with the given noteID to the given note body                                                                           *
 ***************************************************************************************************************************************************/
export async function setNoteContent(noteID, noteBody){
    countData('put')
    await joplin.data.put(['notes', noteID], null, { body: noteBody})
}

/** setTodoCompleted ********************************************************************************************************************************
 * Sets a to-do's completion to the given value with a single idempotent PUT: a millisecond timestamp when completed (Joplin's documented shape),     *
 * 0 when not. The caller already knows the state the user set (the checkbox posts it), so there is no read-modify-write - the old pre-GET both cost    *
 * a round-trip on every tick and wrote a boolean where a timestamp belongs. Being idempotent, a rapid double-tick is safe: the last call wins.        *
 ***************************************************************************************************************************************************/
export async function setTodoCompleted(todoID, completed){
    countData('put')
    await joplin.data.put(['notes', todoID], null, { todo_completed: completed });
}
