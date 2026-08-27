/** README ******************************************************************************************************************************************
 * The host-held optimistic layer. Cockpit's interactive actions (ticking a to-do, creating a note, an external note change) take effect in the      *
 * search index only after Joplin's own indexing timer has caught up - seconds later, and how many varies. Until then a search-based render would     *
 * show the pre-action state and flicker the user's change away. This module holds the user's intended state on the plugin side and the render paths   *
 * consult it, so any render from any trigger shows that state until a real search agrees with it (or a generous timeout retires it as a leak guard).  *
 *                                                                                                                                                    *
 * Being host-held it works on mobile automatically: there every setHtml is a full webview reload that destroys webview module state, so an optimistic *
 * layer kept in the webview could not survive even one render, whereas this one does. Kept import-free (like syncStatus.ts) so the low-level data     *
 * layer (joplin.ts) and the panel can both use it without importing each other.                                                                       *
 *                                                                                                                                                    *
 * Two independent concerns live here:                                                                                                                *
 *  - completion overrides: a to-do's todo_completed the user just set by ticking it. Applied LAST in getTodos, so it also corrects a stale record     *
 *    that arrived through the item overlay below.                                                                                                     *
 *  - the item overlay: whole records that should be inserted into (created / newly-matching) or suppressed from (trashed / moved-away) the current     *
 *    result set before the search index reflects them. UNLIKE the completion overrides, an item-overlay entry is computed against ONE view (a           *
 *    profile's visibility switches + the active notebook filter, via noteMatchesView at upsert time), so it is VIEW-SCOPED: every entry carries the      *
 *    viewKey it was evaluated for, and a merge applies an entry ONLY when the consuming query is that same view. This is what stops an insert/remove     *
 *    computed for profile A from leaking into profile B's panel or into another profile's overview note (the overview path consumes no item overlay at   *
 *    all - it passes a null viewKey - since overviews are eventually consistent via the reconcile/overview lanes and the periodic backstop).             *
 *                                                                                                                                                    *
 * An item-overlay entry asserts the id's CURRENT TYPE for its view, not merely its membership of one list: the panel renders the to-dos and the notes  *
 * from two SEPARATE searches of the same index, so while that index lags a type flip both of them can carry the id at once. An entry therefore inserts *
 * into the list of the type it holds AND suppresses the id from the other one, which is what keeps a flipped item from rendering twice (once in a       *
 * to-do section, once under NOTES). Because the two lists are merged one after the other, a suppress cannot be retired by either merge alone; the       *
 * render closes its overlay cycle with finalizeOverlay, which retires it once both lists agree.                                                         *
 ***************************************************************************************************************************************************/

/** overrideTTL *************************************************************************************************************************************
 * How long an optimistic entry is honoured before it is retired even if no search has agreed with it. Reconciliation (a search that returns the      *
 * item's real state) normally retires an entry sooner; this is only the leak guard for the case where the item drops out of the result set entirely  *
 * (e.g. completing a to-do in a profile that hides completed ones), where no later search can carry it to reconcile against.                          *
 ***************************************************************************************************************************************************/
const overrideTTL = 60000

/** completionOverrides *****************************************************************************************************************************
 * noteID -> { todo_completed, appliedAt }. todo_completed is the millisecond timestamp the user's tick set (0 = not completed).                       *
 ***************************************************************************************************************************************************/
var completionOverrides = new Map()

/** itemOverlay *************************************************************************************************************************************
 * noteID -> { record, isTodo, viewKey, appliedAt, removed, viewMiss, seenTodo, seenNote }. A non-removed entry carries a full item record to           *
 * insert; a removed one suppresses the id from results, and carries a record (marked viewMiss) only when it was written because the item fell          *
 * outside the VIEW rather than because the item is gone - see removeOptimisticItem. isTodo is the id's type as the entry asserts it: it names the      *
 * list the entry inserts into (or the list a suppress belongs to), while the OTHER list is suppressed either way, since the index may still be         *
 * serving the id under its pre-flip type. It is undefined only when the type is unknown (a hard delete), in which case the entry suppresses from       *
 * either list and is retired only by the timeout. viewKey is the view the entry was computed against (see viewKeyFor); a merge applies the entry       *
 * only to a query for that same view, so an overlay computed for one profile/notebook-filter never leaks into another's results. seenTodo and          *
 * seenNote are the current render's per-list verdicts ("present" / "absent"), written by each merge and consumed - then cleared - by finalizeOverlay.  *
 ***************************************************************************************************************************************************/
var itemOverlay = new Map()

/** viewKeyFor **************************************************************************************************************************************
 * A stable key for the view an item-overlay entry belongs to. Item-overlay entries are only ever created for LOCALLY-EVALUABLE views (no profile      *
 * search criteria and no typed search text - see panel.ts isLocallyEvaluableView), so a view's membership is fully determined by the profile (its      *
 * visibility switches) and the active notebook filter; those two therefore make the key. A space cannot appear in a numeric profile id or a 32-hex     *
 * notebook id, so it is a collision-proof separator. The consuming query (fetchTodos / renderNotesSection) computes the same key and passes it to the   *
 * merge; the overview-note path passes null so it consumes no item overlay.                                                                             *
 ***************************************************************************************************************************************************/
export function viewKeyFor(profileID, notebookFilter){
    return String(profileID) + " " + String(notebookFilter || "")
}

/** hasPendingOptimistic ****************************************************************************************************************************
 * Whether any optimistic entry (a completion override or an item-overlay insert/suppress) is still being held. The reconciliation lane uses this as    *
 * its early-stop signal: when a mutation left something optimistic and a later search has since retired every such entry (the index caught up with the  *
 * user's own action), there is nothing left to poll for, so the remaining reconciliation offsets are cancelled. Expired entries are swept first so a    *
 * leaked entry past its TTL does not keep the lane alive.                                                                                               *
 ***************************************************************************************************************************************************/
export function hasPendingOptimistic(){
    sweepExpired(completionOverrides)
    sweepExpired(itemOverlay)
    return completionOverrides.size > 0 || itemOverlay.size > 0
}

/** hasPendingItemOverlay ****************************************************************************************************************************
 * Whether any item-overlay entry (an insert or a suppress) is currently held. The panel render path uses it as a cheap gate before re-validating the *
 * inserts against the current view (revalidateOptimisticInserts): a render with nothing overlaid - the overwhelming majority - pays only this size    *
 * check and does no extra work. Distinct from hasPendingOptimistic: it neither sweeps nor considers the completion overrides, it is purely "is there  *
 * an item overlay a render must re-check".                                                                                                            *
 ***************************************************************************************************************************************************/
export function hasPendingItemOverlay(){
    return itemOverlay.size > 0
}

/** sweepExpired ************************************************************************************************************************************/
function sweepExpired(map){
    var now = Date.now()
    for (var entry of map){
        if (now - entry[1].appliedAt > overrideTTL) map.delete(entry[0])
    }
}

/** setTodoCompletionOverride ***********************************************************************************************************************
 * Records the completion state the user just set, so every render shows it until a search agrees. Called on the tick, before the PUT is confirmed.    *
 ***************************************************************************************************************************************************/
export function setTodoCompletionOverride(noteID, todoCompleted){
    if (!noteID) return
    completionOverrides.set(noteID, { todo_completed: todoCompleted, appliedAt: Date.now() })
}

/** clearTodoCompletionOverride *********************************************************************************************************************
 * Drops the override for a to-do. Called when the PUT fails (visual rollback) so the panel falls back to the real, unchanged state.                   *
 ***************************************************************************************************************************************************/
export function clearTodoCompletionOverride(noteID){
    completionOverrides.delete(noteID)
}

/** applyTodoCompletionOverrides ********************************************************************************************************************
 * Corrects each item's todo_completed to the user's set value, and retires an override once the search result already agrees with it (compared as a   *
 * boolean, since the stored completion timestamp is not the exact one we wrote). Applied LAST in getTodos, so it also wins over a stale record that    *
 * came in through the item overlay.                                                                                                                  *
 ***************************************************************************************************************************************************/
export function applyTodoCompletionOverrides(items){
    if (!completionOverrides.size) return items
    sweepExpired(completionOverrides)
    for (var item of items){
        var override = completionOverrides.get(item.id)
        if (!override) continue
        if (!!item.todo_completed === !!override.todo_completed){
            // The search index has caught up with the tick; let the real value stand from now on.
            completionOverrides.delete(item.id)
            continue
        }
        item.todo_completed = override.todo_completed
    }
    return items
}

/** upsertOptimisticItem ****************************************************************************************************************************
 * Inserts (or refreshes) a whole record in the overlay so it appears in the current view before the search index returns it. The caller has already   *
 * checked the record satisfies the active view's locally-evaluable constraints, and passes the viewKey that view was evaluated for so the entry is     *
 * only ever merged back into that same view (never another profile's panel or overview note).                                                          *
 ***************************************************************************************************************************************************/
export function upsertOptimisticItem(record, viewKey){
    if (!record || !record.id) return
    itemOverlay.set(record.id, { record: { ...record }, isTodo: !!record.is_todo, viewKey: viewKey, appliedAt: Date.now(), removed: false })
}

/** removeOptimisticItem ****************************************************************************************************************************
 * Suppresses an id from the current view before the search index stops returning it (a trashed note, one moved out of the filtered notebook, or one    *
 * whose type flipped into a section this view hides). isTodo is the id's type NOW, so reconciliation can retire the entry once its own list no longer  *
 * returns it; the suppression itself covers both lists, since the lagging index may still be serving the id under its previous type. Pass it undefined *
 * only when the type is unknown (a hard delete), in which case the entry is retired by the timeout. viewKey scopes the suppression to the view it was  *
 * computed for, so a remove computed for one profile never hides an item from a query that legitimately returns it under a different view.             *
 *                                                                                                                                                    *
 * record is passed ONLY when the reason for the suppression is that the item does not belong to this VIEW (its type, due date or completion falls      *
 * outside the profile's switches, or its notebook outside the filter) - never when the item is gone (trashed, hard-deleted). That distinction matters  *
 * because only the first kind can be re-judged: the caller's noteMatchesView cannot see a trash flag, so re-judging a trash suppress would resurrect    *
 * the row. A judgeable suppress is marked viewMiss so revalidateOptimisticInserts can take it back once the view would show the item again.            *
 ***************************************************************************************************************************************************/
export function removeOptimisticItem(noteID, isTodo?, viewKey?, record?){
    if (!noteID) return
    itemOverlay.set(noteID, {
        record: record ? { ...record, id: noteID } : { id: noteID },
        isTodo: (isTodo === undefined ? undefined : !!isTodo),
        viewKey: viewKey, appliedAt: Date.now(), removed: true, viewMiss: !!record,
    })
}

/** clearOptimisticItem *****************************************************************************************************************************
 * Drops any overlay entry for an id (insert or suppress). Used when the view can no longer be evaluated locally, so search becomes the sole authority. *
 ***************************************************************************************************************************************************/
export function clearOptimisticItem(noteID){
    itemOverlay.delete(noteID)
}

/** revalidateOptimisticInserts *********************************************************************************************************************
 * Drops any INSERT overlay entry for the given view whose stored record no longer belongs to it, judged by the caller's predicate (noteMatchesView   *
 * bound to the CURRENT profile). An entry is scoped by viewKey (profileID + notebookFilter) - which does NOT capture the profile's visibility        *
 * switches - so EDITING a switch (turning off showNoDue, a completed bucket, showNotes) leaves the viewKey unchanged and a now-hidden item's insert   *
 * still matching it, while the item no longer belongs. The item's own search can never retire that entry (the server filter it was hidden by -        *
 * due:19700201 / iscompleted:0 - keeps excluding it), so without this it would survive on the TTL alone and leak into the edited view (the CI-caught  *
 * "undated to-do in a hide-undated profile" regression). Re-running the predicate here, at consumption time, retires exactly those stale inserts,     *
 * while a still-matching entry is kept so a profile that still shows the item goes on showing it promptly (no over-fix). A predicate of () => false    *
 * (passed when the view is no longer locally evaluable - the profile gained searchCriteria, or the user typed search text) drops every insert, making *
 * the search the sole authority. Only entries of the given view are considered, so one view's re-validation never disturbs another's overlay.          *
 *                                                                                                                                                    *
 * The mirror case is a viewMiss SUPPRESS - one written because the item fell outside the view's switches (a flip into a hidden type, most of all).      *
 * Editing the switch back ON leaves the viewKey unchanged, so without this the suppression would go on hiding the item from BOTH lists while its own    *
 * search legitimately returns it (so no verdict can ever retire it) - the item would stay invisible until the TTL, hidden by the very switch the user   *
 * turned on to see it. Such an entry is therefore DROPPED the moment the predicate says the item belongs to the view again, handing it back to the      *
 * search that is now returning it. Dropped rather than turned into an insert: an insert asserts the item exists, and this record was captured earlier   *
 * - if the item has since been trashed, no search could ever retire that insert (search never returns trashed notes) and it would pin a trashed row     *
 * for the whole TTL. A suppress carrying no judgeable record (trashed, moved away, hard-deleted) is left untouched either way, because the predicate     *
 * cannot see the reason it was written for.                                                                                                            *
 ***************************************************************************************************************************************************/
export function revalidateOptimisticInserts(viewKey, matches){
    if (!itemOverlay.size) return
    for (var pair of itemOverlay){
        var entry = pair[1]
        if (entry.viewKey !== viewKey) continue      // only this view's entries
        if (entry.removed){
            if (entry.viewMiss && matches(entry.record)) itemOverlay.delete(pair[0])   // the view shows it again; search rules
            continue
        }
        if (!matches(entry.record)) itemOverlay.delete(pair[0])
    }
}

/** mergeOverlay ************************************************************************************************************************************
 * Folds the overlay for one list (to-dos when wantTodo is true, notes otherwise) into a freshly fetched (or cached) result array, in place, applying   *
 * ONLY the entries that belong to the consuming view (entry.viewKey === viewKey):                                                                      *
 *  - an insert of THIS list's type whose id the search already returns is retired, and the real item kept (search caught up)                           *
 *  - an insert of THIS list's type whose id the search does not return yet is appended                                                                 *
 *  - an insert of the OTHER type whose id this list's (lagging) search still returns is spliced out of it, so an id whose type just flipped renders in  *
 *    exactly one section instead of both                                                                                                               *
 *  - a suppress whose id the search still returns is spliced out - of EITHER list, for the same reason: while the index lags, the id may still be       *
 *    served under its pre-flip type                                                                                                                    *
 * Retiring a suppress needs both lists' verdicts, so no merge retires one: each records its own verdict on the entry and finalizeOverlay closes the     *
 * cycle. An insert still retires against its OWN list here, where the search returning it is proof enough on its own.                                   *
 * A null viewKey (the overview-note path) consumes NOTHING - overviews are eventually consistent via the lanes and the periodic backstop. Because an   *
 * entry is only ever touched by its own view, a suppress never hides an item another view legitimately returns, and an entry retires against its own   *
 * view's search alone (never a foreign one), with the TTL as the sole backstop for a view whose search can no longer carry the item.                   *
 ***************************************************************************************************************************************************/
function mergeOverlay(items, wantTodo, viewKey){
    if (!itemOverlay.size) return items
    sweepExpired(itemOverlay)
    if (viewKey == null) return items
    var present = new Map()
    for (var item of items) present.set(item.id, item)
    for (var pair of itemOverlay){
        var id = pair[0]
        var entry = pair[1]
        // View scope: an entry only ever applies to (and retires against) the exact view it was computed for.
        if (entry.viewKey !== viewKey) continue
        var hit = present.get(id)
        if (entry.removed){
            if (hit) spliceOut(items, present, id, hit)
            // This list's verdict for finalizeOverlay: the suppress may only retire once NEITHER list returns it.
            if (wantTodo) entry.seenTodo = hit ? "present" : "absent"
            else entry.seenNote = hit ? "present" : "absent"
            continue
        }
        if (entry.isTodo !== wantTodo){
            // The entry asserts the id is of the other type, so a row this list's search still carries is stale.
            if (hit) spliceOut(items, present, id, hit)
            continue
        }
        if (hit){
            itemOverlay.delete(id)              // the search now returns the created/changed item; keep the real one
        } else {
            items.push({ ...entry.record })
        }
    }
    return items
}

/** spliceOut ***************************************************************************************************************************************/
function spliceOut(items, present, id, hit){
    var at = items.indexOf(hit)
    if (at >= 0) items.splice(at, 1)
    present.delete(id)
}

/** finalizeOverlay *********************************************************************************************************************************
 * Closes one render's overlay cycle for a view, once BOTH of its lists have been merged. A suppress asserts the id is gone from the whole view, and a  *
 * single merge can only ever see half of it: the to-dos are merged before the notes, so retiring inside a merge would either destroy the entry before  *
 * the second list could be corrected (the id's stale row would then be unremovable) or keep it past the point the index caught up. So each merge only   *
 * records its verdict and this retires the entry when neither list returns the id any more - and only for a suppress of KNOWN type, an unknown-type     *
 * one (a hard delete) staying on the TTL exactly as before. notesRendered is false when the profile shows no notes section: that list is then never     *
 * merged and nothing can render the id from it, so its verdict counts as "absent" and the entry still retires promptly instead of leaking to the TTL.   *
 ***************************************************************************************************************************************************/
export function finalizeOverlay(viewKey, notesRendered?){
    if (!itemOverlay.size || viewKey == null) return
    for (var pair of itemOverlay){
        var entry = pair[1]
        if (entry.viewKey !== viewKey) continue
        if (entry.removed && entry.isTodo !== undefined){
            var noteAbsent = notesRendered === false || entry.seenNote === "absent"
            if (entry.seenTodo === "absent" && noteAbsent){
                itemOverlay.delete(pair[0])     // neither list returns it any more; done
                continue
            }
        }
        entry.seenTodo = undefined
        entry.seenNote = undefined
    }
}

/** mergeOptimisticTodos / mergeOptimisticNotes *************************************************************************************************
 * viewKey identifies the consuming view: a panel query passes the current view's key so it sees only its own overlay entries; the overview-note path   *
 * passes null (or omits it) so it consumes no item overlay.                                                                                            *
 ***************************************************************************************************************************************************/
export function mergeOptimisticTodos(items, viewKey?){
    return mergeOverlay(items, true, viewKey)
}
export function mergeOptimisticNotes(items, viewKey?){
    return mergeOverlay(items, false, viewKey)
}
