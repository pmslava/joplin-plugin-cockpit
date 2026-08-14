/** README ******************************************************************************************************************************************
 * The styler dialog allows the user to add custom css to change the appearance of the panel. The CSS is stored in a plugin setting: earlier         *
 * versions kept it in a custom.css file in the plugin directory, which is not writable on mobile.                                                  *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";
import { refreshPanelData } from "../panel/panel";
import { escapeHtml } from "../../core/formats";
import { getCustomCss, setCustomCss } from "../../core/settings";
import { requireNodeModule, isMobile } from "../../core/platform";
import { openDialogDismissingViewer, notifyViewerDismissed } from "../../core/dialog";
import { stylerTemplate } from "./stylerTemplate";

/** Variable Setup *********************************************************************************************************************************/
var dialog = null;

/** setupStyler *************************************************************************************************************************************
 * Initializes the panel styler dialog                                                                                                              *
 ***************************************************************************************************************************************************/
export async function setupStyler(){
    dialog = await joplin.views.dialogs.create('styler');
    await joplin.views.dialogs.addScript(dialog, '/ui/styler/styler.css')
    await importLegacyCssFile()
}

/** openStyler **************************************************************************************************************************************
 * Opens the panel styler dialog where custom css for the panel can be added.                                                                       *
 ***************************************************************************************************************************************************/
export async function openStyler(){
    var cssData = escapeHtml(await getCustomCss())
    var formattedHtml = stylerTemplate.replace("<<CSS_DATA>>", () => cssData)
    await joplin.views.dialogs.setHtml(dialog, formattedHtml);
    // On mobile this dismisses the panel viewer first so the styler dialog is visible; the user is told
    // how to reopen Cockpit afterwards. Desktop opens it as a native dialog as before.
    var formResult = await openDialogDismissingViewer(dialog)
    if (formResult.id == 'ok') {
        await setCustomCss(formResult.formData['customCSSForm']['customCss'])
        await refreshPanelData()
    } else if (await isMobile()) {
        // On mobile the dismiss-first path has already torn the panel viewer's webview down, so any
        // refresh that fired while the dialog was open was a silent no-op repaint of redux (it could not
        // re-assert the closed viewer). Repaint once on cancel so the panel is current when reopened.
        // Desktop keeps its own working refresh untouched.
        await refreshPanelData()
    }
    // Show the reopen hint last (no-op on desktop), consistent with the editor flow.
    await notifyViewerDismissed()
}

/** importLegacyCssFile *****************************************************************************************************************************
 * Copies the custom CSS of Cockpit 3.6 and later out of the custom.css file and into settings. The file lives in the plugin installation directory,  *
 * which Joplin recreates when the plugin is updated, so this is a best effort import that only runs on desktop.                                     *
 ***************************************************************************************************************************************************/
async function importLegacyCssFile(){
    if (await getCustomCss()) return
    var fs = requireNodeModule("fs-extra", "readFile")
    if (!fs) return
    try {
        var cssFilePath = (await joplin.plugins.installationDir()) + '/custom.css'
        if (!await fs.pathExists(cssFilePath)) return
        var cssData = await fs.readFile(cssFilePath, 'utf8')
        if (cssData && cssData.trim()){
            await setCustomCss(cssData)
            console.info(`Cockpit: imported the custom panel CSS from ${cssFilePath}`)
        }
    } catch (error) {
        console.warn("Cockpit: could not import the custom panel CSS", error)
    }
}
