/** README ******************************************************************************************************************************************
 * This file contains all of the plugin related commands.                                                                                          *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";
import { openStyler } from "../ui/styler/styler";
import { togglePanelVisibility } from "../ui/panel/panel";
import { showToolbarButtonSettingKey } from "./settings";

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
