/** README ******************************************************************************************************************************************
 * Pure, deterministic date/time math for the alarm picker's quick buttons (Today, Tomorrow, +week, +month(day), +month(date)). Shared by BOTH the    *
 * desktop alarm DIALOG (alarmWebview.js) and the mobile in-panel alarm OVERLAY (panelWebview.js): each is loaded into its own webview iframe alongside  *
 * this file (registered via addScript BEFORE the webview script) and calls window.AlarmQuick.* from its button wiring, so the five buttons behave      *
 * identically in both places without forking the math. The very same file is require()d by the Node test harness (module.exports below), so every rule *
 * here is unit-tested against the owner's acceptance examples.                                                                                        *
 *                                                                                                                                                      *
 * Every function takes an explicit `now` (and, where relevant, a `baseDate` and a `preservedTime` of {hours,minutes}|null) - never Date.now() - so the *
 * behaviour is deterministic and testable. All arithmetic is LOCAL-calendar based (Date constructors + setDate/setHours), never millisecond addition,  *
 * so a DST transition shifts no clock time. Each button returns { date: 'YYYY-MM-DD', time: 'HH:MM' }, ready to drop straight into the two text fields. *
 *                                                                                                                                                      *
 * preservedTime is the clock time the picker already showed - kept when the to-do(s) already had an alarm before the dialog opened, or the user set the *
 * time this session - and is null only when the picker was fresh AND the time field was untouched, the one case where a button substitutes ceilHour.   *
 ***************************************************************************************************************************************************/
;(function(root, factory){
    var api = factory()
    if (typeof module !== 'undefined' && module.exports) module.exports = api        // Node test harness (require)
    if (typeof window !== 'undefined') window.AlarmQuick = api                        // dialog + panel webview iframes
    else if (root) root.AlarmQuick = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict'

    function pad2(value){ return String(value).padStart(2, '0') }
    function isoDate(date){ return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) }
    function isoTime(date){ return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) }

    // Round `now` UP to the next full hour; an exact :00 keeps its hour (14:36 -> 15:00, 15:00 -> 15:00). Built
    // from local calendar parts and advanced with setHours, so it is DST-safe and rolls the date over 23:xx -> 00:00.
    function ceilHour(now){
        var hour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0)
        if (now.getMinutes() || now.getSeconds() || now.getMilliseconds()) hour.setHours(hour.getHours() + 1)
        return hour
    }

    // The clock time a non-Today button writes: the preserved time when there is one, else the time of ceilHour(now).
    function buttonTime(now, preservedTime){
        if (preservedTime && Number.isFinite(preservedTime.hours) && Number.isFinite(preservedTime.minutes)){
            return pad2(preservedTime.hours) + ':' + pad2(preservedTime.minutes)
        }
        return isoTime(ceilHour(now))
    }

    // First day (00:00, local) of the month AFTER `date`; month+1 rolls the year over (Dec -> next Jan).
    function firstOfNextMonth(date){ return new Date(date.getFullYear(), date.getMonth() + 1, 1) }
    // Days in the month that `firstOfMonth` begins - day 0 of the following month is that month's last day.
    function daysInMonth(firstOfMonth){ return new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth() + 1, 0).getDate() }

    // A date-only (00:00 local) Date; strips any time component so the shift helpers below stay pure calendar math.
    function dateOnly(date){ return new Date(date.getFullYear(), date.getMonth(), date.getDate()) }

    // The three date-shift primitives, returning a date-only Date. The single-select quick buttons wrap these with a
    // time, and the multi-select RESPECT plan feeds each to-do's OWN due date through the identical helper - so a
    // +week / +month press shifts single and multi selections by the very same calendar math, never forked.
    function weekDate(base){ var t = dateOnly(base); t.setDate(t.getDate() + 7); return t }               // +7 days
    function monthWeekdayDate(base){                                                                       // same weekday-ordinal next month
        var weekday = base.getDay()
        var ordinal = Math.floor((base.getDate() - 1) / 7)          // 0-based: 0 = first occurrence
        var first = firstOfNextMonth(base)
        var day = 1 + ((weekday - first.getDay() + 7) % 7) + ordinal * 7
        var count = daysInMonth(first)
        while (day > count) day -= 7                                 // no nth occurrence -> step back to the last
        return new Date(first.getFullYear(), first.getMonth(), day)
    }
    function monthDateDate(base){                                                                          // same day-of-month next month (clamped)
        var first = firstOfNextMonth(base)
        var day = Math.min(base.getDate(), daysInMonth(first))
        return new Date(first.getFullYear(), first.getMonth(), day)
    }

    // Parse the picker's two field values ({date:'YYYY-MM-DD', time:'HH:MM'}) into one local Date, or null when either
    // is missing/impossible (rejects e.g. Feb 31). Used by applyAlarmPlan/describeAlarmPlan so the anchor - the
    // fallback datetime for a no-alarm to-do and the "date for all" of a manual pick - is always a real moment.
    function parseAnchor(anchor){
        if (!anchor) return null
        var dateMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(anchor.date || '').trim())
        var timeMatch = /^(\d{1,2}):(\d{2})$/.exec(String(anchor.time || '').trim())
        if (!dateMatch || !timeMatch) return null
        var year = Number(dateMatch[1]), month = Number(dateMatch[2]), day = Number(dateMatch[3])
        var hours = Number(timeMatch[1]), minutes = Number(timeMatch[2])
        if (hours > 23 || minutes > 59) return null
        var parsed = new Date(year, month - 1, day, hours, minutes, 0, 0)
        if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null
        return parsed
    }

    // Combine a date-only Date with an {hours,minutes} clock time into one local timestamp (ms).
    function combine(dateOnlyValue, hours, minutes){
        return new Date(dateOnlyValue.getFullYear(), dateOnlyValue.getMonth(), dateOnlyValue.getDate(), hours, minutes, 0, 0).getTime()
    }

    // The three quick buttons that shift a date are also the three RESPECT-mode "+ plans"; today/tomorrow/anchor are
    // the RESPECT-mode "date for all" plans (a single target date every to-do lands on, each keeping its own time).
    var SHIFT_DATE = { week: weekDate, monthWeekday: monthWeekdayDate, monthDate: monthDateDate }

    // The "date for all" target date (date-only) for a non-shift plan: today, tomorrow, or - for a manual pick / no
    // button pressed ('anchor', or any unrecognised value) - the anchor's own date.
    function dateForAll(plan, anchorDate, now){
        if (plan === 'today') return dateOnly(now)
        if (plan === 'tomorrow'){ var t = dateOnly(now); t.setDate(t.getDate() + 1); return t }
        return dateOnly(anchorDate)                                  // 'anchor' / manual / unknown
    }

    function withDueCount(todos){
        var count = 0
        for (var i = 0; i < todos.length; i++){ if (todos[i] && todos[i].due && todos[i].due > 0) count++ }
        return count
    }

    // The label a shift plan reads as in the explanation line.
    function shiftLabel(plan){
        if (plan === 'week') return '+1 week'
        if (plan === 'monthWeekday') return '+1 month (same weekday)'
        if (plan === 'monthDate') return '+1 month (same date)'
        return ''
    }

    var api = {
        ceilHour: ceilHour,

        // 1. Today - date+time = ceilHour(now) + 1 hour, ALWAYS (ignores preservedTime). The arithmetic is kept as
        //    is, so a late press crossing midnight (23:30 -> 01:00) lands on the next day at 01:00.
        today: function(now){
            var target = ceilHour(now)
            target.setHours(target.getHours() + 1)
            return { date: isoDate(target), time: isoTime(target) }
        },

        // 2. Tomorrow - date = today + 1 day; time = preserved, else ceilHour(now).
        tomorrow: function(now, preservedTime){
            var target = new Date(now.getFullYear(), now.getMonth(), now.getDate())
            target.setDate(target.getDate() + 1)
            return { date: isoDate(target), time: buttonTime(now, preservedTime) }
        },

        // 3. +week - date = baseDate + 7 days; time = preserved, else ceilHour(now). Repeated presses walk forward
        //    because the caller feeds each result's date back as the next baseDate.
        week: function(now, baseDate, preservedTime){
            return { date: isoDate(weekDate(baseDate)), time: buttonTime(now, preservedTime) }
        },

        // 4. +month(day) - the same weekday-ordinal in baseDate's FOLLOWING month (a 2nd Sunday stays a 2nd Sunday;
        //    ordinal n = floor((dayOfMonth-1)/7)). When that month has no nth occurrence (a 5th one), the LAST
        //    occurrence of that weekday is used instead. time = preserved, else ceilHour(now).
        monthWeekday: function(now, baseDate, preservedTime){
            return { date: isoDate(monthWeekdayDate(baseDate)), time: buttonTime(now, preservedTime) }
        },

        // 5. +month(date) - the same day-of-month in baseDate's FOLLOWING month (Jan 9 -> Feb 9); a day the next
        //    month lacks (Jan 31 -> Feb) clamps to that month's last day. time = preserved, else ceilHour(now).
        monthDate: function(now, baseDate, preservedTime){
            return { date: isoDate(monthDateDate(baseDate)), time: buttonTime(now, preservedTime) }
        },
    }

    /** applyAlarmPlan *********************************************************************************************************************************
     * The multi-select engine: turns the picker's current PLAN + MODE + anchor into the final due timestamp of every selected to-do. Pure and         *
     * deterministic (all inputs explicit, no Date.now()), so the host computes the exact per-to-do values through it and the harness pins every case.  *
     *   todos  : [{ id, due }] - each selected to-do's CURRENT due timestamp (0 = no alarm), as the host holds them.                                    *
     *   plan   : 'anchor' | 'today' | 'tomorrow' | 'week' | 'monthWeekday' | 'monthDate' - the last quick button pressed, or 'anchor' for a manual     *
     *            calendar pick / no press.                                                                                                              *
     *   anchor : { date:'YYYY-MM-DD', time:'HH:MM' } - the calendar+time fields; the fallback datetime for a no-alarm to-do, and the "date for all" of  *
     *            a manual pick.                                                                                                                          *
     *   mode   : 'respect' (default for multi: each to-do keeps its OWN time; '+' plans shift from its OWN date) | 'same' (the 1.8.3 behaviour: every    *
     *            to-do gets the single anchor datetime).                                                                                                 *
     *   now    : the reference Date for today / tomorrow.                                                                                                *
     * Returns [{ id, due }] in the input order. A single-select selection is just a one-element todos with mode 'same', which reproduces 1.8.3 exactly.  *
     ***************************************************************************************************************************************************/
    function applyAlarmPlan(todos, plan, anchor, mode, now){
        todos = Array.isArray(todos) ? todos : []
        now = now || new Date()
        var anchorDate = parseAnchor(anchor)
        // A malformed anchor cannot happen in practice (the host validates the fields before calling), but stay
        // pure and total: with no valid anchor there is no datetime to apply, so leave every to-do unchanged-shaped.
        if (!anchorDate) return todos.map(function(todo){ return { id: todo.id, due: todo.due && todo.due > 0 ? todo.due : 0 } })
        var anchorTs = anchorDate.getTime()

        // MODE = SAME FOR ALL: the 1.8.3 behaviour - every selected to-do gets the one anchor datetime (plan ignored).
        if (mode === 'same') return todos.map(function(todo){ return { id: todo.id, due: anchorTs } })

        // MODE = RESPECT (default): each to-do keeps its own time; '+' plans shift from its own date; a no-alarm
        // to-do has no own time/date to keep, so it takes the anchor time (date-for-all plans) or the whole anchor.
        var anchorHours = anchorDate.getHours(), anchorMinutes = anchorDate.getMinutes()
        var shiftFn = SHIFT_DATE[plan] || null                       // null for today / tomorrow / anchor / unknown
        var common = shiftFn ? null : dateForAll(plan, anchorDate, now)  // the single target date of a date-for-all plan
        return todos.map(function(todo){
            var hasDue = todo.due && todo.due > 0
            if (shiftFn){
                // '+' plans: a to-do WITH a due shifts from its OWN date keeping its OWN time; one WITHOUT gets the anchor.
                if (!hasDue) return { id: todo.id, due: anchorTs }
                var own = new Date(todo.due)
                return { id: todo.id, due: combine(shiftFn(dateOnly(own)), own.getHours(), own.getMinutes()) }
            }
            // Date-for-all plans (today / tomorrow / manual): every to-do lands on `common`; a to-do with a due keeps
            // its OWN time, a no-alarm one takes the anchor time.
            if (!hasDue) return { id: todo.id, due: combine(common, anchorHours, anchorMinutes) }
            var ownDated = new Date(todo.due)
            return { id: todo.id, due: combine(common, ownDated.getHours(), ownDated.getMinutes()) }
        })
    }

    /** describeAlarmPlan ******************************************************************************************************************************
     * The one-line, human explanation of what OK will do under the current PLAN + MODE, rendered above the calendar (multi only). Pure so both webviews *
     * show the identical wording and the harness pins it. The date format matches the dialog fields (YYYY-MM-DD, HH:MM).                                *
     ***************************************************************************************************************************************************/
    function describeAlarmPlan(todos, plan, anchor, mode, now){
        todos = Array.isArray(todos) ? todos : []
        now = now || new Date()
        var total = todos.length
        var anchorText = String((anchor && anchor.date) || '') + ' ' + String((anchor && anchor.time) || '')
        anchorText = anchorText.trim()

        // MODE = SAME FOR ALL: one datetime for everything.
        if (mode === 'same') return 'All to-dos -> ' + anchorText + '.'

        var withDue = withDueCount(todos)
        var noDue = total - withDue
        var anchorDate = parseAnchor(anchor)
        var shiftFn = SHIFT_DATE[plan] || null

        if (shiftFn){
            var label = shiftLabel(plan)
            if (withDue === 0) return 'All ' + total + ' to-dos -> ' + anchorText + '.'
            if (noDue === 0) return 'All ' + total + ' to-dos shift ' + label + ' from their own dates, keeping their own times.'
            return withDue + ' to-dos shift ' + label + ' from their own dates; ' + noDue + ' without a due date -> ' + anchorText + '.'
        }

        // Date-for-all plans: the common target date, formatted like the fields.
        var common = anchorDate ? dateForAll(plan, anchorDate, now) : null
        var commonText = common ? isoDate(common) : String((anchor && anchor.date) || '')
        var anchorTimeText = String((anchor && anchor.time) || '')
        if (withDue === 0) return 'All ' + total + ' to-dos -> ' + commonText + ' ' + anchorTimeText + '.'
        if (noDue === 0) return 'All ' + total + ' to-dos -> ' + commonText + ', keeping their own times.'
        return withDue + ' to-dos -> ' + commonText + ' keeping their own times; ' + noDue + ' without a due date -> ' + commonText + ' ' + anchorTimeText + '.'
    }

    api.applyAlarmPlan = applyAlarmPlan
    api.describeAlarmPlan = describeAlarmPlan
    return api
})
