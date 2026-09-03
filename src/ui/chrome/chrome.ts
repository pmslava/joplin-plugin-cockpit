/** README ******************************************************************************************************************************************
 * This file loads the chrome stylesheets Cockpit applies to Joplin's own window UI, as opposed to the CSS that lives inside Cockpit's panel and     *
 * dialogs. There is exactly one so far: the rules that hide the due-date text next to the alarm bell in the note title bar and bring it back as a   *
 * hover bubble.                                                                                                                                    *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api"
import { isMobile } from "../../core/platform"
import { isDueDateOnHoverEnabled } from "../../core/settings"

/** setupChromeCss **********************************************************************************************************************************
 * Loads src/ui/chrome/dueOnHover.css into the app window when the setting asks for it.                                                              *
 *                                                                                                                                                  *
 * Desktop only: joplin.window is a desktop API, and the mobile app has no note title bar with a bell in it at all.                                  *
 *                                                                                                                                                  *
 * The file is shipped verbatim by the webpack CopyPlugin (every non-.ts file under src/ is copied into dist/), so its path inside the installed     *
 * plugin mirrors its path in the source tree. Joplin gives no way to UNLOAD a chrome stylesheet, which is why the setting's description says the    *
 * change takes effect after a restart: switching it off simply stops the next startup from loading the file.                                        *
 ***************************************************************************************************************************************************/
export async function setupChromeCss(){
    if (await isMobile()) return
    if (!(await isDueDateOnHoverEnabled())) return
    var installDir = await joplin.plugins.installationDir()
    await joplin.window.loadChromeCssFile(`${installDir}/ui/chrome/dueOnHover.css`)
}
