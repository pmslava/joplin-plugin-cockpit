/** README ******************************************************************************************************************************************
 * The set alarm dialog, opened by right clicking (or long pressing) a to-do in the panel. It sets the due date and time of every selected to-do at  *
 * once, or clears them. The date and time are plain ISO text fields (YYYY-MM-DD and 24 hour HH:MM) rather than a native datetime input, because     *
 * the native picker's format follows the application locale and cannot show ISO dates in English.                                                  *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";
import { setTodoDueTimestamps } from "../../core/joplin";
import { getDayStartTime } from "../../core/settings";
import { refreshInterfaces, scheduleRefresh } from "../../core/timer";

/** Variable Declaration ***************************************************************************************************************************/
var alarmDialog = null;

/** dialogCss ***************************************************************************************************************************************
 * The dialog's styles. They are inlined into the dialog markup rather than added as a stylesheet file, so that they are guaranteed to be in effect  *
 * when Joplin measures the content to size the dialog - a stylesheet that loads late leaves the dialog measured from unstyled content, which        *
 * clipped the calendar. The form width and calendar height are fixed for the same reason: the grid is drawn by a script after that measurement.     *
 ***************************************************************************************************************************************************/
const dialogCss = `
    /* Joplin sizes a fit-to-content dialog from this wrapper's bounding rect, but the wrapper just
     * stretches to the iframe, which starts at a 200px minimum - a feedback loop that keeps the
     * dialog 200px wide and clips everything past it. Setting the wrapper's width directly is the
     * one way to tell Joplin how wide this dialog is. */
    #joplin-plugin-content {
        width: 424px;
    }
    /* On a narrow (mobile) screen the fixed width would overflow, so the wrapper is allowed to shrink
     * there. Kept behind a media query so the desktop measurement stays an unconditional 424px and
     * never depends on the pre-sized 100vw, which the note above documents starts at a small minimum. */
    @media (max-width: 440px) {
        #joplin-plugin-content {
            width: calc(100vw - 16px);
        }
    }
    #alarmForm {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 6px 4px;
        width: 100%;
        max-width: 400px;
        box-sizing: border-box;
        font-size: var(--joplin-font-size, 13px);
    }
    #alarmBody {
        display: flex;
        flex-direction: row;
        gap: 10px;
    }
    #alarmFields {
        display: flex;
        flex-direction: row;
        gap: 6px;
    }
    #alarmFields input {
        padding: 4px 6px;
        font-family: inherit;
        font-size: inherit;
        color: inherit;
        background: none;
        border: 1px solid var(--joplin-divider-color, rgba(127, 127, 127, 0.4));
        border-radius: 3px;
        outline: none;
    }
    #alarmFields input:focus {
        border-color: var(--joplin-focus-outline-color, var(--joplin-url-color, #2D6BDC));
    }
    #alarmDate { width: 120px; }
    #alarmTime { width: 70px; }
    #alarmCalendar {
        flex: 1 1 auto;
        min-height: 245px;
    }
    #alarmTimePanel {
        display: flex;
        flex-direction: row;
        gap: 4px;
        flex-shrink: 0;
    }
    .alarm-time-col {
        width: 46px;
        height: 245px;
        overflow-y: auto;
    }
    .alarm-time-col::-webkit-scrollbar { width: 5px; }
    .alarm-time-col::-webkit-scrollbar-track { background: transparent; }
    .alarm-time-col::-webkit-scrollbar-thumb {
        border-radius: 3px;
        background: var(--joplin-scrollbar-thumb-color, rgba(127, 127, 127, 0.4));
    }
    .alarm-time-item {
        display: block;
        width: 100%;
        padding: 3px 0;
        text-align: center;
        font-family: inherit;
        font-size: inherit;
        color: inherit;
        background: none;
        border: 1px solid transparent;
        border-radius: 3px;
        cursor: pointer;
    }
    .alarm-time-item:hover { background-color: rgba(127, 127, 127, 0.2); }
    .alarm-time-item.-selected {
        background-color: var(--joplin-selected-color, rgba(127, 127, 127, 0.35));
        font-weight: 600;
    }
    #alarmQuick {
        display: flex;
        flex-direction: row;
        gap: 6px;
    }
    #alarmQuick button {
        padding: 3px 10px;
        font-family: inherit;
        font-size: inherit;
        color: inherit;
        background: none;
        border: 1px solid var(--joplin-divider-color, rgba(127, 127, 127, 0.4));
        border-radius: 3px;
        cursor: pointer;
    }
    #alarmQuick button:hover { background-color: rgba(127, 127, 127, 0.18); }
    .alarm-cal-nav {
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 4px;
    }
    .alarm-cal-nav button {
        min-width: 28px;
        padding: 2px 8px;
        font-family: inherit;
        font-size: inherit;
        color: inherit;
        background: none;
        border: none;
        border-radius: 3px;
        cursor: pointer;
    }
    .alarm-cal-nav button:hover { background-color: rgba(127, 127, 127, 0.18); }
    .alarm-cal-title { font-weight: 600; }
    .alarm-cal-grid {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
    }
    .alarm-cal-grid th {
        padding: 2px 0;
        font-size: 0.85em;
        font-weight: 600;
        opacity: 0.7;
        text-align: center;
    }
    .alarm-cal-grid td {
        padding: 1px;
        text-align: center;
    }
    .alarm-cal-day {
        width: 100%;
        padding: 4px 0;
        font-family: inherit;
        font-size: inherit;
        color: inherit;
        background: none;
        border: 1px solid transparent;
        border-radius: 3px;
        cursor: pointer;
    }
    .alarm-cal-day:hover { background-color: rgba(127, 127, 127, 0.2); }
    .alarm-cal-day.-outside { opacity: 0.35; }
    .alarm-cal-day.-today {
        border-color: var(--joplin-url-color, #2D6BDC);
        font-weight: 700;
    }
    .alarm-cal-day.-selected {
        background-color: var(--joplin-selected-color, rgba(127, 127, 127, 0.35));
    }
`

/** setupAlarmDialog ********************************************************************************************************************************
 * Creates the dialog in joplin. This must run once at plugin startup.                                                                              *
 ***************************************************************************************************************************************************/
export async function setupAlarmDialog(){
    alarmDialog = await joplin.views.dialogs.create('alarmDialog')
    await joplin.views.dialogs.addScript(alarmDialog, '/ui/alarm/alarmWebview.js')
    await joplin.views.dialogs.setButtons(alarmDialog, [
        { id: 'ok', title: 'OK' },
        { id: 'clear', title: 'Clear alarm' },
        { id: 'cancel', title: 'Cancel' },
    ])
}

/** openAlarmDialog *********************************************************************************************************************************
 * Opens the dialog for the given to-dos and applies the result. The fields start at the first to-do's current due time, or at the day start time    *
 * today when it has none.                                                                                                                          *
 ***************************************************************************************************************************************************/
export async function openAlarmDialog(todoIDs){
    if (!alarmDialog || !todoIDs.length) return

    var firstTodo = await joplin.data.get(['notes', todoIDs[0]], { fields: ['todo_due'] })
    var initial = new Date()
    if (firstTodo.todo_due && firstTodo.todo_due > 0){
        initial = new Date(firstTodo.todo_due)
    } else {
        var dayStart = await getDayStartTime()
        initial.setHours(dayStart.hours, dayStart.minutes, 0, 0)
    }
    var pad = value => String(value).padStart(2, "0")
    var initialDate = `${initial.getFullYear()}-${pad(initial.getMonth() + 1)}-${pad(initial.getDate())}`
    var initialTime = `${pad(initial.getHours())}:${pad(initial.getMinutes())}`
    var count = todoIDs.length === 1 ? "1 to-do" : `${todoIDs.length} to-dos`

    await joplin.views.dialogs.setHtml(alarmDialog, `
        <style>${dialogCss}</style>
        <form name="alarm" id="alarmForm">
            <strong>Set alarm for ${count}</strong>
            <div id="alarmFields">
                <input name="date" id="alarmDate" placeholder="YYYY-MM-DD" value="${initialDate}" oninput="onAlarmDateEdited()">
                <input name="time" id="alarmTime" placeholder="HH:MM" value="${initialTime}" oninput="onAlarmTimeEdited()">
            </div>
            <div id="alarmBody">
                <div id="alarmCalendar"></div>
                <div id="alarmTimePanel">
                    <div class="alarm-time-col" id="alarmHourCol"></div>
                    <div class="alarm-time-col" id="alarmMinuteCol"></div>
                </div>
            </div>
            <div id="alarmQuick">
                <button type="button" onclick="setAlarmDateOffset(0)">Today</button>
                <button type="button" onclick="setAlarmDateOffset(1)">Tomorrow</button>
                <button type="button" onclick="setAlarmDateOffset(7)">+1 week</button>
                <button type="button" title="Same weekday next month: the 2nd Saturday stays the 2nd Saturday" onclick="setAlarmDateNextMonth()">+month</button>
            </div>
        </form>
    `)

    var result = await joplin.views.dialogs.open(alarmDialog)
    if (!result || result.id === 'cancel') return

    var timestamp = 0
    if (result.id === 'ok'){
        var form = result.formData ? result.formData.alarm : null
        var parsed = parseAlarmFields(form ? form.date : null, form ? form.time : null)
        if (!parsed){
            await joplin.views.dialogs.showMessageBox("Cockpit: the alarm was not set. The date must be YYYY-MM-DD and the time HH:MM (24 hour).")
            return
        }
        timestamp = parsed.getTime()
    }

    await setTodoDueTimestamps(todoIDs, timestamp)
    await refreshInterfaces()
    // The moved to-dos only settle into their new groups once the search index has caught up.
    scheduleRefresh()
}

/** parseAlarmFields ********************************************************************************************************************************
 * Parses the two field values into a local Date, or null when they are not a real date and time. The check against the constructed date catches     *
 * values such as a 31st of February, which the Date constructor would otherwise silently roll into March.                                          *
 ***************************************************************************************************************************************************/
function parseAlarmFields(dateString, timeString){
    var dateMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(dateString || "").trim())
    var timeMatch = /^(\d{1,2}):(\d{2})$/.exec(String(timeString || "").trim())
    if (!dateMatch || !timeMatch) return null
    var year = Number(dateMatch[1]), month = Number(dateMatch[2]), day = Number(dateMatch[3])
    var hours = Number(timeMatch[1]), minutes = Number(timeMatch[2])
    if (hours > 23 || minutes > 59) return null
    var parsed = new Date(year, month - 1, day, hours, minutes, 0, 0)
    if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null
    return parsed
}
