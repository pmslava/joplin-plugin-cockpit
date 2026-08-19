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
 *    result set before the search index reflects them.                                                                                               *
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
 * noteID -> { record, isTodo, appliedAt, removed }. A non-removed entry carries a full item record to insert; a removed entry suppresses the id from  *
 * results (its isTodo says which list it belongs to, or is undefined when unknown - e.g. a hard delete - in which case it is suppressed from either   *
 * list and retired only by the timeout).                                                                                                            *
 ***************************************************************************************************************************************************/
var itemOverlay = new Map()

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
 * checked the record satisfies the active view's locally-evaluable constraints.                                                                       *
 ***************************************************************************************************************************************************/
export function upsertOptimisticItem(record){
    if (!record || !record.id) return
    itemOverlay.set(record.id, { record: { ...record }, isTodo: !!record.is_todo, appliedAt: Date.now(), removed: false })
}

/** removeOptimisticItem ****************************************************************************************************************************
 * Suppresses an id from the current view before the search index stops returning it (a trashed note, or one moved out of the filtered notebook).      *
 * isTodo says which list it was in so reconciliation can retire the entry once that list no longer returns it; pass it undefined only when the type is *
 * unknown (a hard delete), in which case the entry is retired by the timeout.                                                                        *
 ***************************************************************************************************************************************************/
export function removeOptimisticItem(noteID, isTodo?){
    if (!noteID) return
    itemOverlay.set(noteID, { record: { id: noteID }, isTodo: (isTodo === undefined ? undefined : !!isTodo), appliedAt: Date.now(), removed: true })
}

/** clearOptimisticItem *****************************************************************************************************************************
 * Drops any overlay entry for an id (insert or suppress). Used when the view can no longer be evaluated locally, so search becomes the sole authority. *
 ***************************************************************************************************************************************************/
export function clearOptimisticItem(noteID){
    itemOverlay.delete(noteID)
}

/** mergeOverlay ************************************************************************************************************************************
 * Folds the overlay for one list (to-dos when wantTodo is true, notes otherwise) into a freshly fetched (or cached) result array, in place:           *
 *  - an insert whose id the search already returns is retired, and the real item kept (search caught up)                                              *
 *  - an insert whose id the search does not return yet is appended                                                                                    *
 *  - a suppress whose id the search still returns is spliced out; once the search no longer returns it (and its type is known) the entry is retired    *
 * A suppress of unknown type is applied to whichever list currently holds the id and left for the timeout to retire.                                  *
 ***************************************************************************************************************************************************/
function mergeOverlay(items, wantTodo){
    if (!itemOverlay.size) return items
    sweepExpired(itemOverlay)
    var present = new Map()
    for (var item of items) present.set(item.id, item)
    for (var pair of itemOverlay){
        var id = pair[0]
        var entry = pair[1]
        if (entry.removed){
            if (entry.isTodo !== undefined && entry.isTodo !== wantTodo) continue
            var hit = present.get(id)
            if (hit){
                var at = items.indexOf(hit)
                if (at >= 0) items.splice(at, 1)
                present.delete(id)
            } else if (entry.isTodo !== undefined){
                itemOverlay.delete(id)          // the search no longer returns it either; done
            }
            continue
        }
        if (entry.isTodo !== wantTodo) continue
        if (present.has(id)){
            itemOverlay.delete(id)              // the search now returns the created/changed item; keep the real one
        } else {
            items.push({ ...entry.record })
        }
    }
    return items
}

/** mergeOptimisticTodos / mergeOptimisticNotes *************************************************************************************************/
export function mergeOptimisticTodos(items){
    return mergeOverlay(items, true)
}
export function mergeOptimisticNotes(items){
    return mergeOverlay(items, false)
}
