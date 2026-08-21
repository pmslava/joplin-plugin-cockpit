/** README ******************************************************************************************************************************************
 * This file is responsible for setting up and managing the buttons added to the toolbar                                                            *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";
import { ToolbarButtonLocation } from "api/types";
import { isMobile } from "../../core/platform";
import { isToolbarButtonEnabled } from "../../core/settings";

/** setupToolbar ************************************************************************************************************************************
 * Registers a toolbar button to toggle the panel visibility between shown and hidden.                                                              *
 * The note toolbar is a desktop only location, and a button placed there does nothing on mobile. Mobile does not need one either, as the app has    *
 * its own toolbar button that opens every plugin panel.                                                                                            *
 ***************************************************************************************************************************************************/
export async function setupToolbar() {
    if (await isMobile()) return
    if (!(await isToolbarButtonEnabled())) return
    await joplin.views.toolbarButtons.create(
        'togglePanelVisibilityButton',
        'togglePanelVisibility',
        ToolbarButtonLocation.NoteToolbar
    );
}
