/** README ******************************************************************************************************************************************
 * The set alarm dialog, opened by right clicking (or long pressing) a to-do in the panel. It sets the due date and time of every selected to-do at  *
 * once, or clears them. The date and time are plain ISO text fields (YYYY-MM-DD and 24 hour HH:MM) rather than a native datetime input, because     *
 * the native picker's format follows the application locale and cannot show ISO dates in English.                                                  *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api";
import { getTodoDues, setTodoDuesPerId } from "../../core/joplin";
import { getDayStartTime } from "../../core/settings";
import { refreshInterfaces, scheduleOverview, scheduleReconcile } from "../../core/timer";
import { openPluginDialog } from "../../core/dialog";
import { isMobile } from "../../core/platform";
// The multi-select engine and its explanation text live in the shared, unit-tested quick-button module (the same
// window.AlarmQuick the dialog webview and the mobile overlay call). Webpack bundles this UMD file into the host
// bundle here so the plugin computes the exact per-to-do values through the identical pure function the tests pin.
const { applyAlarmPlan } = require("./alarmQuick");

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
    /* On a narrow (mobile) screen the fixed 424px width would overflow, and the side-by-side calendar /
     * time layout crushes the 7-column calendar (below ~340px inner). The narrow layout is therefore
     * gated on a .cockpit-mobile marker class that the plugin adds - via the #cockpitPlatform marker
     * emitted into the dialog markup below - ONLY when running on mobile, and NEVER on a viewport
     * @media (max-width) query. A max-width media query would also match during Joplin's fit-to-content
     * measurement pass, which starts the dialog iframe at a ~200px minimum even on desktop: at that
     * moment a mobile-stacked layout would leak into the measured content and corrupt the final desktop
     * frame width. The marker class is absent on desktop, so the desktop measurement stays an
     * unconditional 424px, side-by-side layout, exactly as before mobile support was added. (The class
     * selectors also out-specify the base rules below, so their order among the base rules never
     * matters.) */
    #joplin-plugin-content.cockpit-mobile {
        width: calc(100vw - 16px);
    }
    /* Calendar on top, the hour/minute columns below it */
    .cockpit-mobile #alarmBody {
        flex-direction: column;
    }
    .cockpit-mobile #alarmTimePanel {
        justify-content: center;
    }
    .cockpit-mobile .alarm-time-col {
        /* Compact (~4-5 rows) so a stacked column under the 245px-min calendar does not make a very
         * tall dialog; the hour & minute lists share the full width instead of 46px each. */
        height: 132px;
        flex: 1 1 0;
        max-width: 120px;
    }
    #alarmForm {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 6px 4px;
        width: 100%;
        box-sizing: border-box;
        font-size: var(--joplin-font-size, 13px);
    }
    /* The row holding the calendar (always left) and the two time columns (always right). flex-wrap: nowrap
     * keeps them side by side under ANY width, including Joplin's ~200px fit-to-content measurement pass, so
     * they never stack. align-items: stretch is the whole mechanism for fix 1: the time panel (whose columns
     * carry no intrinsic height - see .alarm-time-col) stretches to exactly the calendar's rendered height,
     * whatever that is, with no fixed pixel height and no measurement. */
    #alarmBody {
        display: flex;
        flex-direction: row;
        flex-wrap: nowrap;
        gap: 10px;
        align-items: stretch;
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
    /* Reserve the grid's exact drawn height (see the .alarm-cal-* rules: 224px) at measurement time. Joplin
     * measures this fit-to-content dialog while #alarmCalendar is still EMPTY - before alarmWebview.js draws the
     * grid - and never re-measures, so without this the empty calendar measures 0 and the dialog ships ~224px too
     * short, clipping the grid. Because the drawn grid is deterministically 224px too, min-height == drawn height:
     * the align-items: stretch row keeps the time columns flush with the grid's bottom edge with no overshoot. */
    #alarmCalendar {
        flex: 1 1 auto;
        min-width: 0;
        min-height: 224px;
    }
    #alarmTimePanel {
        display: flex;
        flex-direction: row;
        gap: 4px;
        flex-shrink: 0;
    }
    /* Height-constraint wrapper (fix 1): it has no height of its own and its only child, the scroller, is
     * taken out of flow (position: absolute), so the column contributes nothing to #alarmBody's height. In
     * the align-items: stretch row it therefore stretches to the calendar's rendered height, and the absolute
     * scroller fills it via inset: 0 - so the hour/minute lists end exactly at the calendar's bottom edge for
     * a 5-week or a 6-week month alike. The internal scrolling is unchanged; it just lives on the scroller. */
    .alarm-time-col {
        position: relative;
        width: 46px;
    }
    .alarm-time-scroll {
        position: absolute;
        inset: 0;
        overflow-y: auto;
    }
    .alarm-time-scroll::-webkit-scrollbar { width: 5px; }
    .alarm-time-scroll::-webkit-scrollbar-track { background: transparent; }
    .alarm-time-scroll::-webkit-scrollbar-thumb {
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
    /* The quick buttons are two rows: row 1 the absolute dates (Today / Tomorrow / Weekends / Next Monday),
     * row 2 the accumulating increments (+hour / +day / +week / +month(day) / +month(date)). Each row carries an
     * EXPLICIT box-sizing height so Joplin's measure-before-draw pass (the buttons are static markup, present at
     * measurement) sizes the dialog to exactly the height the two rows occupy; flex-wrap: nowrap keeps each a single
     * line at the fixed 424px width, so neither row ever stacks into extra lines that would inflate the measurement.
     * This two-row reservation replaces the old single wrapping quick row. */
    #alarmQuick {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .alarm-quick-row {
        display: flex;
        flex-direction: row;
        flex-wrap: nowrap;
        gap: 6px;
        height: 28px;
        box-sizing: border-box;
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
    #alarmQuick button.-active {
        border-color: var(--joplin-url-color, #2D6BDC);
        background-color: var(--joplin-selected-color, rgba(127, 127, 127, 0.28));
        font-weight: 600;
    }
    /* The multi-select explanation line and mode picker are emitted ONLY for a multi-select dialog, but their heights
     * are RESERVED with a fixed box-sizing height so Joplin's measure-before-draw pass (which runs while the
     * explanation text is still empty - the webview fills it after) sizes the dialog to exactly the height the filled
     * rows will occupy. The explanation clips past two lines rather than growing, so the measured and drawn heights
     * can never diverge; a single-select dialog omits both rows entirely and is unchanged. Both rows reuse the quick
     * buttons' font-size (inherit, i.e. #alarmForm's var(--joplin-font-size, 13px)) rather than a smaller literal, so
     * the explanation, the mode labels and the quick buttons all render at one size. That larger text makes two
     * explanation lines 13*1.35*2 = 35.1px, so the reservation is 38px (was 34px at the old 0.9em); the mode picker
     * stays a single line well within its 26px. */
    #alarmExplain {
        height: 38px;
        box-sizing: border-box;
        overflow: hidden;
        font-size: inherit;
        line-height: 1.35;
        opacity: 0.75;
    }
    #alarmMode {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 16px;
        height: 26px;
        box-sizing: border-box;
        font-size: inherit;
    }
    #alarmMode label {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 5px;
        cursor: pointer;
    }
    #alarmMode input { margin: 0; cursor: pointer; }
    /* Every calendar row carries an EXPLICIT box-sizing: border-box height so the drawn grid is a fixed pixel
     * total independent of the font's line-height metrics: nav 30 + its 4 margin + weekday row 22 + six week
     * rows of 28 = 224px. That constant is what #alarmCalendar reserves as its min-height below, so the empty
     * dialog Joplin measures is exactly as tall as the populated grid it will later draw (no clip, no overshoot). */
    .alarm-cal-nav {
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 4px;
        height: 30px;
        box-sizing: border-box;
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
        height: 22px;
        box-sizing: border-box;
        padding: 0;
        font-size: 0.85em;
        font-weight: 600;
        opacity: 0.7;
        text-align: center;
    }
    .alarm-cal-grid td {
        height: 28px;
        box-sizing: border-box;
        padding: 1px;
        text-align: center;
    }
    .alarm-cal-day {
        display: block;
        width: 100%;
        height: 26px;
        box-sizing: border-box;
        padding: 0;
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
    // The shared quick-button math (window.AlarmQuick) is loaded first, so it exists before alarmWebview.js wires
    // the buttons to it. The same file backs the mobile overlay (panel.addScript) and the Node unit tests.
    await joplin.views.dialogs.addScript(alarmDialog, '/ui/alarm/alarmQuick.js')
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

    var fields = await computeInitialAlarm(todoIDs)
    var initialDate = fields.date
    var initialTime = fields.time
    var hadAlarm = fields.hasAlarm
    var multi = todoIDs.length > 1
    var count = todoIDs.length === 1 ? "1 to-do" : `${todoIDs.length} to-dos`

    // Every selected to-do's current due, so the webview can describe the plan (which to-dos keep their own time,
    // which have no alarm) above the calendar. The host re-reads these fresh at OK time; this copy only feeds the
    // explanation line. Carried in a JSON island (like the panel's search-data island) rather than in each input.
    var dues = await getTodoDues(todoIDs)
    var initData = JSON.stringify({ multi: multi, hasAlarm: hadAlarm, dues: dues }).replace(/</g, "\\u003c")

    // A hidden marker carried in the markup on mobile only. alarmWebview.js reads it and adds the
    // cockpit-mobile class to the persistent #joplin-plugin-content wrapper, which is what the narrow
    // layout in dialogCss is gated on. Empty on desktop, so the desktop markup, DOM and measured width
    // are untouched. This mirrors the panel's #cockpitPlatform marker pattern.
    var mobile = await isMobile()
    var rootMarker = mobile ? '<div id="cockpitPlatform" hidden></div>' : ''

    // Layout order (owner rework): fields -> quick buttons (above the calendar) -> calendar+columns -> mode picker
    // (multi only, fixed reserved height) -> explanation line (multi only, fixed reserved height, moved below the mode
    // picker) -> footer (the native OK / Clear / Cancel buttons). A single-select dialog omits the explanation and mode
    // rows, so its markup, DOM and measured height are byte-identical to 1.8.3 apart from the quick row moving up.
    var explainRow = multi ? '<div id="alarmExplain"></div>' : ''
    // The mode picker is real radio inputs so the chosen mode rides back in formData; RESPECT is the default for a
    // multi selection. onchange re-describes the plan without losing the pressed button. Omitted for single-select.
    var modeRow = multi ? `
            <div id="alarmMode">
                <label><input type="radio" name="mode" value="respect" checked onchange="onAlarmModeChanged()"> Keep each to-do's own schedule</label>
                <label><input type="radio" name="mode" value="same" onchange="onAlarmModeChanged()"> Same date &amp; time for all</label>
            </div>` : ''
    // The active plan (last quick button pressed, or 'anchor' for a manual pick) rides back to the host in this
    // hidden field; the webview keeps it current. Single-select never varies the plan, so the field is multi-only.
    var planField = multi ? '<input type="hidden" name="plan" id="alarmPlan" value="anchor">' : ''

    await joplin.views.dialogs.setHtml(alarmDialog, `
        <style>${dialogCss}</style>
        ${rootMarker}
        <script type="application/json" id="alarmInitData">${initData}</script>
        <form name="alarm" id="alarmForm">
            <strong>Set alarm for ${count}</strong>
            ${planField}
            <div id="alarmFields">
                <input name="date" id="alarmDate" placeholder="YYYY-MM-DD" value="${initialDate}" oninput="onAlarmDateEdited()"
                    inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
                <input name="time" id="alarmTime" placeholder="HH:MM" value="${initialTime}" oninput="onAlarmTimeEdited()"
                    inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
            </div>
            <div id="alarmQuick">
                <div class="alarm-quick-row">
                    <button type="button" onclick="onAlarmQuickToday()">Today</button>
                    <button type="button" onclick="onAlarmQuickTomorrow()">Tomorrow</button>
                    <button type="button" title="The nearest Saturday (today if today is Saturday)" onclick="onAlarmQuickWeekends()">Weekends</button>
                    <button type="button" title="The Monday after today" onclick="onAlarmQuickNextMonday()">Next Monday</button>
                </div>
                <div class="alarm-quick-row">
                    <button type="button" title="Add one hour (may cross midnight)" onclick="onAlarmQuickHour()">+hour</button>
                    <button type="button" title="Add one day" onclick="onAlarmQuickDay()">+day</button>
                    <button type="button" onclick="onAlarmQuickWeek()">+week</button>
                    <button type="button" title="Same weekday next month: the 2nd Sunday stays the 2nd Sunday" onclick="onAlarmQuickMonthWeekday()">+month(day)</button>
                    <button type="button" title="Same day-of-month next month: Jan 9 stays the 9th (Jan 31 clamps to the last day)" onclick="onAlarmQuickMonthDate()">+month(date)</button>
                </div>
            </div>
            <div id="alarmBody" class="alarm-stretch-row">
                <div id="alarmCalendar"></div>
                <div id="alarmTimePanel">
                    <div class="alarm-time-col"><div class="alarm-time-scroll" id="alarmHourCol"></div></div>
                    <div class="alarm-time-col"><div class="alarm-time-scroll" id="alarmMinuteCol"></div></div>
                </div>
            </div>
            ${modeRow}
            ${explainRow}
        </form>
    `)

    var result = await openPluginDialog(alarmDialog)
    if (!result || result.id === 'cancel'){
        // Nothing changed, but on mobile the dialog guard in refreshPanelData drops every refresh that
        // came due while this dialog was open (e.g. a reconcile-lane poll from a to-do just
        // checked, or the periodic day-boundary tick). Cancelling clears the guard but arms no new
        // refresh, so the panel could stay stale until the next tick. Repaint once here to pick up
        // whatever was skipped. Desktop never skips refreshes, so it keeps its no-op cancel untouched.
        if (mobile) await refreshInterfaces()
        return
    }

    if (result.id === 'ok'){
        var form = result.formData ? result.formData.alarm : null
        var anchorDate = form ? form.date : null
        var anchorTime = form ? form.time : null
        // The anchor still passes the same strict validation (rejecting e.g. Feb 31 with the same message), so a
        // bad field aborts before any write, exactly as in 1.8.3.
        var parsed = parseAlarmFields(anchorDate, anchorTime)
        if (!parsed){
            await joplin.views.dialogs.showMessageBox("Cockpit: the alarm was not set. The date must be YYYY-MM-DD and the time HH:MM (24 hour).")
            return
        }
        // Single-select has no mode/plan fields -> mode 'same', plan 'anchor', which applies the one anchor datetime
        // to the one to-do: byte-identical to 1.8.3. A multi dialog carries the chosen mode and last-pressed plan.
        var mode = form && form.mode === "same" ? "same" : (form && form.mode === "respect" ? "respect" : "same")
        var plan = form && form.plan ? String(form.plan) : "anchor"
        await applyAlarmPlanResult(todoIDs, plan, { date: anchorDate, time: anchorTime }, mode)
        return
    }

    // 'clear': remove every selected to-do's alarm.
    await setTodoDuesPerId(todoIDs.map(id => ({ id, due: 0 })))
    await afterAlarmWrite()
}

/** applyAlarmPlanResult ****************************************************************************************************************************
 * Turns the picker's plan + mode + anchor into the final per-to-do due timestamps and writes them. The current dues are re-read FRESH here (not      *
 * taken from the webview) so the plan shifts each to-do from its true present schedule, then the shared pure applyAlarmPlan computes the result and    *
 * setTodoDuesPerId lands it. Shared by the desktop dialog OK and the mobile overlay's alarmSet.                                                       *
 ***************************************************************************************************************************************************/
async function applyAlarmPlanResult(todoIDs, plan, anchor, mode){
    var todos = await getTodoDues(todoIDs)
    var results = applyAlarmPlan(todos, plan, anchor, mode, new Date())
    await setTodoDuesPerId(results)
    await afterAlarmWrite()
}

/** afterAlarmWrite *********************************************************************************************************************************
 * The refresh sequence every alarm write ends with: repaint now, then let the reconcile and overview lanes catch up once the search index settles.   *
 ***************************************************************************************************************************************************/
async function afterAlarmWrite(){
    await refreshInterfaces()
    scheduleReconcile()
    scheduleOverview()
}

/** computeInitialAlarm *****************************************************************************************************************************
 * The date (YYYY-MM-DD) and time (HH:MM) the picker should start at for the given to-dos: the first to-do's current due time, or the day start time   *
 * today when it has none. Shared by the desktop alarm dialog and the mobile alarm overlay (via the getAlarmInitial round-trip) so both start the same. *
 ***************************************************************************************************************************************************/
async function computeInitialAlarm(todoIDs){
    var firstTodo = await joplin.data.get(['notes', todoIDs[0]], { fields: ['todo_due'] })
    var initial = new Date()
    // hasAlarm records whether the FIRST selected to-do already had a due time - the same source the picker's
    // starting time is read from. The quick buttons use it to decide preservedTime: with a multi-select, this
    // means the whole selection follows the first to-do's alarm (its time is kept; if it has none, the buttons
    // substitute ceilHour(now) even when a later selected to-do does have an alarm).
    var hasAlarm = false
    if (firstTodo.todo_due && firstTodo.todo_due > 0){
        initial = new Date(firstTodo.todo_due)
        hasAlarm = true
    } else {
        var dayStart = await getDayStartTime()
        initial.setHours(dayStart.hours, dayStart.minutes, 0, 0)
    }
    var pad = value => String(value).padStart(2, "0")
    return {
        date: `${initial.getFullYear()}-${pad(initial.getMonth() + 1)}-${pad(initial.getDate())}`,
        time: `${pad(initial.getHours())}:${pad(initial.getMinutes())}`,
        hasAlarm,
    }
}

/** getAlarmInitialFields ***************************************************************************************************************************
 * Round-trip target for the mobile alarm overlay: returns the { date, time, hasAlarm } the overlay should prefill with, plus whether the selection    *
 * is multi and each to-do's current due (so the overlay can describe the plan exactly like the desktop dialog's JSON island). Empty for no selection. *
 ***************************************************************************************************************************************************/
export async function getAlarmInitialFields(todoIDs){
    if (!Array.isArray(todoIDs) || !todoIDs.length) return { date: "", time: "", hasAlarm: false, multi: false, dues: [] }
    var initial = await computeInitialAlarm(todoIDs)
    return { ...initial, multi: todoIDs.length > 1, dues: await getTodoDues(todoIDs) }
}

/** applyAlarmSet ***********************************************************************************************************************************
 * Applies the mobile alarm overlay's OK result: validates the anchor field strings (rejecting an impossible date/time with the same message the        *
 * dialog shows), then applies the chosen plan + mode through the shared engine - the same path the desktop dialog OK takes. mode/plan are optional so   *
 * an older overlay descriptor (no mode/plan) degrades to the 1.8.3 "same datetime for all" behaviour.                                                   *
 ***************************************************************************************************************************************************/
export async function applyAlarmSet(todoIDs, dateString, timeString, mode?, plan?){
    if (!Array.isArray(todoIDs) || !todoIDs.length) return
    var parsed = parseAlarmFields(dateString, timeString)
    if (!parsed){
        await joplin.views.dialogs.showMessageBox("Cockpit: the alarm was not set. The date must be YYYY-MM-DD and the time HH:MM (24 hour).")
        return
    }
    var resolvedMode = mode === "respect" ? "respect" : "same"
    // The plan may be an absolute string OR the row-2 accumulator object (posted straight from the overlay); the
    // shared applyAlarmPlan accepts either, so pass it through untouched rather than stringifying the object.
    var resolvedPlan = plan != null && plan !== "" ? plan : "anchor"
    await applyAlarmPlanResult(todoIDs, resolvedPlan, { date: dateString, time: timeString }, resolvedMode)
}

/** applyAlarmCleared *******************************************************************************************************************************
 * Applies the mobile alarm overlay's "Clear alarm" result: clears the due time of every selected to-do (timestamp 0), then refreshes.                 *
 ***************************************************************************************************************************************************/
export async function applyAlarmCleared(todoIDs){
    if (!Array.isArray(todoIDs) || !todoIDs.length) return
    await setTodoDuesPerId(todoIDs.map(id => ({ id, due: 0 })))
    await afterAlarmWrite()
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
