/** README ******************************************************************************************************************************************
 * The calendar picker of the set alarm dialog. It is drawn here rather than with a native datetime input, because the native picker's format        *
 * follows the application locale and cannot show ISO dates with English names. The week always starts on Monday.                                   *
 ***************************************************************************************************************************************************/

/** The first day of the month the calendar is showing. Reset from the date field every time the dialog is (re)opened. */
var alarmCalendarAnchor = null

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

/** setAlarmDateOffset ******************************************************************************************************************************
 * Fills the date field with today plus the given number of days. Used by the Today / Tomorrow / +1 week buttons.                                   *
 ***************************************************************************************************************************************************/
function setAlarmDateOffset(days){
    var date = new Date()
    date.setDate(date.getDate() + days)
    document.getElementById('alarmDate').value = alarmDateToISO(date)
    alarmCalendarAnchor = new Date(date.getFullYear(), date.getMonth(), 1)
    renderAlarmCalendar()
}

/** setAlarmDateNextMonth ***************************************************************************************************************************
 * Moves the date to the same occurrence of the same weekday in the next month: the 1st Saturday stays the 1st Saturday. When the next month has no  *
 * such occurrence (a 5th one), the last occurrence of that weekday is used instead.                                                                *
 ***************************************************************************************************************************************************/
function setAlarmDateNextMonth(){
    var current = alarmParseISO(document.getElementById('alarmDate').value) || new Date()
    var weekday = current.getDay()
    var ordinal = Math.floor((current.getDate() - 1) / 7)
    var firstOfNext = new Date(current.getFullYear(), current.getMonth() + 1, 1)
    var day = 1 + ((weekday - firstOfNext.getDay() + 7) % 7) + ordinal * 7
    var daysInNext = new Date(firstOfNext.getFullYear(), firstOfNext.getMonth() + 1, 0).getDate()
    while (day > daysInNext) day -= 7
    var target = new Date(firstOfNext.getFullYear(), firstOfNext.getMonth(), day)
    document.getElementById('alarmDate').value = alarmDateToISO(target)
    alarmCalendarAnchor = new Date(target.getFullYear(), target.getMonth(), 1)
    renderAlarmCalendar()
}

/** onAlarmCalendarNavigate *************************************************************************************************************************/
function onAlarmCalendarNavigate(delta){
    alarmCalendarAnchor = new Date(alarmCalendarAnchor.getFullYear(), alarmCalendarAnchor.getMonth() + delta, 1)
    renderAlarmCalendar()
}

/** pickAlarmDay ************************************************************************************************************************************/
function pickAlarmDay(isoDate){
    document.getElementById('alarmDate').value = isoDate
    renderAlarmCalendar()
}

/** onAlarmDateEdited *******************************************************************************************************************************
 * Keeps the calendar in step while the date field is edited by hand                                                                                *
 ***************************************************************************************************************************************************/
function onAlarmDateEdited(){
    var parsed = alarmParseISO(document.getElementById('alarmDate').value)
    if (parsed) alarmCalendarAnchor = new Date(parsed.getFullYear(), parsed.getMonth(), 1)
    renderAlarmCalendar()
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

function pickAlarmHour(hours){
    var time = currentAlarmTime()
    document.getElementById('alarmTime').value = `${alarmPad(hours)}:${alarmPad(time.minutes === null ? 0 : time.minutes)}`
    updateAlarmTimeSelection()
}

function pickAlarmMinute(minutes){
    var time = currentAlarmTime()
    document.getElementById('alarmTime').value = `${alarmPad(time.hours === null ? 9 : time.hours)}:${alarmPad(minutes)}`
    updateAlarmTimeSelection()
}

function onAlarmTimeEdited(){
    updateAlarmTimeSelection()
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
    var container = document.getElementById('alarmCalendar')
    if (!container || container.querySelector('.alarm-cal-grid')) return
    alarmCalendarAnchor = null
    renderAlarmCalendar()
    renderAlarmTimeColumns()
}

new MutationObserver(initAlarmCalendarIfNeeded).observe(document.documentElement, { childList: true, subtree: true })
if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', initAlarmCalendarIfNeeded)
} else {
    initAlarmCalendarIfNeeded()
}
