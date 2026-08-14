/** README ******************************************************************************************************************************************
 * Shared helpers for surfacing a Cockpit "dialog" on both platforms without it hiding behind the panel on mobile.                                   *
 *                                                                                                                                                  *
 * On mobile Joplin renders its plugin-panel viewer as a NATIVE React Native <Modal> window, while every plugin dialog is a react-native-paper       *
 * in-tree overlay teleported through a Portal. A native window always draws above an in-tree overlay, so a plugin dialog opened while the panel      *
 * viewer is visible is UNCONDITIONALLY behind it - a structural layering fact. So on mobile Cockpit never opens a native dialog: every user-facing   *
 * flow (notebook, tag, alarm pickers and the profile editor) is drawn as a fixed-position HTML overlay INSIDE the panel webview. They create no      *
 * second Modal, so they are immune to the layering bug and never tear the panel down. While an overlay is open the webview holds the refresh guard   *
 * below (the dialogGuard true/false message), so a background refresh cannot repaint underneath it.                                                  *
 *                                                                                                                                                  *
 * Desktop has no native-window layering limitation, so it keeps native dialogs everywhere (openPluginDialog).                                       *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";

/** dialogOpenCount *********************************************************************************************************************************
 * How many Cockpit dialogs or in-panel overlays are currently open. A counter rather than a boolean so nested or overlapping opens all have to close  *
 * before the guard clears. Read by refreshPanelData through isDialogOpen(); bumped both by openPluginDialog (native dialogs) and by the webview's      *
 * dialogGuard message (in-panel overlays), via setOverlayGuard.                                                                                       *
 ***************************************************************************************************************************************************/
var dialogOpenCount = 0

/** isDialogOpen ************************************************************************************************************************************
 * True while any Cockpit dialog or in-panel overlay is open. refreshPanelData uses this (on mobile) to skip a refresh that would either re-assert the  *
 * panel viewer's native Modal on top of an open dialog, or repaint the panel content underneath an open overlay.                                      *
 ***************************************************************************************************************************************************/
export function isDialogOpen(){
    return dialogOpenCount > 0
}

/** setOverlayGuard *********************************************************************************************************************************
 * Adjusts the guard for an in-panel overlay. The panel webview posts ['dialogGuard', true] the moment an overlay opens and ['dialogGuard', false]     *
 * whenever it closes for ANY reason (OK, Cancel, Escape, an outside tap or the Android back gesture), so the count is always balanced and cannot leak. *
 * Guarded against going negative in case a stray false ever arrives without a matching true.                                                          *
 ***************************************************************************************************************************************************/
export function setOverlayGuard(open){
    if (open) dialogOpenCount++
    else if (dialogOpenCount > 0) dialogOpenCount--
}

/** resetOverlayGuard *******************************************************************************************************************************
 * Zeroes the guard. Posted by the panel webview once at every (re)load: on mobile the counter is only ever raised by in-panel overlays (native mobile  *
 * dialogs go through the dismiss-first path, which does not touch it), so a fresh webview means no overlay is open and any residual count must be a     *
 * leak from a webview that was torn down mid-overlay (the whole viewer closed from the toolbar, or an Android back that unmounted it) before its close  *
 * could post ['dialogGuard', false]. Clearing it here keeps refreshPanelData from being paused forever. A no-op (0 -> 0) on a normal fresh load.        *
 ***************************************************************************************************************************************************/
export function resetOverlayGuard(){
    dialogOpenCount = 0
}

/** openPluginDialog ********************************************************************************************************************************
 * Opens a Joplin plugin dialog while holding the guard above, releasing it in the finally once the dialog is dismissed so the caller's own post-dialog *
 * refresh runs after the guard has cleared. Used on desktop for every dialog (the profile editor and the styler). On mobile those flows are in-panel   *
 * overlays instead, so this is not reached there.                                                                                                      *
 ***************************************************************************************************************************************************/
export async function openPluginDialog(dialogHandle){
    dialogOpenCount++
    try {
        return await joplin.views.dialogs.open(dialogHandle)
    } finally {
        dialogOpenCount--
    }
}
