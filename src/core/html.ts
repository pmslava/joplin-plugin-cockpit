/** README ******************************************************************************************************************************************
 * Small HTML helpers shared by the formats and the calendar views. They live in their own file so that both can use them without importing each      *
 * other.                                                                                                                                           *
 ***************************************************************************************************************************************************/

/** escapeHtml **************************************************************************************************************************************
 * Escapes the characters that would otherwise be interpreted as markup, so that to-do titles and profile names containing characters such as & or < *
 * are displayed as written                                                                                                                         *
 ***************************************************************************************************************************************************/
export function escapeHtml(value){
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

/** dropTargetAttributes ****************************************************************************************************************************
 * The attributes that make an element accept dropped to-dos. The target is either a YYYY-MM-DD date the dropped to-dos become due on, or "clear"    *
 * to remove their due dates. Returns an empty string for no target, so it can be interpolated unconditionally.                                     *
 * `endTarget` is the LAST day of the span the element names, written as data-drop-end and only when it differs from the drop day itself. A single   *
 * day (a calendar cell, a Date-view heading, Today / Tomorrow) needs none; an interval period heading does, because its drop day is the FIRST day   *
 * of its slice and a between-row drop at the group's bottom edge has to reach the other end of it.                                                  *
 ***************************************************************************************************************************************************/
export function dropTargetAttributes(target, endTarget?){
    if (!target) return ""
    var end = (endTarget && endTarget !== target) ? ` data-drop-end="${escapeHtml(endTarget)}"` : ""
    return ` data-drop="${escapeHtml(target)}"${end} ondragover="onDropTargetOver(event)" ondragleave="onDropTargetLeave(event)" ondrop="onTodoDropped(event)"`
}

/** headingContextAttributes ************************************************************************************************************************
 * The attributes that give a group heading - or a month day cell (2.11) - its context menu: a right click (desktop) or a long press (mobile) opens  *
 * the panel's heading menu (headingMenuHtml in noteMenu.js), which offers to move the group's to-dos to a date and, when the heading names a day,   *
 * to create a to-do due that day. `day` is that day as YYYY-MM-DD (data-day): a heading whose drop target is a day passes it - a single-day heading *
 * its own day, and a heading that spans days (This Week, Next Month ...) its FIRST day, the same day a drop on it writes - while Overdue, Future and *
 * No Due Date pass none. An empty group with a day still has a menu, for its New to-do item. Without a day the output is exactly what it was before *
 * 2.11 - nothing at all for an empty group - so it can still be interpolated unconditionally.                                                      *
 ***************************************************************************************************************************************************/
export function headingContextAttributes(todoIDs, day?){
    var ids = todoIDs && todoIDs.length ? ` data-todo-ids="${escapeHtml(todoIDs.join(","))}"` : ""
    var named = day ? ` data-day="${escapeHtml(day)}"` : ""
    if (!ids && !named) return ""
    return `${ids}${named} oncontextmenu="onHeadingContextMenu(event)"`
}

/** isDayKey (2.11) *********************************************************************************************************************************
 * Whether a drop target names one day (YYYY-MM-DD) - as opposed to "clear" (No Due Date) or nothing at all (Overdue, Future). Only such a heading    *
 * gets the heading menu's New to-do item and, with the selected-day setting on, a click that selects its day.                                      *
 ***************************************************************************************************************************************************/
export function isDayKey(value){
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/** daySelectAttribute (2.11) ***********************************************************************************************************************
 * The click that selects a day from a heading of the list and week views, with the "New to-do: due on the selected day" setting on. It posts what  *
 * the month's day cells post (onCalendarDaySelected), so the same day clicked again clears the selection there too.                               *
 ***************************************************************************************************************************************************/
export function daySelectAttribute(day){
    return ` onclick="onCalendarDaySelected('${escapeHtml(day)}')"`
}
