/** README ******************************************************************************************************************************************
 * This file is responsible for setting up and managing the menus for the plugin                                                                    *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api"
import { MenuItemLocation } from "api/types"
import { isMobile } from "../../core/platform"

/** setupMenu ***************************************************************************************************************************************
 * Sets up the menu used by the plugin. Menus are a desktop only part of the plugin API; on mobile the same commands are reachable from the buttons  *
 * in the panel heading.                                                                                                                            *
 ***************************************************************************************************************************************************/
 export async function setupMenu(){
    if (await isMobile()) return
    await joplin.views.menus.create(
        'agendaMenu',
        "Cockpit",
        [
            {commandName: 'togglePanelVisibility'},
            {commandName: 'toggleCockpitToolbarButton'},
            {commandName: 'showStylerDialog'},
        ],
        MenuItemLocation.Tools
    )
}
