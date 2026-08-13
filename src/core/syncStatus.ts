/** README ******************************************************************************************************************************************
 * The state of the last (or running) synchronisation, self-measured from the onSyncStart / onSyncComplete workspace events. Joplin does not expose   *
 * its sync report ("Created remote items...") to plugins, so the only facts available are whether a sync is running, when the last one finished, how  *
 * long it took, and whether it had errors - which is what the panel's Synchronize button shows.                                                      *
 * Kept in its own module, with no imports, so both the timer (which registers the events) and the panel (which renders the button) can use it without *
 * importing each other.                                                                                                                             *
 ***************************************************************************************************************************************************/

var syncing = false
var startedAt = 0
var lastCompletedAt = null
var lastDurationMs = null
var lastWithErrors = false

/** markSyncStart ***********************************************************************************************************************************/
export function markSyncStart(){
    syncing = true
    startedAt = Date.now()
}

/** markSyncComplete ********************************************************************************************************************************/
export function markSyncComplete(withErrors){
    syncing = false
    lastCompletedAt = Date.now()
    lastDurationMs = startedAt ? lastCompletedAt - startedAt : null
    lastWithErrors = !!withErrors
}

/** getSyncStatus **********************************************************************************************************************************/
export function getSyncStatus(){
    return { syncing: syncing, lastCompletedAt: lastCompletedAt, lastDurationMs: lastDurationMs, lastWithErrors: lastWithErrors }
}
