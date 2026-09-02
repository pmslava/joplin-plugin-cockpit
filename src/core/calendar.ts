/** README ******************************************************************************************************************************************
 * Date arithmetic and markup for the calendar views.                                                                                               *
 *                                                                                                                                                  *
 * Everything here works in local time, because a to-do due at 23:00 belongs to the day the user sees on their own clock, not to whichever day that  *
 * instant falls on in UTC.                                                                                                                         *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import { escapeHtml, dropTargetAttributes, headingContextAttributes } from "./html";
import { iconButton } from "../ui/icons";

/** CalendarViewState *******************************************************************************************************************************
 * Which part of the calendar the user is looking at. This is held by the panel rather than by the profile: it is where you have scrolled to, not a  *
 * setting, and it is deliberately forgotten when the plugin restarts.                                                                              *
 ***************************************************************************************************************************************************/
export interface CalendarViewState {
    /** The day whose month or week is on screen, as YYYY-MM-DD */
    anchor: string
    /** The day whose to-dos are listed under the month grid, as YYYY-MM-DD, or null for none */
    selectedDate: string
}

/** toISODate ***************************************************************************************************************************************
 * Formats a date as YYYY-MM-DD in local time. Date.toISOString would convert to UTC first and so can name the wrong day.                            *
 ***************************************************************************************************************************************************/
export function toISODate(date): string {
    var pad = value => String(value).padStart(2, "0")
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** fromISODate *************************************************************************************************************************************
 * Parses a YYYY-MM-DD string into a local date at midnight. new Date("YYYY-MM-DD") would parse as UTC.                                             *
 ***************************************************************************************************************************************************/
export function fromISODate(isoDate): Date {
    var parts = String(isoDate).split("-").map(Number)
    if (parts.length !== 3 || parts.some(part => !Number.isFinite(part))) return startOfDay(new Date())
    return new Date(parts[0], parts[1] - 1, parts[2])
}

/** startOfDay **************************************************************************************************************************************/
export function startOfDay(date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** addDays *****************************************************************************************************************************************/
export function addDays(date, days): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

/** addMonths ***************************************************************************************************************************************
 * Adds whole months, clamping the day so that adding a month to the 31st does not roll into the following month                                     *
 ***************************************************************************************************************************************************/
export function addMonths(date, months): Date {
    var target = new Date(date.getFullYear(), date.getMonth() + months, 1)
    var lastDayOfTarget = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
    target.setDate(Math.min(date.getDate(), lastDayOfTarget))
    return target
}

/** startOfWeek *************************************************************************************************************************************
 * The first day of the week containing the given date, where weekStartsOn is 0 for Sunday and 1 for Monday                                         *
 ***************************************************************************************************************************************************/
export function startOfWeek(date, weekStartsOn): Date {
    var offset = (date.getDay() - Number(weekStartsOn) + 7) % 7
    return addDays(startOfDay(date), -offset)
}

/** buildMonthGrid **********************************************************************************************************************************
 * The days shown by a month view: whole weeks covering the anchor's month, so the grid always starts and ends on a week boundary. The length varies  *
 * between 28 and 42 days depending on the month, rather than being padded to a fixed six weeks.                                                     *
 ***************************************************************************************************************************************************/
export function buildMonthGrid(anchor, weekStartsOn): Date[] {
    var firstOfMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
    var lastOfMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)
    var day = startOfWeek(firstOfMonth, weekStartsOn)
    var lastDay = addDays(startOfWeek(lastOfMonth, weekStartsOn), 6)
    var days = []
    while (day <= lastDay) {
        days.push(day)
        day = addDays(day, 1)
    }
    return days
}

/** buildWeek ***************************************************************************************************************************************
 * The seven days of the week containing the anchor                                                                                                 *
 ***************************************************************************************************************************************************/
export function buildWeek(anchor, weekStartsOn): Date[] {
    var first = startOfWeek(anchor, weekStartsOn)
    var days = []
    for (var offset = 0; offset < 7; offset++) days.push(addDays(first, offset))
    return days
}

/** groupTodosByDate ********************************************************************************************************************************
 * Buckets to-dos by the local day they are due. To-dos with no due date cannot be placed on a calendar and are returned separately.                 *
 ***************************************************************************************************************************************************/
export function groupTodosByDate(todoList){
    var byDate = new Map<string, any[]>()
    var undated = []
    for (var todo of todoList){
        if (!todo.todo_due) {
            undated.push(todo)
            continue
        }
        var key = toISODate(new Date(todo.todo_due))
        if (!byDate.has(key)) byDate.set(key, [])
        byDate.get(key).push(todo)
    }
    for (var todos of byDate.values()) todos.sort((first, second) => first.todo_due - second.todo_due)
    return { byDate: byDate, undated: undated }
}

/** dayState ****************************************************************************************************************************************
 * How a day should be coloured, given the to-dos due on it. Overdue wins over due, and a day whose to-dos are all completed is muted.               *
 ***************************************************************************************************************************************************/
export function dayState(todos, now): string {
    if (!todos || !todos.length) return "empty"
    var outstanding = todos.filter(todo => !todo.todo_completed)
    if (!outstanding.length) return "done"
    if (outstanding.some(todo => todo.todo_due < now.getTime())) return "overdue"
    return "due"
}

/** weekdayLabels ***********************************************************************************************************************************
 * The column headings of a calendar, in the user's locale, starting on the configured first day of the week                                         *
 ***************************************************************************************************************************************************/
export function weekdayLabels(weekStartsOn, weekdayFormat): string[] {
    // Any week will do; the 4th of January 1970 was a Sunday, which makes the offsets easy to reason about.
    var sunday = new Date(1970, 0, 4)
    var labels = []
    for (var offset = 0; offset < 7; offset++){
        var day = addDays(sunday, (Number(weekStartsOn) + offset) % 7)
        labels.push(day.toLocaleDateString(undefined, { weekday: weekdayFormat || "short" }))
    }
    return labels
}

/** renderNavigation ********************************************************************************************************************************
 * The previous/next/today controls shown above a calendar                                                                                          *
 ***************************************************************************************************************************************************/
export function renderNavigation(title): string {
    return `
        <section class="calendar-nav">
            ${iconButton("chevronLeft", "Previous", "onCalendarNavigate(-1)")}
            <button type="button" class="calendar-title" title="Back to today" onclick="onCalendarToday()">${escapeHtml(title)}</button>
            ${iconButton("chevronRight", "Next", "onCalendarNavigate(1)")}
        </section>
    `
}

/** renderUndated ***********************************************************************************************************************************
 * The to-dos that have no due date, shown under a calendar so that they are not silently dropped when a profile shows them                          *
 ***************************************************************************************************************************************************/
export function renderUndated(undatedTodos, renderTodoRow): string {
    if (!undatedTodos.length) return ""
    var rows = undatedTodos.map(todo => renderTodoRow(todo, todo.title)).join("")
    return `
        <section class="calendar-undated">
            <h2${dropTargetAttributes("clear")}${headingContextAttributes(undatedTodos.map(todo => todo.id))}>No Due Date</h2>
            ${rows}
        </section>
    `
}
