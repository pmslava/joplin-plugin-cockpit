/** README ******************************************************************************************************************************************
 * The profile editor dialog allows the user to edit the profile settings and customizations as well as to delete the profile                       *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";
import { createProfile, deleteProfile, getAllProfiles, getProfile, updateProfile } from "../../core/database";
import { getNotebookMap } from "../../core/joplin";
import { escapeHtml } from "../../core/html";
import { openDialogDismissingViewer } from "../../core/dialog";
import { editorTemplate } from "./editorTemplate";

/** Variable Setup *********************************************************************************************************************************/
var dialog = null;
var createButtons = [{title: "Cancel", id: "cancel"}, {title: "Create", id: "ok"}]
var editButtons = [{title: "Cancel", id: "cancel"}, {title: "Delete", id: "delete"}, {title: "Save", id: "ok"}]

/** setupEditor *************************************************************************************************************************************
 * Initializes the profile editor dialog                                                                                                            *
 ***************************************************************************************************************************************************/
export async function setupEditor(){
    dialog = await joplin.views.dialogs.create('editor');
    await joplin.views.dialogs.addScript(dialog, '/ui/editor/editorWebview.js')
    await joplin.views.dialogs.addScript(dialog, '/ui/editor/editor.css')
}

/** openEditor **************************************************************************************************************************************
 * Opens the profile editor dialog for the given profile ID. If Save is clicked, the changes are saved to the database. IF delete is clicked, the   *
 * delete confirmation dialog is opened                                                                                                             *
 ***************************************************************************************************************************************************/
export async function openEditor(profileID?){
    var profileData = profileID == null ? null : btoa(encodeURI(JSON.stringify(await getProfile(profileID))))
    var formattedHtml = profileData == null ? editorTemplate : editorTemplate.replace("<<PROFILE_DATA>>", () => profileData)
    var notebooks = [...(await getNotebookMap()).values()].sort((first, second) => String(first.path).localeCompare(String(second.path)))
    var notebookOptions = `<option value="">All notebooks</option>` + notebooks.map(notebook => `<option value="${escapeHtml(notebook.id)}">${escapeHtml(notebook.path)}</option>`).join("")
    formattedHtml = formattedHtml.replace("<<NOTEBOOK_OPTIONS>>", () => notebookOptions)
    var dialogButtons = profileID == null ? createButtons : editButtons
    await joplin.views.dialogs.setButtons(dialog, dialogButtons)
    await joplin.views.dialogs.setHtml(dialog, formattedHtml);
    // On mobile this dismisses the panel viewer first so the (form-heavy, rarely used) editor dialog is
    // visible; the user is told how to reopen Cockpit afterwards. Desktop opens it as a native dialog as
    // before. The editor is not ported to an in-panel overlay: ~25 fields make it too heavy for a rare action.
    var formResult = await openDialogDismissingViewer(dialog)
    if (formResult.id == 'ok') {
        var profile = JSON.parse(decodeURI(atob(formResult.formData["profileDataForm"]["profileData"])))
        if (profileID == null){
            profileID = await createProfile()
        }
        await updateProfile(profileID, profile)
    } else if (formResult.id == "delete") {
        await openDeleteDialog(profileID)
    }
}

/** openDeleteDialog ********************************************************************************************************************************
 * Opens a confirmation dialog to confirm the deletion of a profile. If OK is clicked, the profile is deleted from the database                     *
 ***************************************************************************************************************************************************/
export async function openDeleteDialog(profileID){
    if ((await getAllProfiles()).length > 1){
        var profile = await getProfile(profileID)
        var response = await joplin.views.dialogs.showMessageBox(`Delete ${profile.name}?`)
        if (response == 0) {
            await deleteProfile(profileID)
        }
    } else {
        await joplin.views.dialogs.showMessageBox(`Unable to Delete: At least 1 profile must exist in database.`)
    }

}
