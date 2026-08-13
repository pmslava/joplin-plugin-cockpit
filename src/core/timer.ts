/** README ******************************************************************************************************************************************
 *                                                                                                                                                  *
 *  This file is responsible for refreshing the panel interface and markdown notes whenever the content changes. Refreshes are triggered by:         *
 *  - workspace events, so that a change is picked up as soon as it happens                                                                          *
 *  - a periodic timer, which catches everything the events do not cover, such as a to-do moving from "Today" to "Overdue" as time passes             *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";
import { refreshPanelData } from "../ui/panel/panel";
import { getOverviewNoteIDs, refreshNoteData } from "./markdown";
import { updateFrequencySettingKey } from "./settings";
import { markSyncComplete, markSyncStart } from "./syncStatus";

/** Variable Initialization ************************************************************************************************************************/
const defaultUpdateFrequency = 60
const refreshDebounceMs = 1000
// Joplin keeps the search index up to date on a timer of its own, so a to-do that was just created
// or edited is not returned by a search that runs immediately after the change, and how long it
// takes varies. A handful of follow up refreshes covers that without having to poll all the time.
const followUpDelaysMs = [5000, 15000, 30000]
var timer = null
var debounceTimer = null
var followUpTimers = []
var refreshing = false
var refreshQueued = false

/** refreshInterfaces ********************************************************************************************************************************
 * Refreshes the panel and the overview notes. Only one refresh runs at a time. A refresh requested while another one is in progress is run once the  *
 * current one finishes, so that the last change is never lost.                                                                                      *
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
            await refreshPanelData()
            await refreshNoteData()
        } while (refreshQueued)
    } catch (error) {
        console.error("Cockpit: could not refresh the to-do list", error)
    } finally {
        refreshing = false
    }
}

/** scheduleRefresh **********************************************************************************************************************************
 * Requests a refresh a moment from now, plus a few more spread over the following half minute to cover the delay before the change reaches the      *
 * search index. Several requests arriving in quick succession, as happens while a note is being edited, result in a single set of refreshes.        *
 ***************************************************************************************************************************************************/
export function scheduleRefresh(){
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => { void refreshInterfaces() }, refreshDebounceMs)
    for (var followUpTimer of followUpTimers) clearTimeout(followUpTimer)
    followUpTimers = followUpDelaysMs.map(delay => setTimeout(() => { void refreshInterfaces() }, delay))
}

/** setupTimer ***************************************************************************************************************************************
 * Starts, or restarts, the periodic refresh                                                                                                         *
 ***************************************************************************************************************************************************/
export async function setupTimer(){
    clearInterval(timer)
    var updateFrequency = Number(await joplin.settings.value(updateFrequencySettingKey))
    if (!Number.isFinite(updateFrequency) || updateFrequency < 1) updateFrequency = defaultUpdateFrequency
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
        scheduleRefresh()
    })
    // onSyncStart carries no payload (its withErrors is only known at the end), so the button state
    // is measured here: a start sets "syncing", and the panel is re-rendered at once so the
    // Synchronize button starts spinning without waiting for a data refresh.
    await registerEvent("onSyncStart", () => {
        markSyncStart()
        void refreshPanelData()
    })
    await registerEvent("onSyncComplete", (event) => {
        markSyncComplete(event && event.withErrors)
        // Re-render at once so the button stops spinning immediately, then schedule the data
        // refreshes that let the search index catch up with whatever the sync pulled in.
        void refreshPanelData()
        scheduleRefresh()
    })
    await registerEvent("onNoteAlarmTrigger", () => scheduleRefresh())
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
