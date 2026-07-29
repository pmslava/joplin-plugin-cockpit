/** README ******************************************************************************************************************************************
 * The agenda panel. On desktop it is shown beside the note list; on mobile Joplin shows it as a tab in the plugin panel dialog, which is opened     *
 * from the built in toolbar button of the note screen.                                                                                             *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";
import { openTodo, toggleTodoCompletion } from "../../core/joplin";
import { refreshInterfaces, scheduleRefresh } from "../../core/timer";
import { getAllProfiles, getProfile } from "../../core/database";
import { openDeleteDialog, openEditor } from "../editor/editor";
import { escapeHtml, getFormatter } from "../../core/formats";
import { getCurrentProfileID, getCustomCss, setCurrentProfileID } from "../../core/settings";
import { isMobile } from "../../core/platform";
import { panelTemplate } from "./panelTemplate";
import { iconButton } from "../icons";

/** Variable Declaration ***************************************************************************************************************************/
var panel = null;
var lastRenderedHtml = null;

/** setupPanel **************************************************************************************************************************************
 * Creates the panel in joplin and connects the event handler.                                                                                      *
 ***************************************************************************************************************************************************/
export async function setupPanel(){
    panel = await joplin.views.panels.create('panel')
    await joplin.views.panels.addScript(panel, '/ui/panel/panelWebview.js')
    await joplin.views.panels.addScript(panel, '/ui/panel/panel.css')
    await joplin.views.panels.onMessage(panel, eventHandler)
}

/** eventHandler ************************************************************************************************************************************
 * Processes all events triggered by the panel's internal javascript                                                                                *
 ***************************************************************************************************************************************************/
async function eventHandler(message){
    if (message[0] == 'todoClicked'){
        await openTodo(message[1])
    } else if (message[0] == 'todoChecked'){
        await toggleTodoCompletion(message[1])
        await refreshInterfaces()
        // The completed to-do only disappears from the list once the search index has caught up.
        scheduleRefresh()
    } else if (message[0] == 'profilesDropdownChanged'){
        await setCurrentProfileID(message[1])
        await refreshInterfaces()
    } else if (message[0] == 'createProfileClicked'){
        await openEditor()
        await refreshInterfaces()
    } else if (message[0] == 'editProfileClicked'){
        var id = await getCurrentProfileID()
        await openEditor(id)
        await refreshInterfaces()
    } else if (message[0] == 'deleteProfileClicked'){
        var id = await getCurrentProfileID()
        await openDeleteDialog(id)
        await refreshInterfaces()
    } else if (message[0] == 'updateInterfacesClicked'){
        await refreshInterfaces()
    } else if (message[0] == 'toggleProfileControlsClicked'){
        await toggleShowProfileControls()
    } else if (message[0] == 'stylerClicked'){
        // Executed as a command rather than called directly so that the panel does not have to import the styler dialog, which imports the panel.
        await joplin.commands.execute('showStylerDialog')
    }
}

/** togglePanelVisibility ***************************************************************************************************************************
 * Toggles the main panel between shown and hidden. On mobile the panel is a tab in Joplin's own plugin panel dialog, which the user opens and       *
 * closes from the app itself, so hiding it here would leave no way of getting it back.                                                             *
 ***************************************************************************************************************************************************/
export async function togglePanelVisibility() {
    if (await isMobile()) return
    var visibility = await joplin.views.panels.visible(panel);
    await joplin.views.panels.show(panel, !visibility);
}

/** toggleShowProfileControls ***********************************************************************************************************************
 * Toggles between showing and hiding the profile editor buttons (create, edit and delete profile) on the main panel									*
 ***************************************************************************************************************************************************/
 export async function toggleShowProfileControls() {
	var showProfileControls = await joplin.settings.value("showProfileControls")
	await joplin.settings.setValue("showProfileControls", !showProfileControls)
	await refreshPanelData()
}

/** refreshPanelData ********************************************************************************************************************************
 * Displays all todos in the panel, according to the formatting specified by the profile and format. The panel is only updated when the markup has   *
 * actually changed, as replacing it resets the scroll position and any in progress interaction.                                                    *
 ***************************************************************************************************************************************************/
 export async function refreshPanelData(){
    if (!panel) return
    var profileID = await getCurrentProfileID()
    var profile = await getProfile(profileID)
    if (!profile) return
    var todosHtml = await getFormatter(profile, 'html').getTodos()
    var headingButtonsHtml = await getHeadingButtonsHTML()
    var profileControlsHtml = await getProfileControlsHTML(profileID)
    var customCss = sanitizeCss(await getCustomCss())
    var htmlString = panelTemplate
        .replace("<<CUSTOM_CSS>>", () => customCss)
        .replace("<<HEADING_BUTTONS>>", () => headingButtonsHtml)
        .replace("<<PROFILE_CONTROLS>>", () => profileControlsHtml)
        .replace("<<TODOS>>", () => todosHtml)
    if (htmlString === lastRenderedHtml) return
    lastRenderedHtml = htmlString
    await joplin.views.panels.setHtml(panel, htmlString);
}

/** getHeadingButtonsHTML ***************************************************************************************************************************
 * Returns the buttons shown in the panel heading. On mobile these also cover the two commands that live in the Tools menu on desktop, as mobile     *
 * has no menu for plugins to add items to.                                                                                                         *
 ***************************************************************************************************************************************************/
async function getHeadingButtonsHTML(){
    var buttonsHtml = ""
    if (await isMobile()){
        buttonsHtml += iconButton("sliders", "Toggle Profile Edit Mode", "onToggleProfileControlsClicked()")
        buttonsHtml += iconButton("brush", "Set Panel CSS", "onStylerClicked()")
    }
    buttonsHtml += iconButton("refresh", "Update Panel and Notes", "onUpdateInterfacesClicked()")
    return buttonsHtml
}

/** getProfileControlsHTML **************************************************************************************************************************
 * Returns a string representing the HTML containing the profile dropdown and the create, edit and delete buttons                                   *
 ***************************************************************************************************************************************************/
async function getProfileControlsHTML(currentProfileID){
    var profileListString = ""
    for (var profile of await getAllProfiles()){
        var selected = currentProfileID && currentProfileID == profile.id ? "selected" : ""
        profileListString += `<option value="${profile.id}" ${selected}>${escapeHtml(profile.name)}</option>`
    }
    var showProfileControls = await joplin.settings.value("showProfileControls")
    return `
        <section id="profileControls">
            <select id="profileDropdown" onchange="onProfilesDropdownChanged(this.value)">
                ${profileListString}
            </select>
            <section id="profileButtonsSection" style="display: ${showProfileControls == true ? "flex" : "none"};">
                ${iconButton("plus", "Create New Profile", "onCreateProfileClicked()")}
                ${iconButton("edit", "Edit Profile", "onEditProfileClicked()")}
                ${iconButton("trash", "Delete Profile", "onDeleteProfileClicked()")}
            </section>
        </section>
    `
}

/** sanitizeCss *************************************************************************************************************************************
 * Prevents the user's custom CSS from closing the style element it is placed in                                                                    *
 ***************************************************************************************************************************************************/
function sanitizeCss(customCss){
    return String(customCss || "").replace(/<\/(style)/gi, "<\\/$1")
}
