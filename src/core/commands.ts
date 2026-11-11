/** README ******************************************************************************************************************************************
 * This file contains all of the plugin related commands.                                                                                          *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";
import { openStyler } from "../ui/styler/styler";
import { filterByNotebook, pinNotes, revealNote, togglePanelVisibility } from "../ui/panel/panel";
import { showToolbarButtonSettingKey } from "./settings";
import { connectSettingsNote } from "./settingsSync";

/** setupCommands ***********************************************************************************************************************************
 * Sets up the commands used by the plugin                                                                                                          *
 ***************************************************************************************************************************************************/
export async function setupCommands(){
    await joplin.commands.register({
        name: 'togglePanelVisibility',
        label: 'Toggle Cockpit Panel',
        iconName: 'fas fa-tachometer-alt',
        execute: togglePanelVisibility
    })
    await joplin.commands.register({
        name: 'toggleCockpitToolbarButton',
        label: 'Show/Hide Cockpit Toolbar Button',
        execute: toggleCockpitToolbarButton
    })
    await joplin.commands.register({
        name: 'showStylerDialog',
        label: 'Set Panel CSS',
        execute: openStyler
    })
    // The settings note (v2.6.0): create it, or find and adopt one that already exists, and point the setting at it. Registered on
    // both platforms so it is reachable from the command palette; the Tools menu item is desktop only, like every other menu item.
    await joplin.commands.register({
        name: 'cockpit.connectSettingsNote',
        label: 'Cockpit: Connect settings note',
        execute: connectSettingsNote
    })
    // ------------------------------------------------------------------ the cross-plugin contract
    // These two exist for OTHER PLUGINS to call, and their names are the contract: the Whereabouts plugin's
    // notebook chip executes 'cockpit.filterByNotebook' on a left click and 'cockpit.revealNote' on a double
    // click, passing a plain id string, and swallows every failure - so a rename here does not break its build,
    // it silently stops working. They are namespaced (the plain names above are this plugin's own history) and
    // carry a label so they are reachable from the command palette too, but no menu or toolbar item: neither is
    // useful without an argument. Both are total on their input - an id that resolves to nothing warns and
    // returns rather than throwing back into the calling plugin - and neither does any work beyond one refresh.
    await joplin.commands.register({
        name: 'cockpit.filterByNotebook',
        label: 'Cockpit: filter by notebook',
        execute: filterByNotebook
    })
    await joplin.commands.register({
        name: 'cockpit.revealNote',
        label: 'Cockpit: reveal note',
        execute: revealNote
    })
    // The third (2.11.1): 'cockpit.pinNotes' pins note ids in Cockpit's own Pinned section - never Note Tabs, whatever the pin target says,
    // since the caller decides where it pins. Jot executes it for the note it creates when its own pin setting names Cockpit, passing an
    // array of ids (a bare string is one id), and treats "Command not found" / "without a runtime" as Cockpit being absent. Total like the
    // two above: an empty or malformed argument warns and returns; otherwise it resolves { pinned }, the ids now in the list.
    await joplin.commands.register({
        name: 'cockpit.pinNotes',
        label: 'Cockpit: pin notes',
        execute: pinNotes
    })
}

/** toggleCockpitToolbarButton **********************************************************************************************************************
 * Toggles the setting that controls whether the Cockpit toolbar button is created at startup, then tells the user a restart is needed.             *
 ***************************************************************************************************************************************************/
async function toggleCockpitToolbarButton(){
    var next = !(await joplin.settings.value(showToolbarButtonSettingKey))
    await joplin.settings.setValue(showToolbarButtonSettingKey, next)
    await joplin.views.dialogs.showMessageBox(
        next
            ? "The Cockpit toolbar button will appear after you restart Joplin."
            : "The Cockpit toolbar button will be hidden after you restart Joplin."
    )
}
