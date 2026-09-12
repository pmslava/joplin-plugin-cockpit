/** README ******************************************************************************************************************************************
 *  Cockpit is a schedule/calendar panel for joplin that can show all to-dos in a chronological order.                                               *
 *  Via various built in formats and user creatable profiles, the to-do list presentation can be filtered and customized.                           *
 *  In addition to the panel, Cockpit is capable of presenting the to-do list using individual notes.                                                *
 *  This allows the to-do list to be accessed even in apps that cannot show the panel                                                               *
 ***************************************************************************************************************************************************/

/** Imports *****************************************************************************************************************************************/
import joplin from 'api'
import { setupCommands } from './core/commands'
import { refreshInterfaces, setupTimer, setupWorkspaceEvents } from './core/timer'
import { reportDatabaseProblems, setupDatabase } from './core/database'
import { refreshFromSettingsNote, setupSettingsSync } from './core/settingsSync'
import { setupSettings } from './core/settings'
import { setupPanel } from './ui/panel/panel'
import { setupAlarmDialog } from './ui/alarm/alarm'
import { setupMenu } from './ui/menu/menu'
import { setupEditor } from './ui/editor/editor'
import { setupToolbar } from './ui/toolbar/toolbar'
import { setupChromeCss } from './ui/chrome/chrome'
import { setupTitleBar } from './ui/titlebar/titleBar'
import { setupStyler } from './ui/styler/styler'

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
    await refreshInterfaces()
    await reportDatabaseProblems()
}
