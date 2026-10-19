/** README ******************************************************************************************************************************************
 * The profile editor dialog allows the user to edit the profile settings and customizations as well as to delete the profile, and to create a      *
 * profile, starting from the view on screen                                                                                                        *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";
import { createProfile, deleteProfile, getAllProfiles, getProfile, updateProfile } from "../../core/database";
import { getNotebookMap } from "../../core/joplin";
import { escapeHtml } from "../../core/html";
import { openPluginDialog } from "../../core/dialog";
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
 * Opens the profile editor dialog. With a profile ID it edits that profile: Save writes the changes to the database, Delete opens the delete       *
 * confirmation dialog. Without one it creates a profile, and seed is what the form starts from - the view on screen, built by                      *
 * profileSeedFromCurrentView in panel.ts - prefilled through the same <<PROFILE_DATA>> route an edit uses, under the Create/Cancel buttons. The    *
 * markup also says which mode it is (<<EDITOR_MODE>>), so that editorWebview.js focuses the name field with its text selected in a create, and     *
 * focuses nothing in an edit.                                                                                                                      *
 *                                                                                                                                                  *
 * Returns the id of the profile a Create made, so the caller can select it, and null for everything else: a Save, a Delete, a Cancel. DESKTOP      *
 * ONLY: on mobile the profile editor is an in-panel overlay (openEditorOverlay in the panel webview, with getEditorInitial / profileSaved /        *
 * profileDeleteRequested round-trips), so the create/edit-profile webview buttons never reach this handler.                                        *
 ***************************************************************************************************************************************************/
export async function openEditor(profileID?, seed?){
    var isCreate = profileID == null
    // An edit encodes whatever the store holds for the id, exactly as it always has; a create encodes its seed, and a
    // create without one keeps the placeholder, which the webview leaves at the template defaults.
    var formProfile = isCreate ? seed : await getProfile(profileID)
    var profileData = isCreate && formProfile == null ? null : btoa(encodeURI(JSON.stringify(formProfile)))
    var formattedHtml = editorTemplate.replace("<<EDITOR_MODE>>", isCreate ? "create" : "edit")
    if (profileData != null) formattedHtml = formattedHtml.replace("<<PROFILE_DATA>>", () => profileData)
    var notebooks = [...(await getNotebookMap()).values()].sort((first, second) => String(first.path).localeCompare(String(second.path)))
    var notebookOptions = `<option value="">All notebooks</option>` + notebooks.map(notebook => `<option value="${escapeHtml(notebook.id)}">${escapeHtml(notebook.path)}</option>`).join("")
    formattedHtml = formattedHtml.replace("<<NOTEBOOK_OPTIONS>>", () => notebookOptions)
    var dialogButtons = isCreate ? createButtons : editButtons
    await joplin.views.dialogs.setButtons(dialog, dialogButtons)
    await joplin.views.dialogs.setHtml(dialog, formattedHtml);
    var formResult = await openPluginDialog(dialog)
    if (formResult.id == 'ok') {
        var profile = JSON.parse(decodeURI(atob(formResult.formData["profileDataForm"]["profileData"])))
        if (isCreate){
            var createdID = await createProfile()
            await updateProfile(createdID, profile)
            return createdID
        }
        await updateProfile(profileID, profile)
    } else if (formResult.id == "delete") {
        await openDeleteDialog(profileID)
    }
    return null
}

/** getEditorInitial ********************************************************************************************************************************
 * Prefill round-trip for the mobile in-panel editor overlay (mirrors getAlarmInitialFields). Returns the mode plus the profile the overlay         *
 * populates its fields from directly, as a plain object (no base64): the stored profile when editing, and for a create the seed the panel passes   *
 * in - the view on screen, the same one the desktop dialog opens with (profileSeedFromCurrentView in panel.ts).                                    *
 ***************************************************************************************************************************************************/
export async function getEditorInitial(profileID?, seed?){
    if (profileID == null) return { mode: "create", profile: seed == null ? null : seed }
    return { mode: "edit", profile: await getProfile(profileID) }
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
