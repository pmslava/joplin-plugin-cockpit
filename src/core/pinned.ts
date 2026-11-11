/** README ******************************************************************************************************************************************
 * Pin (2.11, docs/BRIEF-2.11-dates-pins-drag.md section 2). The owner asked for a Pin in the row menu whose effect a setting picks - Cockpit's    *
 * own Pinned section, the Note Tabs plugin's pinned tabs, or both - and for pinned notes and to-dos to be visible in every profile, whatever the  *
 * profile.                                                                                                                                        *
 *                                                                                                                                                 *
 * COCKPIT'S PINS are a per-device setting (pinnedNoteIds, a JSON array in pin order), not a profile field and not a tag: a tag write moves        *
 * Joplin's note-list selection, and a profile field would make the pin the profile's. The Pinned section is drawn from that list alone, above     *
 * everything the formatter draws, in every format: no profile criteria, notebook filter, search text or quick filter narrows it. The one boundary *
 * it keeps is the Excluded notebooks setting - a pin in an excluded notebook is kept but not drawn, since that setting means "never show me this" *
 * everywhere. A pin whose note is gone (Not Found) or in the trash is dropped from the setting the first time a render finds it so, silently. The *
 * overview markdown never draws it: only the panel's render calls withPinnedSection.                                                              *
 *                                                                                                                                                 *
 * THE MARKUP IS THE WEBVIEW'S ONLY SOURCE: every row of a pinned note carries data-pinned="1" - in the section and wherever else it is drawn -    *
 * and the list carries the pin target as data-pin-target when it is not the default, so the row menu (noteMenu.js) labels Pin / Unpin without     *
 * asking the host. Both are added only when there is something to say, so a device with no pins and the default target draws the markup it drew   *
 * before.                                                                                                                                         *
 *                                                                                                                                                 *
 * NOTE TABS is another plugin: its tabsPinNote / tabsUnpinNote take an ARRAY of ids (Note Tabs walks its argument as a list), and a call into it  *
 * is not an own write - no startOwnWrite bracket, as Jot's calls have none. Joplin's refusal of a command nobody declares ("Command not found",   *
 * "No such command") or whose plugin is off ("without a runtime") means Note Tabs is absent; the user is told once a session, in the panel's      *
 * toast, never a dialog (a plugin dialog draws behind the panel on Android, and a modal is too heavy to repeat on every press). Mobile pins into  *
 * Cockpit's section whatever the setting says.                                                                                                    *
 *                                                                                                                                                 *
 * THE SANDBOX PROXY RULE: every joplin.* member is read and called in one expression.                                                             *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api"
import { escapeHtml } from "./html"
import { renderNoteRowHtml, renderTodoRowHtml } from "./formats"
import { attachCheckboxCounts, getExcludedNotebookIdSet, getNotebookMap, listingFields } from "./joplin"
import { getModel as getStoreModel, isReady as isStoreReady } from "./noteStore"
import { getPinTarget, getPinnedNoteIds, setPinnedNoteIds } from "./settings"

/** The panel toast that says Note Tabs is missing, and whether it has been said in this run of the plugin. */
export const NOTE_TABS_MISSING_TOAST = "Cockpit: the Note Tabs plugin is not installed or is off."
var noteTabsMissingTold = false

/** pinTargetFor ************************************************************************************************************************************
 * The target a pin goes to on this platform: the setting's on desktop, Cockpit's own section on mobile whatever the setting says - the phone has  *
 * no Note Tabs to call, and the setting's description promises exactly that.                                                                      *
 ***************************************************************************************************************************************************/
export async function pinTargetFor(mobile){
    return mobile ? "cockpit" : await getPinTarget()
}

/** pinTargetAttribute ******************************************************************************************************************************
 * The attribute the list (.todos) carries for the row menu's labels: data-pin-target with the target, or nothing for the default - Cockpit's      *
 * section, which is also what mobile always uses - so that the default markup is byte-identical to the markup before 2.11.                        *
 ***************************************************************************************************************************************************/
export async function pinTargetAttribute(mobile){
    var target = await pinTargetFor(mobile)
    return target === "cockpit" ? "" : ` data-pin-target="${escapeHtml(target)}"`
}

/** applyPinChange **********************************************************************************************************************************
 * The row menu's Pin or Unpin for the ids of the selection (the panel's pinNotes / unpinNotes messages). Cockpit's section, when the target names *
 * it, appends the ids not already pinned, in selection order, or takes the ids out; Note Tabs, when the target names it, is called with the ids   *
 * as an array. With "both" Cockpit's change always applies and Note Tabs' when it can. Answers whether Cockpit's pins changed, which is when the  *
 * panel has something new to draw; notify is the panel's toast (notifyPanel).                                                                     *
 ***************************************************************************************************************************************************/
export async function applyPinChange(ids: string[], pin: boolean, mobile: boolean, notify: (text: string) => void){
    if (!Array.isArray(ids) || !ids.length) return false
    var target = await pinTargetFor(mobile)
    var changed = false
    if (target === "cockpit" || target === "both") changed = await changeCockpitPins(ids, pin)
    if (target === "noteTabs" || target === "both") await callNoteTabs(pin ? "tabsPinNote" : "tabsUnpinNote", ids, notify)
    return changed
}

/** pinInCockpit ************************************************************************************************************************************
 * Another plugin's pin (cockpit.pinNotes, 2.11.1, docs/BRIEF-2.11-dates-pins-drag.md section 8): the ids appended to Cockpit's own pin list by    *
 * the write the row menu's Pin makes, whatever the pin target says - the caller has already chosen where it pins, so Note Tabs is never called    *
 * from here. An id already pinned stays where it is; an id whose note is not there (yet, or any more) is pinned all the same and left to the      *
 * section's pruning. Answers whether the list changed and the list as it now stands, read in the same queue as the write.                         *
 ***************************************************************************************************************************************************/
export async function pinInCockpit(ids: string[]){
    var changed = await changeCockpitPins(ids, true)
    var pinned = await serialisePins(() => getPinnedNoteIds())
    return { changed: changed, pinned: pinned }
}

/** serialisePins ***********************************************************************************************************************************
 * Runs one read-modify-write of Cockpit's pin list after every one queued before it. changeCockpitPins and forgetPins each read the setting and   *
 * write it back a settings round trip later, and a Pin landing between a prune's read and its write was written away by it. One chain for both,  *
 * so each reads what the one before wrote. A failure still reaches its own caller, but the chain itself swallows it, so it never sticks.         *
 ***************************************************************************************************************************************************/
var pinQueue: Promise<unknown> = Promise.resolve()

function serialisePins<T>(work: () => Promise<T>): Promise<T> {
    var run = pinQueue.then(work)
    pinQueue = run.catch(() => undefined)
    return run
}

/** changeCockpitPins *******************************************************************************************************************************
 * Writes Cockpit's pin list with the ids added (at the end, in the order given) or removed. Nothing is written when nothing changes, so a Pin of  *
 * a row already pinned costs no write and no render. Queued with forgetPins (serialisePins).                                                      *
 ***************************************************************************************************************************************************/
async function changeCockpitPins(ids: string[], pin: boolean){
    return serialisePins(async () => {
        var current = await getPinnedNoteIds()
        var next = pin
            ? current.concat(ids.filter((id, index) => !current.includes(id) && ids.indexOf(id) === index))
            : current.filter(id => !ids.includes(id))
        if (next.length === current.length && next.every((id, index) => id === current[index])) return false
        await setPinnedNoteIds(next)
        return true
    })
}

/** callNoteTabs ************************************************************************************************************************************
 * One call of Note Tabs' tabsPinNote or tabsUnpinNote with the ids as an ARRAY (a bare id would be walked one character at a time). Never throws: *
 * an absent Note Tabs is said once a session in the panel's toast and answers "absent"; any other refusal is Note Tabs' own, logged and nothing   *
 * else. Its absence is never remembered - the plugin may be installed or switched on later in the session, and a miss costs one call.             *
 ***************************************************************************************************************************************************/
async function callNoteTabs(command: string, ids: string[], notify: (text: string) => void){
    try {
        await joplin.commands.execute(command, ids.slice())
        return "done"
    } catch (error) {
        if (/command not found|no such command|without a runtime/i.test(String((error && error.message) || error))){
            console.warn(`Cockpit: Note Tabs is not installed or is off, so ${command} was not run`, error)
            if (!noteTabsMissingTold){
                noteTabsMissingTold = true
                notify(NOTE_TABS_MISSING_TOAST)
            }
            return "absent"
        }
        console.warn(`Cockpit: Note Tabs' ${command} failed`, error)
        return "failed"
    }
}

/** withPinnedSection *******************************************************************************************************************************
 * The panel's list markup with the Pinned section in front of it and every row of a pinned note marked data-pinned="1". The panel's render calls  *
 * it once, on the finished list (the formatter's groups, the Notes section, the peeks), so the section is the first thing in every format - above *
 * the Overdue heading, a calendar's navigation and a "before" Notes section alike. With no pins it answers the list untouched after one setting   *
 * read.                                                                                                                                           *
 ***************************************************************************************************************************************************/
export async function withPinnedSection(listHtml: string, profile, viewState){
    var ids = await getPinnedNoteIds()
    if (!ids.length) return listHtml
    var section = await renderPinnedSection(ids, viewState, profile)
    return markPinnedRows(section + listHtml, ids)
}

/** markPinnedRows **********************************************************************************************************************************
 * Adds data-pinned="1" right after the id attribute of every row of a pinned note - a to-do row, a week card and a note row are the only elements *
 * that carry data-todo-id / data-note-id - so the webview can tell a pinned row wherever it is drawn. Nothing is touched when nothing is pinned.  *
 ***************************************************************************************************************************************************/
export function markPinnedRows(html: string, ids: string[]){
    if (!ids || !ids.length) return html
    var pinned = new Set(ids)
    return html.replace(/ data-(todo|note)-id="([^"]*)"/g, (match, kind, id) => pinned.has(id) ? `${match} data-pinned="1"` : match)
}

/** renderPinnedSection *****************************************************************************************************************************
 * The Pinned section for the ids in pin order: `<section class="pinned-section" data-group="pinned"><h2>Pinned</h2>…rows…</section>`, or "" when  *
 * no pin has anything to draw. Each record comes from the note store when it is ready and holds the note, else from one GET; a pin whose note is  *
 * gone or trashed is dropped from the setting (forgetPins) and a pin in an excluded notebook is skipped but kept. The rows are the platform's     *
 * ordinary rows - a to-do ticks and drags onto a date target, a note opens - with the notebook pill and the checkbox ring attached as everywhere  *
 * else; a to-do's label is the Interval format's Overdue/Future label (the date, in the profile's date format) with the time after it. The group  *
 * takes no between-drop (betweenGroupInfo in panelWebview.js), and the panel does not count it as content for the empty-view peek.                *
 ***************************************************************************************************************************************************/
export async function renderPinnedSection(ids: string[], viewState, profile?){
    if (!ids || !ids.length) return ""
    var records = []
    var gone = []
    for (var id of ids){
        var read = await readPinnedRecord(id)
        if (read.gone) gone.push(id)
        else if (read.record) records.push(read.record)
    }
    if (gone.length) await forgetPins(gone)
    var excluded = await getExcludedNotebookIdSet()
    records = records.filter(record => !excluded.has(record.parent_id))
    if (!records.length) return ""
    var notebooks = await getNotebookMap()
    for (var record of records){
        var notebook = notebooks.get(record.parent_id)
        record.notebookTitle = notebook ? notebook.title : ""
        record.notebookPath = notebook ? notebook.path : ""
    }
    await attachCheckboxCounts(records, viewState ? !!viewState.fastCheckboxCounts : false)
    var mobile = !!(viewState && viewState.isMobile)
    var rows = records.map(record => Number(record.is_todo) === 1
        ? renderTodoRowHtml(record, pinnedTodoLabel(record, profile), { mobile: mobile, draggable: true, nativeDrag: !mobile })
        : renderNoteRowHtml(record, { mobile: mobile })
    ).join("")
    return `
        <section class="pinned-section" data-group="pinned">
            <h2>Pinned</h2>
            ${rows}
        </section>
    `
}

/** readPinnedRecord ********************************************************************************************************************************
 * One pin's record: { record } to draw, { gone: true } for a note that is Not Found or in the trash, or {} when the read failed some other way    *
 * (the pin is kept and simply not drawn this time). A ready note store answers without a call; a note it does not hold is asked of the data API   *
 * before the pin is dropped, since only the API can say the note is really gone.                                                                  *
 ***************************************************************************************************************************************************/
async function readPinnedRecord(id: string): Promise<{ record?: any, gone?: boolean }> {
    if (isStoreReady()){
        var stored = getStoreModel().get(id)
        if (stored) return { record: stored }
    }
    try {
        var note = await joplin.data.get(["notes", id], { fields: listingFields })
        if (!note || Number(note.deleted_time) > 0) return { gone: true }
        return { record: { ...note, id: id } }
    } catch (error) {
        if (String((error && error.message) || error).indexOf("Not Found") >= 0) return { gone: true }
        console.warn("Cockpit: a pinned note could not be read", error)
        return {}
    }
}

/** forgetPins **************************************************************************************************************************************
 * Drops the given ids from Cockpit's pins. The list is read again rather than taken from the render that found them gone, so a pin made while     *
 * that render was reading is not written away with them; and the read and the write are queued with changeCockpitPins (serialisePins), so a pin  *
 * made between the two is not either.                                                                                                             *
 ***************************************************************************************************************************************************/
async function forgetPins(gone: string[]){
    return serialisePins(async () => {
        var current = await getPinnedNoteIds()
        var next = current.filter(id => !gone.includes(id))
        if (next.length !== current.length) await setPinnedNoteIds(next)
    })
}

/** pinnedTodoLabel *********************************************************************************************************************************
 * A pinned to-do's label. The section has no date headings, so the row says its own: the date as the Interval format's Overdue and Future rows    *
 * say it (the profile's year, month and day formats), then the time; an undated to-do is its title alone.                                         *
 ***************************************************************************************************************************************************/
function pinnedTodoLabel(todo, profile){
    var due = Number(todo.todo_due) || 0
    if (due <= 0) return todo.title
    var formats = profile || {}
    var date = new Date(due).toLocaleDateString(undefined, { year: formats.yearFormat, month: formats.monthFormat, day: formats.dayFormat })
    var time = new Date(due).toLocaleTimeString(undefined, { hour: "numeric", minute: "numeric", hour12: formats.timeIs12Hour })
    return `${date} ${time} - ${todo.title}`
}
