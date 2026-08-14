/** README ******************************************************************************************************************************************
 * Shared helpers for surfacing a Cockpit "dialog" on both platforms without it hiding behind the panel on mobile.                                   *
 *                                                                                                                                                  *
 * On mobile Joplin renders its plugin-panel viewer as a NATIVE React Native <Modal> window, while every plugin dialog is a react-native-paper       *
 * in-tree overlay teleported through a Portal. A native window always draws above an in-tree overlay, so a plugin dialog opened while the panel      *
 * viewer is visible is UNCONDITIONALLY behind it - a structural layering fact, not a timing race (which is why the old one-tick yield changed        *
 * nothing and has been dropped). Two strategies avoid it:                                                                                            *
 *                                                                                                                                                  *
 *   1. IN-PANEL OVERLAYS (openOverlay / the dialogGuard message) - the frequent pickers (notebook, tag, alarm) are drawn as fixed-position HTML      *
 *      overlays INSIDE the panel webview. They create no second Modal, so they are immune to the layering bug, and never tear the panel down. While  *
 *      an overlay is open the webview holds the refresh guard below (dialogGuard true/false), so a background refresh cannot repaint underneath it.   *
 *   2. DISMISS-FIRST NATIVE DIALOG (openDialogDismissingViewer) - the rare, form-heavy dialogs (profile editor, styler) keep their native dialog,    *
 *      but the panel viewer's native window is dismissed FIRST (joplin.commands.execute('dismissPluginPanels')) so the dialog's overlay has nothing  *
 *      above it. A plugin cannot reopen the viewer (no such command/API exists on mobile), so afterwards the user is told to reopen it themselves.    *
 *                                                                                                                                                  *
 * Desktop has no native-window layering limitation, so it keeps native dialogs everywhere with unchanged timing (openPluginDialog).                 *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";
import { isMobile } from "./platform";

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

/** pendingReopenRefresh ****************************************************************************************************************************
 * Set when a dismiss-first dialog (profile editor / styler on mobile) has torn the panel viewer down. The plugin cannot reopen the viewer, so the    *
 * next dialogGuardReset - posted when the user reopens it from the toolbar - is the first signal that Cockpit is visible again. The panel handler     *
 * consumes this flag then and repaints immediately, so a profile just created/edited is current on reopen instead of waiting for the 120s mobile      *
 * timer. Only set on mobile (the dismiss actually happens there); a no-op on desktop, whose viewer is never dismissed.                               *
 ***************************************************************************************************************************************************/
var pendingReopenRefresh = false

export function consumePendingReopenRefresh(){
    var pending = pendingReopenRefresh
    pendingReopenRefresh = false
    return pending
}

/** openPluginDialog ********************************************************************************************************************************
 * Opens a Joplin plugin dialog while holding the guard above, releasing it in the finally once the dialog is dismissed so the caller's own post-dialog *
 * refresh runs after the guard has cleared. Used directly on desktop for every dialog, and on mobile only for the dismiss-first dialogs below (where   *
 * the panel viewer has already been closed, so the guard is moot but kept harmless). The old mobile one-tick yield is gone: it targeted a Modal-       *
 * ordering race that does not exist (the layering is structural), so it never helped.                                                                *
 ***************************************************************************************************************************************************/
export async function openPluginDialog(dialogHandle){
    dialogOpenCount++
    try {
        return await joplin.views.dialogs.open(dialogHandle)
    } finally {
        dialogOpenCount--
    }
}

/** openDialogDismissingViewer **********************************************************************************************************************
 * Opens a native plugin dialog that stays a dialog on both platforms, but on mobile dismisses the panel viewer's native window first so the dialog is  *
 * actually visible (see strategy 2 above). After the dialog resolves the plugin cannot bring the viewer back - no mobile command or API sets the       *
 * viewer visible again - so the user is told to reopen it from the toolbar. On desktop this is a plain openPluginDialog with unchanged behaviour.       *
 ***************************************************************************************************************************************************/
export async function openDialogDismissingViewer(dialogHandle){
    if (!(await isMobile())) return await openPluginDialog(dialogHandle)
    // Close the viewer's native Modal window so the dialog's Paper overlay has nothing above it. Routed
    // through a try/catch so that if a future/older mobile build lacks the command, the dialog still opens
    // (behind the panel, i.e. the pre-existing behaviour) rather than throwing.
    try {
        await joplin.commands.execute('dismissPluginPanels')
    } catch (error) {
        console.warn("Cockpit: dismissPluginPanels is not available; the dialog may open behind the panel", error)
    }
    // The viewer's webview is now torn down, so any refresh the caller issues after this dialog resolves
    // paints into redux off-screen. Arm a refresh for when the user reopens the viewer (its first
    // dialogGuardReset), so a profile just created/edited shows immediately instead of after the 120s timer.
    pendingReopenRefresh = true
    // Let the viewer's fade-out / unmount settle before the dialog's overlay mounts.
    await new Promise(resolve => setTimeout(resolve, 50))
    // The reopen hint is NOT shown here: the caller shows it via notifyViewerDismissed() AFTER any
    // follow-up dialog of its own (e.g. the editor's delete confirmation), so the user is not told to
    // reopen Cockpit before being asked to confirm a deletion that is still mid-flow.
    return await joplin.views.dialogs.open(dialogHandle)
}

/** notifyViewerDismissed ***************************************************************************************************************************
 * Tells the user how to reopen Cockpit after a dismiss-first dialog (and any follow-up dialogs) has finished. A no-op on desktop, where the viewer  *
 * was never dismissed. On mobile the plugin has no way to reopen the viewer, so it points the user at the only control that can - the toolbar's      *
 * panel button - via a native message box (not a Paper overlay), which shows correctly on mobile. Callers invoke this once, last, so the hint never  *
 * interleaves ahead of their own follow-up dialogs.                                                                                                  *
 ***************************************************************************************************************************************************/
export async function notifyViewerDismissed(){
    if (!(await isMobile())) return
    await joplin.views.dialogs.showMessageBox("Cockpit was closed to show this dialog. Tap the panel button in the toolbar to reopen Cockpit.")
}
