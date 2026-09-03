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
import { setupSettings } from './core/settings'
import { setupPanel } from './ui/panel/panel'
import { setupAlarmDialog } from './ui/alarm/alarm'
import { setupMenu } from './ui/menu/menu'
import { setupEditor } from './ui/editor/editor'
import { setupToolbar } from './ui/toolbar/toolbar'
import { setupChromeCss } from './ui/chrome/chrome'
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
    await setupCommands()
    await setupToolbar()
    await setupMenu()
    await setupStyler()
    await setupAlarmDialog()
    // A note-title-bar feature (v2.5.0), settings-gated and desktop only.
    await setupChromeCss()
    await setupPanel()
    await setupEditor()
    await setupTimer()
    await setupWorkspaceEvents()
    await refreshInterfaces()
    await reportDatabaseProblems()
}
