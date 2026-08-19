/** README ******************************************************************************************************************************************
 * The calendar picker of the set alarm dialog. It is drawn here rather than with a native datetime input, because the native picker's format        *
 * follows the application locale and cannot show ISO dates with English names. The week always starts on Monday.                                   *
 ***************************************************************************************************************************************************/

/** The first day of the month the calendar is showing. Reset from the date field every time the dialog is (re)opened. */
var alarmCalendarAnchor = null

/** Whether the selected to-do(s) already had an alarm when the dialog opened (read from the #alarmInitData island the
 * host emits), and whether the user has set the time this session (typed it or picked an hour/minute). Together they
 * drive preservedTime: a quick button keeps the shown clock time when EITHER is true, and substitutes ceilHour(now)
 * only when BOTH are false (a fresh picker with an untouched time). Both reset on every (re)open. */
var alarmHadExistingAlarm = false
var alarmTimeUserSet = false

/** Multi-select plan state. A single-select dialog leaves these at their defaults and never shows a plan/mode; only a
 * multi-select dialog carries the mode picker + explanation line. alarmMode is 'respect' (each to-do keeps its own
 * schedule; the accumulator shifts from its own datetime) by default or 'same' (one datetime for all, the 1.8.3
 * behaviour). alarmActivePlan is EITHER an absolute string ('today'/'tomorrow'/'weekends'/'nextMonday'/'anchor') or the
 * row-2 accumulator OBJECT {hours,days,weeks,monthsDay,monthsDate}; an absolute press or manual pick resets it to a
 * string, discarding the accumulator. alarmTodoDues is every selected to-do's current { id, due } (from the island),
 * which the shared describeAlarmPlan reads to word the explanation. All reset on every (re)open from the island. */
var alarmIsMulti = false
var alarmMode = 'same'
var alarmActivePlan = 'anchor'
var alarmTodoDues = []

function alarmPad(value){
    return String(value).padStart(2, '0')
}

function alarmDateToISO(date){
    return `${date.getFullYear()}-${alarmPad(date.getMonth() + 1)}-${alarmPad(date.getDate())}`
}

function alarmParseISO(value){
    var match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(value || '').trim())
    if (!match) return null
    var parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    if (parsed.getFullYear() !== Number(match[1]) || parsed.getMonth() !== Number(match[2]) - 1 || parsed.getDate() !== Number(match[3])) return null
    return parsed
}

/** Quick buttons ***********************************************************************************************************************************
 * Two rows: row 1 the absolute dates (Today / Tomorrow / Weekends / Next Monday), row 2 the accumulating increments   *
 * (+hour / +day / +week / +month(day) / +month(date)). The date/time math lives in the shared, unit-tested            *
 * window.AlarmQuick module (alarmQuick.js, loaded into this dialog before this script); these thin wrappers only read *
 * the DOM for the button arguments and write the result back. Both this dialog and the mobile overlay wire the        *
 * identical buttons to the same functions, so the math is never forked.                                               *
 ***************************************************************************************************************************************************/

// The date the +week / +month buttons walk forward from: the date field's value, or today when it is empty/invalid.
// Repeated presses walk forward because each press writes the field the next press reads.
function alarmBaseDate(){
    return alarmParseISO(document.getElementById('alarmDate').value) || new Date()
}

// The clock time a quick button should keep ({hours,minutes}), or null when it should substitute ceilHour(now).
// Non-null only when the to-do already had an alarm at open, or the user set the time this session.
function alarmPreservedTime(){
    if (!alarmHadExistingAlarm && !alarmTimeUserSet) return null
    var time = currentAlarmTime()
    if (time.hours === null || time.minutes === null) return null
    return { hours: time.hours, minutes: time.minutes }
}

// Write an { date, time } result from AlarmQuick into the two fields and re-sync the calendar month + time highlight.
function applyAlarmQuick(result){
    document.getElementById('alarmDate').value = result.date
    document.getElementById('alarmTime').value = result.time
    var parsed = alarmParseISO(result.date)
    if (parsed) alarmCalendarAnchor = new Date(parsed.getFullYear(), parsed.getMonth(), 1)
    renderAlarmCalendar()
    updateAlarmTimeSelection()
}

// An ABSOLUTE (row-1) button press. It sets the plan to the absolute string, which RESETS any accumulator. In a
// multi-select dialog under RESPECT mode it only chooses the plan (each to-do keeps its own time, landing on the
// absolute date), so the anchor fields are left untouched and the explanation is re-worded; in single-select or SAME
// mode it writes the anchor fields, exactly like 1.8.3. Either way the active plan is remembered and highlighted.
function runAlarmQuick(plan, quickResult){
    setAlarmActivePlan(plan)
    if (!(alarmIsMulti && alarmMode === 'respect')) applyAlarmQuick(quickResult)
    updateAlarmPlanDescription()
}

// The single-increment field result for one row-2 press (single-select / SAME): read the current field date+time and
// apply exactly one increment of `key`, so repeated presses compound naturally through the fields.
function alarmAccumulatorFieldPress(key){
    var now = new Date(), base = alarmBaseDate(), preserved = alarmPreservedTime()
    if (key === 'hours') return AlarmQuick.hour(now, base, preserved)
    if (key === 'days') return AlarmQuick.day(now, base, preserved)
    if (key === 'weeks') return AlarmQuick.week(now, base, preserved)
    if (key === 'monthsDay') return AlarmQuick.monthWeekday(now, base, preserved)
    return AlarmQuick.monthDate(now, base, preserved)
}

// A row-2 ACCUMULATOR press. In a multi-select dialog under RESPECT mode it only accumulates the increment (each to-do
// shifts from its own schedule), leaving the anchor fields untouched; in single-select or SAME mode it also writes the
// anchor fields (one increment per press, compounding). The accumulator plan is remembered and its buttons highlighted.
function runAlarmAccumulator(key){
    setAlarmActivePlan(AlarmQuick.accumulate(alarmActivePlan, key))
    if (!(alarmIsMulti && alarmMode === 'respect')){
        applyAlarmQuick(alarmAccumulatorFieldPress(key))
        if (key === 'hours') alarmTimeUserSet = true    // so the next +hour keeps this time and compounds
    }
    updateAlarmPlanDescription()
}

function onAlarmQuickToday(){ runAlarmQuick('today', AlarmQuick.today(new Date())) }
function onAlarmQuickTomorrow(){ runAlarmQuick('tomorrow', AlarmQuick.tomorrow(new Date(), alarmPreservedTime())) }
function onAlarmQuickWeekends(){ runAlarmQuick('weekends', AlarmQuick.weekends(new Date(), alarmPreservedTime())) }
function onAlarmQuickNextMonday(){ runAlarmQuick('nextMonday', AlarmQuick.monday(new Date(), alarmPreservedTime())) }

function onAlarmQuickHour(){ runAlarmAccumulator('hours') }
function onAlarmQuickDay(){ runAlarmAccumulator('days') }
function onAlarmQuickWeek(){ runAlarmAccumulator('weeks') }
function onAlarmQuickMonthWeekday(){ runAlarmAccumulator('monthsDay') }
function onAlarmQuickMonthDate(){ runAlarmAccumulator('monthsDate') }

/** Plan + mode (multi-select) *********************************************************************************************************************/

// The current anchor the plan is described/applied against: the two field values.
function alarmAnchor(){
    return { date: document.getElementById('alarmDate').value, time: document.getElementById('alarmTime').value }
}

// Record the active plan, mirror it into the hidden #alarmPlan field (so it rides back to the host in formData), and
// move the -active highlight to the matching quick button(s). The hidden field must carry a string; an accumulator
// plan rides back as its JSON, which the host and the shared applyAlarmPlan both accept, and an absolute plan as its
// own string.
function setAlarmActivePlan(plan){
    alarmActivePlan = plan
    var field = document.getElementById('alarmPlan')
    if (field) field.value = (plan && typeof plan === 'object') ? JSON.stringify(plan) : plan
    setAlarmActiveButtons(plan)
}

// Move the -active highlight (multi only) to the pressed button(s): an absolute plan lights its single row-1 button;
// an accumulator plan lights every row-2 button whose counter is non-zero. Single-select has no plan concept, so the
// highlight is suppressed. Button order in the DOM: [Today, Tomorrow, Weekends, Next Monday, +hour, +day, +week,
// +month(day), +month(date)].
function setAlarmActiveButtons(plan){
    var absIndex = { today: 0, tomorrow: 1, weekends: 2, nextMonday: 3 }
    var accIndex = { hours: 4, days: 5, weeks: 6, monthsDay: 7, monthsDate: 8 }
    var isAcc = plan && typeof plan === 'object'
    var buttons = document.querySelectorAll('#alarmQuick button')
    for (var i = 0; i < buttons.length; i++){
        var active = false
        if (alarmIsMulti){
            if (isAcc){
                for (var key in accIndex){ if (accIndex[key] === i && plan[key] > 0){ active = true; break } }
            } else {
                active = absIndex[plan] === i
            }
        }
        buttons[i].classList.toggle('-active', active)
    }
}

// Re-word the explanation line (multi only) from the shared, unit-tested describeAlarmPlan, using the live dues,
// plan, anchor and mode. A no-op when the line is absent (single-select).
function updateAlarmPlanDescription(){
    var line = document.getElementById('alarmExplain')
    if (!line) return
    line.textContent = AlarmQuick.describeAlarmPlan(alarmTodoDues, alarmActivePlan, alarmAnchor(), alarmMode, new Date())
}

// The mode radio changed: adopt it and re-describe the plan (the pressed button is kept).
function onAlarmModeChanged(){
    var checked = document.querySelector('#alarmMode input[name="mode"]:checked')
    alarmMode = checked && checked.value === 'same' ? 'same' : 'respect'
    updateAlarmPlanDescription()
}

/** onAlarmCalendarNavigate *************************************************************************************************************************/
function onAlarmCalendarNavigate(delta){
    alarmCalendarAnchor = new Date(alarmCalendarAnchor.getFullYear(), alarmCalendarAnchor.getMonth() + delta, 1)
    renderAlarmCalendar()
}

/** pickAlarmDay ************************************************************************************************************************************
 * A manual calendar day pick sets the anchor date. Under a multi RESPECT plan that means "set this date for all,
 * keeping each to-do's own time", so the plan reverts to 'anchor'.                                                                                 *
 ***************************************************************************************************************************************************/
function pickAlarmDay(isoDate){
    document.getElementById('alarmDate').value = isoDate
    setAlarmActivePlan('anchor')
    renderAlarmCalendar()
    updateAlarmPlanDescription()
}

/** onAlarmDateEdited *******************************************************************************************************************************
 * Keeps the calendar in step while the date field is edited by hand. Editing the date by hand is a manual anchor pick, so the plan reverts too.    *
 ***************************************************************************************************************************************************/
function onAlarmDateEdited(){
    var parsed = alarmParseISO(document.getElementById('alarmDate').value)
    if (parsed) alarmCalendarAnchor = new Date(parsed.getFullYear(), parsed.getMonth(), 1)
    setAlarmActivePlan('anchor')
    renderAlarmCalendar()
    updateAlarmPlanDescription()
}

/** renderAlarmCalendar *****************************************************************************************************************************
 * Draws the month grid into #alarmCalendar: Monday-first columns, English month title, whole weeks covering the anchor's month                      *
 ***************************************************************************************************************************************************/
function renderAlarmCalendar(){
    var container = document.getElementById('alarmCalendar')
    if (!container) return
    var selected = alarmParseISO(document.getElementById('alarmDate').value)
    if (!alarmCalendarAnchor){
        var base = selected || new Date()
        alarmCalendarAnchor = new Date(base.getFullYear(), base.getMonth(), 1)
    }
    var anchor = alarmCalendarAnchor
    var title = anchor.toLocaleDateString('en', { month: 'long', year: 'numeric' })
    var todayISO = alarmDateToISO(new Date())
    var selectedISO = selected ? alarmDateToISO(selected) : null

    var firstOfMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
    var day = new Date(firstOfMonth)
    day.setDate(firstOfMonth.getDate() - ((firstOfMonth.getDay() + 6) % 7))
    // Always six weeks, so the dialog height never changes while navigating between months
    var end = new Date(day)
    end.setDate(day.getDate() + 41)

    var headers = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(label => `<th>${label}</th>`).join('')
    var rows = '', cells = '', column = 0
    while (day <= end){
        var iso = alarmDateToISO(day)
        var classes = ['alarm-cal-day']
        if (day.getMonth() !== anchor.getMonth()) classes.push('-outside')
        if (iso === todayISO) classes.push('-today')
        if (iso === selectedISO) classes.push('-selected')
        cells += `<td><button type="button" class="${classes.join(' ')}" onclick="pickAlarmDay('${iso}')">${day.getDate()}</button></td>`
        if (++column === 7){
            rows += `<tr>${cells}</tr>`
            cells = ''
            column = 0
        }
        day.setDate(day.getDate() + 1)
    }

    container.innerHTML = `
        <div class="alarm-cal-nav">
            <button type="button" title="Previous month" onclick="onAlarmCalendarNavigate(-1)">&#8249;</button>
            <span class="alarm-cal-title">${title}</span>
            <button type="button" title="Next month" onclick="onAlarmCalendarNavigate(1)">&#8250;</button>
        </div>
        <table class="alarm-cal-grid"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>
    `
}

/** Time picker *************************************************************************************************************************************
 * Two scrollable columns beside the calendar, hours 00-23 and minutes 00-59, like the native picker's right hand side. Clicking writes the time     *
 * field; editing the field by hand moves the highlight.                                                                                            *
 ***************************************************************************************************************************************************/
function currentAlarmTime(){
    var match = /^(\d{1,2}):(\d{2})$/.exec(String(document.getElementById('alarmTime').value || '').trim())
    if (!match) return { hours: null, minutes: null }
    var hours = Number(match[1]), minutes = Number(match[2])
    return { hours: hours <= 23 ? hours : null, minutes: minutes <= 59 ? minutes : null }
}

// A manual time pick/edit updates the anchor time only (the plan is kept); under a RESPECT plan the anchor time
// affects just the no-alarm to-dos, so re-describe the plan without touching the pressed button.
function pickAlarmHour(hours){
    var time = currentAlarmTime()
    document.getElementById('alarmTime').value = `${alarmPad(hours)}:${alarmPad(time.minutes === null ? 0 : time.minutes)}`
    alarmTimeUserSet = true
    updateAlarmTimeSelection()
    updateAlarmPlanDescription()
}

function pickAlarmMinute(minutes){
    var time = currentAlarmTime()
    document.getElementById('alarmTime').value = `${alarmPad(time.hours === null ? 9 : time.hours)}:${alarmPad(minutes)}`
    alarmTimeUserSet = true
    updateAlarmTimeSelection()
    updateAlarmPlanDescription()
}

function onAlarmTimeEdited(){
    alarmTimeUserSet = true
    updateAlarmTimeSelection()
    updateAlarmPlanDescription()
}

/** updateAlarmTimeSelection ************************************************************************************************************************
 * Moves the -selected highlight to the buttons matching the time field, without rebuilding the columns, so the scroll positions stay put            *
 ***************************************************************************************************************************************************/
function updateAlarmTimeSelection(){
    var time = currentAlarmTime()
    for (var button of document.querySelectorAll('.alarm-time-item')){
        var isHour = button.dataset.hour !== undefined
        var value = Number(isHour ? button.dataset.hour : button.dataset.minute)
        button.classList.toggle('-selected', value === (isHour ? time.hours : time.minutes))
    }
}

/** renderAlarmTimeColumns **************************************************************************************************************************/
function renderAlarmTimeColumns(){
    var hourColumn = document.getElementById('alarmHourCol')
    var minuteColumn = document.getElementById('alarmMinuteCol')
    if (!hourColumn || !minuteColumn) return
    var hourButtons = '', minuteButtons = ''
    for (var hour = 0; hour < 24; hour++){
        hourButtons += `<button type="button" class="alarm-time-item" data-hour="${hour}" onclick="pickAlarmHour(${hour})">${alarmPad(hour)}</button>`
    }
    for (var minute = 0; minute < 60; minute++){
        minuteButtons += `<button type="button" class="alarm-time-item" data-minute="${minute}" onclick="pickAlarmMinute(${minute})">${alarmPad(minute)}</button>`
    }
    hourColumn.innerHTML = hourButtons
    minuteColumn.innerHTML = minuteButtons
    updateAlarmTimeSelection()
    // Start with the chosen hour and minute in the middle of their columns
    var time = currentAlarmTime()
    scrollAlarmColumn(hourColumn, time.hours === null ? 9 : time.hours, 24)
    scrollAlarmColumn(minuteColumn, time.minutes === null ? 0 : time.minutes, 60)
}

function scrollAlarmColumn(column, index, total){
    column.scrollTop = Math.max(0, (column.scrollHeight * index / total) - (column.clientHeight / 2))
}

/** Initialization **********************************************************************************************************************************
 * The dialog markup may be set before or after this script runs, and is replaced on every open, so the calendar is (re)drawn whenever the container *
 * appears without a grid inside it. The anchor is reset so that a reopened dialog starts at the month of its date field.                            *
 ***************************************************************************************************************************************************/
function initAlarmCalendarIfNeeded(){
    applyAlarmPlatformClass()
    var container = document.getElementById('alarmCalendar')
    if (!container || container.querySelector('.alarm-cal-grid')) return
    // Fresh (re)open: read the host's #alarmInitData island (hasAlarm, multi, per-to-do dues). hasAlarm seeds the
    // quick-button preservedTime state; multi + dues drive the plan/mode model and the explanation line. The time
    // field starts untouched, the mode defaults to RESPECT for a multi selection (SAME for single), no plan pressed.
    var init = readAlarmInitData()
    alarmHadExistingAlarm = !!init.hasAlarm
    alarmIsMulti = !!init.multi
    alarmTodoDues = Array.isArray(init.dues) ? init.dues : []
    alarmMode = alarmIsMulti ? 'respect' : 'same'
    alarmActivePlan = 'anchor'
    alarmTimeUserSet = false
    alarmCalendarAnchor = null
    renderAlarmCalendar()
    renderAlarmTimeColumns()
    setAlarmActivePlan('anchor')
    updateAlarmPlanDescription()
}

// The host's JSON island of open-time facts (hasAlarm, multi, dues). Absent/parse failure -> single-select defaults.
function readAlarmInitData(){
    var node = document.getElementById('alarmInitData')
    if (!node) return {}
    try { return JSON.parse(node.textContent || '{}') || {} } catch (error){ return {} }
}

/** applyAlarmPlatformClass *************************************************************************************************************************
 * The dialog is mobile when its markup carries the #cockpitPlatform marker, which the plugin emits into the setHtml only on mobile. Mirror that    *
 * onto the persistent #joplin-plugin-content wrapper as the cockpit-mobile class, so the narrow (stacked) layout in dialogCss - which is gated on   *
 * that class rather than a viewport media query - takes effect. Add-only and gated on the marker's presence, so on desktop (no marker) the wrapper  *
 * is never touched and the layout stays the unconditional 424px side-by-side one. Mirrors panelWebview.js's applyPlatformClass.                     *
 ***************************************************************************************************************************************************/
function applyAlarmPlatformClass(){
    if (!document.getElementById('cockpitPlatform')) return
    var wrapper = document.getElementById('joplin-plugin-content')
    if (wrapper) wrapper.classList.add('cockpit-mobile')
}

new MutationObserver(initAlarmCalendarIfNeeded).observe(document.documentElement, { childList: true, subtree: true })
if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', initAlarmCalendarIfNeeded)
} else {
    initAlarmCalendarIfNeeded()
}
