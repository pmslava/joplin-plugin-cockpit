/** README ******************************************************************************************************************************************
 *  Cockpit is a schedule/calendar panel for joplin that can show all to-dos in a chronological order.                                               *
 *  Via various built in formats and user creatable profiles, the to-do list presentation can be filtered and customized.                           *
 *  In addition to the panel, Cockpit is capable of presenting the to-do list using individual notes.                                                *
 *  This allows the to-do list to be accessed even in apps that cannot show the panel                                                               *
 ***************************************************************************************************************************************************/

/** Imports *****************************************************************************************************************************************/
import joplin from 'api'
import { setupCommands } from './core/commands'
import { refreshInterfaces, restoreNoteStoreBeforePaint, setupTimer, setupWorkspaceEvents } from './core/timer'
import { reportDatabaseProblems, setupDatabase } from './core/database'
import { refreshFromSettingsNote, setupSettingsSync } from './core/settingsSync'
import { refreshExcludedNotebookDisplay, setupSettings } from './core/settings'
import { setupPanel } from './ui/panel/panel'
import { setupAlarmDialog } from './ui/alarm/alarm'
import { setupMenu } from './ui/menu/menu'
import { setupEditor } from './ui/editor/editor'
import { setupToolbar } from './ui/toolbar/toolbar'
import { setupChromeCss } from './ui/chrome/chrome'
import { setupTitleBar } from './ui/titlebar/titleBar'
import { setupStyler } from './ui/styler/styler'
import { scheduleNoteStoreBuild } from './core/noteStore'

/** Plugin Registration *****************************************************************************************************************************
 * Registers the plugin with joplin.                                                                                                                *
 ***************************************************************************************************************************************************/
joplin.plugins.register({ onStart: setupPlugin })

/** setupPlugin *************************************************************************************************************************************
 * Runs all functions to initialize the plugin. The settings are registered first, as the profiles are stored in one of them.                       *
 ****************************************************************************************************************************************************/
 export async function setupPlugin(){
    await setupSettings()
    await setupDatabase()
    // The settings note (v2.6.0) is wired up right after the profile store it syncs, so nothing can change a profile before this
    // module is listening. It costs one settings read while the feature is off, and no data call at all.
    await setupSettingsSync()
    await setupCommands()
    await setupToolbar()
    await setupMenu()
    await setupStyler()
    await setupAlarmDialog()
    // The two note-title-bar features (v2.5.0), both settings-gated and desktop only. The bell intercept is set up
    // AFTER the alarm dialog, because its message handler opens that dialog and the dialog is created there.
    await setupChromeCss()
    await setupTitleBar()
    await setupPanel()
    await setupEditor()
    await setupTimer()
    await setupWorkspaceEvents()
    // THE STARTUP READ, BEFORE THE FIRST PAINT: whatever another device changed while this one was closed arrives here, so the panel's
    // very first render already shows the synced state instead of flipping to it a moment later. It is also what lets this device write
    // at all - a device that has not read the note may never write over it (see flushSettingsNote). A settings note that cannot be read,
    // or an app that answers badly, must never stop the plugin from starting, hence the catch.
    try {
        await refreshFromSettingsNote('startup')
    } catch (error) {
        console.warn("Cockpit: could not read the settings note at startup", error)
    }
    // THE EXCLUDED-NOTEBOOK TEXT, BROUGHT UP TO DATE ONCE PER SESSION (v2.6.2). Its two rewrite sites are the settings
    // onChange handler (the user edits that field) and the folder poll (a notebook actually changed), so a stored value
    // in an older form - 2.6.0's bare names, 2.6.1's short ids - sat there unchanged for ever, which is exactly what the
    // owner saw. HERE, and not earlier: it needs the notebook map, so the data API has to be usable; it must run after
    // setupSettingsSync, whose isSettingsNoteConnected() decides whether an id this device cannot see yet may be tidied
    // away; and it must run after the startup READ above, because that read can apply another device's exclusion pair
    // and this pass has to canonicalise the pair that won rather than the one it replaced. Before refreshInterfaces, so
    // the first paint already uses the reconciled exclusion and nothing is drawn twice. It costs nothing at all while
    // the feature is off, and a failure must no more stop the plugin from starting than the read above does.
    try {
        await refreshExcludedNotebookDisplay()
    } catch (error) {
        console.warn("Cockpit: could not refresh the excluded notebooks at startup", error)
    }
    // THE SAVED NOTE STORE (2.7.1), RESTORED BEFORE THE FIRST PAINT. What changed: until 2.7.1 the note store was never ready for the first paint
    // (only a large to-do search built it inside that render). On desktop the last launch now leaves the store's mirror in a file (noteStore.ts,
    // PERSISTENCE), and bringing it back costs one file read, one events call, a replay of what changed since and one listing page - cheap enough to
    // wait for here, so the first paint is drawn from the store, with no search and no walk. When there is no file to read - every launch on
    // mobile, the first on desktop, the first after an update of Cockpit or of Joplin, or a file another client wrote (none of those is read) -
    // nothing happens here, no store call is made, and the startup order is exactly as it was. A file the restore does not trust is discarded and
    // the ordinary build runs in its place, in the same run, before the first paint: more than 200 notes changed while Cockpit was closed (the
    // replay past the threshold, the common one), another database or a backup, an absence of two months, a count that differs. On a large
    // collection the first paint would have waited for that build anyway when its to-do search proves large (ensureBuilt). After the
    // excluded-notebook pass, which the first paint needs and which reads no note; and a failure here must no more stop the plugin from starting
    // than the reads above.
    try {
        await restoreNoteStoreBeforePaint()
    } catch (error) {
        console.warn("Cockpit: could not restore the note store at startup", error)
    }
    await refreshInterfaces()
    // THE NOTE STORE (2.7), ARMED NOW AND NEVER AWAITED HERE. Its build walks the whole notes listing - 201 pages on a 20,000-note collection - so
    // it is armed as a timeout after the first paint has happened, and onStart does not wait for it. On an ordinary collection that first paint took
    // the 2.6.3 paths, the unfiltered views read the store once the timeout's build is done, and until the timeout fires the store's triggers (the
    // tick, a sync, a note change) do nothing at all. On a large one (2.7.1) the first paint may have built the store already: a to-do search that
    // proved large would have walked the same listing, so that render built the store instead and read it (ensureBuilt in noteStore.ts), and the
    // timeout then finds the store ready and does nothing - as it does after a restore (2.7.1, above). Before the database report, which can hold
    // onStart on a message box.
    scheduleNoteStoreBuild()
    await reportDatabaseProblems()
}
