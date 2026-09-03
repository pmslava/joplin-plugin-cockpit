/** README ******************************************************************************************************************************************
 * This file is the plugin half of the note title bar's alarm-bell intercept. It registers Cockpit's editor content script                          *
 * (src/contentScripts/titleBar.ts, which is what actually catches the click in the renderer window) and answers the one message that script sends.  *
 *                                                                                                                                                  *
 * Why an intercept and not a command override: Joplin's editAlarm is a core command, and CommandService.registerDeclaration REPLACES an existing    *
 * entry - re-registering the name would drop Joplin's mapStateToTitle and with it the due date the button prints, breaking the bell instead of      *
 * redirecting it. Catching the DOM click is the only route, and the content script is the only way plugin JS reaches that DOM. See the banner in    *
 * src/contentScripts/titleBar.ts for the three constraints that make the intercept correct.                                                         *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api"
import { ContentScriptType } from "api/types"
import { isMobile } from "../../core/platform"
import { isBellPickerEnabled } from "../../core/settings"
import { openAlarmDialog } from "../alarm/alarm"

/** Variable Setup *********************************************************************************************************************************/
/** The content script id. Both the registration and the onMessage subscription key off it, so they are one constant. */
export const titleBarScriptID = 'cockpit-title-bar'

/** setupTitleBar ***********************************************************************************************************************************
 * Registers the content script and its message handler when the setting asks for it.                                                               *
 *                                                                                                                                                  *
 * Desktop only: the mobile app has no note title bar with an alarm bell, and no CodeMirror-hosted chrome DOM for the script to reach.               *
 *                                                                                                                                                  *
 * Joplin cannot unregister a content script while it is running, which is why the setting's description says the change takes effect after a        *
 * restart: switching it off stops the next startup from registering it.                                                                             *
 ***************************************************************************************************************************************************/
export async function setupTitleBar(){
    if (await isMobile()) return
    if (!(await isBellPickerEnabled())) return
    await joplin.contentScripts.register(ContentScriptType.CodeMirrorPlugin, titleBarScriptID, './contentScripts/titleBar.js')
    await joplin.contentScripts.onMessage(titleBarScriptID, onTitleBarMessage)
}

/** onTitleBarMessage *******************************************************************************************************************************
 * Answers the content script's one message, { type: 'openAlarm', noteId }, by opening Cockpit's own alarm dialog for that note.                     *
 *                                                                                                                                                  *
 * Everything the renderer sends is treated as untrusted input: the payload shape, the id and the note itself are all re-checked here, and the note  *
 * is re-read FRESH rather than trusted from the click, because the bell's enabled state is the renderer's opinion and the note may have changed     *
 * since it was drawn. A note that is not a to-do, or a to-do already completed, is REFUSED - those are exactly the states in which Joplin disables   *
 * the bell, so opening a picker for them would be Cockpit inventing an action Joplin does not offer.                                                *
 *                                                                                                                                                  *
 * Nothing here ever throws: an unknown id makes joplin.data.get throw 'Not Found', which becomes { ok: false } like any other refusal, and the outer *
 * try/catch turns a genuine failure into the same shape. A rejected promise on this side would surface in the renderer as an unhandled rejection     *
 * with no user-visible effect at all, so a reason is returned for the content script to log instead.                                                *
 *                                                                                                                                                  *
 * openAlarmDialog is the very dialog the panel's own "Set alarm" opens (the precedent is panel.ts's 'setAlarmClicked' branch); it is created once at *
 * startup by setupAlarmDialog and its OK/Clear paths already write the due and refresh the panel and the overview notes.                            *
 ***************************************************************************************************************************************************/
export async function onTitleBarMessage(message){
    try {
        if (!message || typeof message !== 'object') return { ok: false, reason: "the message was not an object" }
        if (message.type !== 'openAlarm') return { ok: false, reason: `unknown message type ${String(message.type)}` }
        var noteId = message.noteId
        if (typeof noteId !== 'string' || !noteId) return { ok: false, reason: "the message carried no note id" }
        var note = null
        try {
            note = await joplin.data.get(['notes', noteId], { fields: ['id', 'is_todo', 'todo_completed'] })
        } catch (error) {
            // An id the database does not know (the note was deleted between the render and the click) is a refusal,
            // not a failure: 'Not Found' is what the API throws for it.
            return { ok: false, reason: `the note ${noteId} could not be read` }
        }
        if (!note || !note.is_todo) return { ok: false, reason: "the note is not a to-do" }
        if (note.todo_completed) return { ok: false, reason: "the to-do is completed" }
        await openAlarmDialog([noteId])
        return { ok: true }
    } catch (error) {
        console.warn("Cockpit: the note title bar's alarm click could not be handled", error)
        return { ok: false, reason: "the alarm picker could not be opened" }
    }
}
