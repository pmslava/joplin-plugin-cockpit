/** README ******************************************************************************************************************************************
 * A shared guard for opening Joplin plugin dialogs, so that on mobile a dialog does not appear BEHIND the panel.                                    *
 *                                                                                                                                                  *
 * On mobile Joplin renders the panel viewer and every custom dialog as separate React Native <Modal> windows teleported through a Portal. RN cannot *
 * reliably z-order two visible Modals: the one attached last wins, and "last" follows declaration order plus which Modal most recently transitioned  *
 * visible within a React commit. Joplin declares the always-mounted panel viewer AFTER the dialog list, so a dialog that opens in the SAME commit as *
 * a panel re-render (or while a mid-dialog panel refresh re-asserts the viewer Modal) can end up in the background. A plugin cannot set the native    *
 * z-order from inside its webview, so the mitigation is entirely about timing:                                                                       *
 *   (a) never let a panel refresh run while a dialog is open (refreshPanelData consults isDialogOpen() on mobile), and                              *
 *   (b) let the dialog's Modal mount in its own commit by yielding a tick before dialogs.open() on mobile, so it attaches last and paints on top.    *
 * Desktop has no such stacking limitation, so the yield is skipped there and dialogs.open() is called with unchanged timing.                         *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";
import { isMobile } from "./platform";

/** dialogOpenCount *********************************************************************************************************************************
 * How many Cockpit dialogs are currently open. A counter rather than a boolean so nested or overlapping opens (should any ever occur) all have to    *
 * close before the guard clears. Read by refreshPanelData through isDialogOpen().                                                                   *
 ***************************************************************************************************************************************************/
var dialogOpenCount = 0

/** isDialogOpen ************************************************************************************************************************************
 * True while any Cockpit dialog is open. refreshPanelData uses this (on mobile) to skip a refresh that would re-assert the panel viewer's native     *
 * Modal on top of the open dialog.                                                                                                                  *
 ***************************************************************************************************************************************************/
export function isDialogOpen(){
    return dialogOpenCount > 0
}

/** openPluginDialog ********************************************************************************************************************************
 * Opens a Joplin plugin dialog while holding the guard above. On mobile it first yields one tick so the dialog's Modal commits separately from the   *
 * click's panel re-render, which is what lets it attach last (on top). The counter is released in the finally, which runs only after dialogs.open()  *
 * resolves - i.e. after the dialog is fully dismissed - so the caller's own post-dialog refresh runs after the guard has cleared.                   *
 ***************************************************************************************************************************************************/
export async function openPluginDialog(dialogHandle){
    dialogOpenCount++
    try {
        if (await isMobile()) await new Promise(resolve => setTimeout(resolve, 0))
        return await joplin.views.dialogs.open(dialogHandle)
    } finally {
        dialogOpenCount--
    }
}
