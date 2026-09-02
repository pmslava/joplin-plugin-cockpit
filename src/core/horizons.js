/** README ******************************************************************************************************************************************
 * Pure, deterministic date math for the INTERVAL view's named horizons - the plan of period sections a to-do is bucketed into, and the calendar day  *
 * dropping one onto a section's heading makes it due on.                                                                                            *
 *                                                                                                                                                    *
 * THE SLICE RULE. A section is not "the period" but the time SLICE between the previous section's end and its own: Today, then Tomorrow, then the     *
 * rest of the week, then the rest of the month, then the rest of the year. When a period's own end has already been reached by the section above it,  *
 * its slice is EMPTY - there is nothing left of this week once Tomorrow is Sunday - and the empty section is skipped: the NEXT period takes its slot   *
 * instead, ending at the end of the following period. So a Saturday shows "Next Week" where a Monday shows "This Week", the last days of a month      *
 * show "Next Month", and December shows "Next Year". A Next section can never itself be empty: its end always lies beyond the previous section's.     *
 *                                                                                                                                                    *
 * THE DROP RULE. A section's drop date is the FIRST calendar day of its slice - the day after the previous section's end day - not the last day of    *
 * its period. Dropping onto "This Week" on a Wednesday therefore schedules the to-do for Friday (the first free day of that group), not for Sunday;    *
 * a plan that puts everything on the last day of the week is a plan that is already too late. Today and Tomorrow are their own day, as before.        *
 *                                                                                                                                                    *
 * Everything here is pure: every input is explicit (never Date.now() inside), and all arithmetic runs on LOCAL calendar parts - dates built from       *
 * year/month/day components, never ms-per-day offsets - so a daylight-saving transition inside a slice shifts no boundary.                            *
 *                                                                                                                                                    *
 * API                                                                                                                                                *
 *   horizonPlan(nowMs, weekStartsOn)  - { startOfToday, sections: [{ name, end, dropDate }] }: the five ordered sections Today, Tomorrow, the week     *
 *                                       section, the month section and the year section. `name` is one of "Today", "Tomorrow", "This Week",           *
 *                                       "Next Week", "This Month", "Next Month", "This Year", "Next Year"; `end` is the LAST MILLISECOND of the       *
 *                                       slice (a day at 23:59:59.999 local); `dropDate` is its first day as a local 'YYYY-MM-DD'.                     *
 *   horizonOf(dueMs, plan)            - the heading a due timestamp falls under: "No Due Date" (due 0), "Overdue" (before startOfToday), a section     *
 *                                       name, or "Future" past the last section. Each section owns its own end millisecond (due <= end), so a to-do    *
 *                                       due at 23:59:59.999 belongs to that day rather than to the next slice.                                        *
 *   kindOf(name)                      - 'day' | 'week' | 'month' | 'year' for a section name, null for anything else. The row label follows the kind:  *
 *                                       a time under a day, a weekday under a week, a date under a month or a year.                                   *
 *   dropDateFor(name, plan)           - what dropping onto that heading does: the section's first day, "clear" for "No Due Date", null for a heading    *
 *                                       with no meaningful date (Overdue, Future).                                                                    *
 *                                                                                                                                                    *
 * The very same file is require()d by the Node test harness (module.exports below) and bundled into the host by webpack (require("./horizons") in     *
 * formats.ts), so every rule here is unit-tested against the owner's acceptance calendars AND drives the real panel.                                  *
 ***************************************************************************************************************************************************/
;(function(root, factory){
    var api = factory()
    if (typeof module !== 'undefined' && module.exports) module.exports = api        // Node test harness (require)
    if (typeof window !== 'undefined') window.CockpitHorizons = api                   // harmless webview export (unused there)
    else if (root) root.CockpitHorizons = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict'

    // Local midnight of the day a timestamp falls on.
    function startOfDay(ts){ var d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0) }

    // The LAST MILLISECOND of a day, as ms. Built from the date's own calendar parts, so no DST-crossing arithmetic.
    function endOfDayMs(date){ return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).getTime() }

    // The same calendar day plus `days`, as a Date at midnight. setDate-style component arithmetic, DST-safe.
    function addDays(date, days){ return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days) }

    // A local 'YYYY-MM-DD'. toISOString would convert to UTC first and so can name the wrong day.
    function toISODate(date){
        var pad = function(value){ return String(value).padStart(2, '0') }
        return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    }

    // 0 for Sunday, 1 for Monday - anything else means the profile default, Monday.
    function normWeekStart(weekStartsOn){ return Number(weekStartsOn) === 0 ? 0 : 1 }

    // The last day of the month `offset` months from the given date, as a Date at midnight. Day 0 of the following
    // month IS the last day of the month before it, and the month index carries across a year boundary on its own.
    function lastDayOfMonth(date, offset){ return new Date(date.getFullYear(), date.getMonth() + offset + 1, 0) }

    /** horizonPlan ************************************************************************************************************************************
     * The ordered sections for a given moment: Today, Tomorrow, then one week, one month and one year section, each ending at the last millisecond of  *
     * its slice and carrying the first day of that slice as its drop date. A period whose own end has already been covered by the section above it is  *
     * skipped in favour of the NEXT period ("Next Week" / "Next Month" / "Next Year"), which is why every end below is strictly increasing.            *
     ***************************************************************************************************************************************************/
    function horizonPlan(nowMs, weekStartsOn){
        var weekStart = normWeekStart(weekStartsOn)
        var today = startOfDay(nowMs)
        var tomorrow = addDays(today, 1)
        var sections = []
        // Today and Tomorrow are days, so their slice and their drop day are the same day.
        sections.push({ name: 'Today', end: endOfDayMs(today), dropDate: toISODate(today) })
        sections.push({ name: 'Tomorrow', end: endOfDayMs(tomorrow), dropDate: toISODate(tomorrow) })
        // Week: the rest of this week, or - when Tomorrow already reaches its last day - the whole of the next one.
        var firstOfWeek = addDays(today, -((today.getDay() - weekStart + 7) % 7))
        var thisWeekEnd = endOfDayMs(addDays(firstOfWeek, 6))
        var weekAbsorbed = thisWeekEnd <= sections[1].end
        addSection(sections, weekAbsorbed ? 'Next Week' : 'This Week', weekAbsorbed ? endOfDayMs(addDays(firstOfWeek, 13)) : thisWeekEnd)
        // Month: the rest of this month, or the whole of the next one when the week section already ran past its end.
        var thisMonthEnd = endOfDayMs(lastDayOfMonth(today, 0))
        var monthAbsorbed = thisMonthEnd <= sections[2].end
        addSection(sections, monthAbsorbed ? 'Next Month' : 'This Month', monthAbsorbed ? endOfDayMs(lastDayOfMonth(today, 1)) : thisMonthEnd)
        // Year: the rest of this year, or the whole of the next one - which is what every December shows.
        var thisYearEnd = endOfDayMs(new Date(today.getFullYear(), 11, 31))
        var yearAbsorbed = thisYearEnd <= sections[3].end
        addSection(sections, yearAbsorbed ? 'Next Year' : 'This Year', yearAbsorbed ? endOfDayMs(new Date(today.getFullYear() + 1, 11, 31)) : thisYearEnd)
        return { startOfToday: today.getTime(), sections: sections }
    }

    // Appends a section, deriving its drop date from the previous section's end: the FIRST day of the new slice is the
    // day after the day the previous slice ended on.
    function addSection(sections, name, end){
        var previousEnd = sections[sections.length - 1].end
        sections.push({ name: name, end: end, dropDate: toISODate(addDays(startOfDay(previousEnd), 1)) })
    }

    /** horizonOf **************************************************************************************************************************************
     * The heading a due timestamp falls under, given a plan. The chain is ordered and each section owns its own end millisecond.                       *
     ***************************************************************************************************************************************************/
    function horizonOf(dueMs, plan){
        var due = Number(dueMs)
        if (!due || due <= 0) return 'No Due Date'
        if (due < plan.startOfToday) return 'Overdue'
        for (var index = 0; index < plan.sections.length; index++){
            if (due <= plan.sections[index].end) return plan.sections[index].name
        }
        return 'Future'
    }

    /** kindOf *****************************************************************************************************************************************
     * The period a section name names, which is what decides how much date a row under it needs to show.                                              *
     ***************************************************************************************************************************************************/
    function kindOf(name){
        if (name === 'Today' || name === 'Tomorrow') return 'day'
        if (name === 'This Week' || name === 'Next Week') return 'week'
        if (name === 'This Month' || name === 'Next Month') return 'month'
        if (name === 'This Year' || name === 'Next Year') return 'year'
        return null
    }

    /** dropDateFor ************************************************************************************************************************************
     * What dropping a to-do onto the given heading should do: the section's FIRST day as 'YYYY-MM-DD', "clear" to remove the due date, or null when    *
     * the heading names no date at all (Overdue and Future are open-ended).                                                                            *
     ***************************************************************************************************************************************************/
    function dropDateFor(name, plan){
        if (name === 'No Due Date') return 'clear'
        for (var index = 0; index < plan.sections.length; index++){
            if (plan.sections[index].name === name) return plan.sections[index].dropDate
        }
        return null
    }

    return {
        horizonPlan: horizonPlan,
        horizonOf: horizonOf,
        kindOf: kindOf,
        dropDateFor: dropDateFor,
    }
})
