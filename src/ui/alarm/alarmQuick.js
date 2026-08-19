/** README ******************************************************************************************************************************************
 * Pure, deterministic date/time math for the alarm picker's quick buttons, laid out in TWO fixed rows on both platforms:                             *
 *   Row 1 (absolute dates)         : Today, Tomorrow, Weekends, Next Monday                                                                          *
 *   Row 2 (accumulating increments): +hour, +day, +week, +month(day), +month(date)                                                                  *
 * Shared by BOTH the desktop alarm DIALOG (alarmWebview.js) and the mobile in-panel alarm OVERLAY (panelWebview.js): each is loaded into its own     *
 * webview iframe alongside this file (registered via addScript BEFORE the webview script) and calls window.AlarmQuick.* from its button wiring, so    *
 * the buttons behave identically in both places without forking the math. The very same file is require()d by the Node test harness (module.exports  *
 * below), so every rule here is unit-tested against the owner's acceptance examples.                                                                 *
 *                                                                                                                                                      *
 * Every function takes an explicit `now` (and, where relevant, a `baseDate` and a `preservedTime` of {hours,minutes}|null) - never Date.now() - so the *
 * behaviour is deterministic and testable. All arithmetic is LOCAL-calendar based (Date constructors + setDate/setHours), never millisecond addition,  *
 * so a DST transition shifts no clock time. Each button returns { date: 'YYYY-MM-DD', time: 'HH:MM' }, ready to drop straight into the two text fields. *
 *                                                                                                                                                      *
 * The ACCUMULATOR model (row 2): the multi-select plan is an accumulator {hours, days, weeks, monthsDay, monthsDate}. Each row-2 press increments one  *
 * counter (accumulate); an absolute press or a manual calendar pick RESETS it (the webview sets the plan to a string, discarding the object). Under    *
 * multi RESPECT, applyAlarmPlan shifts each dated to-do from its OWN schedule by the accumulated increments (order: months, then weeks/days, then      *
 * hours), while a no-due to-do starts from ceilHour(now) on today's date; under SAME / single-select the buttons instead write the anchor fields and    *
 * every to-do lands on that one anchor. describeAlarmPlan narrates the accumulator ("+2 days +1 hour from their own schedules").                        *
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
    // time, and the multi-select RESPECT accumulator feeds each to-do's OWN due date through the identical helper (a
    // months-shift applied once per accumulated count) - so single and multi selections shift by the same calendar math.
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

    // Row-1 absolute helpers (date-only Dates). Weekends = the nearest Saturday >= today (today if today is Saturday);
    // Next Monday = the Monday strictly AFTER today (+7 when today already is a Monday). getDay(): Sun=0 .. Sat=6.
    function nextSaturday(now){
        var t = dateOnly(now)
        t.setDate(t.getDate() + ((6 - t.getDay() + 7) % 7))          // 0 when today is Saturday
        return t
    }
    function nextMonday(now){
        var t = dateOnly(now)
        var delta = (1 - t.getDay() + 7) % 7                         // 0 when today is Monday
        t.setDate(t.getDate() + (delta === 0 ? 7 : delta))          // strictly AFTER today
        return t
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

    /** Accumulator ***********************************************************************************************************************************
     * The row-2 plan is an accumulator {hours, days, weeks, monthsDay, monthsDate}. coerceAcc returns a fresh, sanitised copy (non-negative integers,   *
     * never mutating its input) so apply/describe stay pure and a mode round-trip cannot alter it. normalizePlan turns whatever the host passes - an     *
     * accumulator object, a JSON string of one (the desktop hidden field round-trip), a legacy single-shift string ('week'/'monthWeekday'/'monthDate'), *
     * or an absolute string ('today'/'tomorrow'/'weekends'/'nextMonday'/'anchor') - into either { acc } or { str }.                                       *
     ***************************************************************************************************************************************************/
    function coerceAcc(source){
        function count(key){ var value = Number(source && source[key]); return (Number.isFinite(value) && value > 0) ? Math.floor(value) : 0 }
        return { hours: count('hours'), days: count('days'), weeks: count('weeks'), monthsDay: count('monthsDay'), monthsDate: count('monthsDate') }
    }
    function accIsEmpty(acc){ return !(acc.hours || acc.days || acc.weeks || acc.monthsDay || acc.monthsDate) }
    function normalizePlan(plan){
        if (plan && typeof plan === 'object') return { acc: coerceAcc(plan) }
        var text = (plan == null) ? '' : String(plan)
        if (text.charAt(0) === '{'){
            try { var parsed = JSON.parse(text); if (parsed && typeof parsed === 'object') return { acc: coerceAcc(parsed) } } catch (error){}
        }
        if (text === 'week') return { acc: coerceAcc({ weeks: 1 }) }                 // legacy single-shift strings ->
        if (text === 'monthWeekday') return { acc: coerceAcc({ monthsDay: 1 }) }     // single-count accumulators, so an
        if (text === 'monthDate') return { acc: coerceAcc({ monthsDate: 1 }) }       // upgrade-time reload still applies
        if (text === 'today' || text === 'tomorrow' || text === 'weekends' || text === 'nextMonday') return { str: text }
        return { str: 'anchor' }
    }

    // One row-2 press: increment `key` on a COPY of the current plan's accumulator (a fresh accumulator when the plan
    // was an absolute string / anchor - that is the reset an absolute press or calendar pick installs). Pure.
    function accumulate(plan, key){
        var acc = (plan && typeof plan === 'object') ? coerceAcc(plan) : { hours: 0, days: 0, weeks: 0, monthsDay: 0, monthsDate: 0 }
        if (Object.prototype.hasOwnProperty.call(acc, key)) acc[key] = acc[key] + 1
        return acc
    }

    // Apply an accumulator to one datetime, keeping its clock time except as +hour moves it: months-shifts first (each
    // kind applied count times through the single-shift math), then weeks/days as calendar days, then hours last (which
    // may roll the date across midnight - the arithmetic result is kept). Returns a new Date; never mutates `start`.
    function applyAccumulator(start, acc){
        var hours = start.getHours(), minutes = start.getMinutes()
        var datePart = dateOnly(start)
        var i
        for (i = 0; i < acc.monthsDay; i++) datePart = monthWeekdayDate(datePart)
        for (i = 0; i < acc.monthsDate; i++) datePart = monthDateDate(datePart)
        datePart.setDate(datePart.getDate() + 7 * acc.weeks + acc.days)
        var result = new Date(datePart.getFullYear(), datePart.getMonth(), datePart.getDate(), hours, minutes, 0, 0)
        result.setHours(result.getHours() + acc.hours)
        return result
    }

    // The base a no-due to-do accumulates from under RESPECT: today's date at ceilHour(now)'s time (owner's rule -
    // "from the current time to 00 minutes"). Kept on today even when ceilHour(now) itself rolls to 00:00 next day.
    function noDueAccumBase(now){
        var ceil = ceilHour(now)
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), ceil.getHours(), ceil.getMinutes(), 0, 0)
    }

    // The label an accumulator reads as in the explanation line, largest unit first: "+2 days +1 hour".
    function accLabel(acc){
        var parts = []
        if (acc.monthsDay) parts.push('+' + acc.monthsDay + ' month' + (acc.monthsDay > 1 ? 's' : '') + ' (same weekday)')
        if (acc.monthsDate) parts.push('+' + acc.monthsDate + ' month' + (acc.monthsDate > 1 ? 's' : '') + ' (same date)')
        if (acc.weeks) parts.push('+' + acc.weeks + ' week' + (acc.weeks > 1 ? 's' : ''))
        if (acc.days) parts.push('+' + acc.days + ' day' + (acc.days > 1 ? 's' : ''))
        if (acc.hours) parts.push('+' + acc.hours + ' hour' + (acc.hours > 1 ? 's' : ''))
        return parts.join(' ')
    }

    // The "date for all" target date (date-only) for an absolute plan: today, tomorrow, the nearest Saturday, the next
    // Monday, or - for a manual pick / no button pressed ('anchor', or any unrecognised value) - the anchor's own date.
    function dateForAll(plan, anchorDate, now){
        if (plan === 'today') return dateOnly(now)
        if (plan === 'tomorrow'){ var t = dateOnly(now); t.setDate(t.getDate() + 1); return t }
        if (plan === 'weekends') return nextSaturday(now)
        if (plan === 'nextMonday') return nextMonday(now)
        return dateOnly(anchorDate)                                  // 'anchor' / manual / unknown
    }

    function withDueCount(todos){
        var count = 0
        for (var i = 0; i < todos.length; i++){ if (todos[i] && todos[i].due && todos[i].due > 0) count++ }
        return count
    }

    var api = {
        ceilHour: ceilHour,
        nextSaturday: nextSaturday,
        nextMonday: nextMonday,
        accumulate: accumulate,

        // --- Row 1: absolute dates ---------------------------------------------------------------------------------

        // Today - date+time = ceilHour(now) + 1 hour, ALWAYS (ignores preservedTime). The arithmetic is kept as is,
        // so a late press crossing midnight (23:30 -> 01:00) lands on the next day at 01:00.
        today: function(now){
            var target = ceilHour(now)
            target.setHours(target.getHours() + 1)
            return { date: isoDate(target), time: isoTime(target) }
        },

        // Tomorrow - date = today + 1 day; time = preserved, else ceilHour(now).
        tomorrow: function(now, preservedTime){
            var target = new Date(now.getFullYear(), now.getMonth(), now.getDate())
            target.setDate(target.getDate() + 1)
            return { date: isoDate(target), time: buttonTime(now, preservedTime) }
        },

        // Weekends - date = the nearest Saturday >= today; time = preserved, else ceilHour(now).
        weekends: function(now, preservedTime){
            return { date: isoDate(nextSaturday(now)), time: buttonTime(now, preservedTime) }
        },

        // Next Monday - date = the Monday strictly AFTER today; time = preserved, else ceilHour(now).
        monday: function(now, preservedTime){
            return { date: isoDate(nextMonday(now)), time: buttonTime(now, preservedTime) }
        },

        // --- Row 2: accumulating increments (single-select / SAME field writes; one increment per press) -----------

        // +hour - baseDate at (preserved, else ceilHour(now)) + 1 hour; rolls the date when it crosses midnight.
        // Repeated presses compound because each writes the field the next press reads (the webview marks the time set).
        hour: function(now, baseDate, preservedTime){
            var clockHours, clockMinutes
            if (preservedTime && Number.isFinite(preservedTime.hours) && Number.isFinite(preservedTime.minutes)){
                clockHours = preservedTime.hours; clockMinutes = preservedTime.minutes
            } else {
                var ceil = ceilHour(now); clockHours = ceil.getHours(); clockMinutes = ceil.getMinutes()
            }
            var target = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), clockHours, clockMinutes, 0, 0)
            target.setHours(target.getHours() + 1)
            return { date: isoDate(target), time: isoTime(target) }
        },

        // +day - date = baseDate + 1 day; time = preserved, else ceilHour(now). Compounds like +week.
        day: function(now, baseDate, preservedTime){
            var target = dateOnly(baseDate)
            target.setDate(target.getDate() + 1)
            return { date: isoDate(target), time: buttonTime(now, preservedTime) }
        },

        // +week - date = baseDate + 7 days; time = preserved, else ceilHour(now). Repeated presses walk forward
        // because the caller feeds each result's date back as the next baseDate.
        week: function(now, baseDate, preservedTime){
            return { date: isoDate(weekDate(baseDate)), time: buttonTime(now, preservedTime) }
        },

        // +month(day) - the same weekday-ordinal in baseDate's FOLLOWING month (a 2nd Sunday stays a 2nd Sunday;
        // ordinal n = floor((dayOfMonth-1)/7)). When that month has no nth occurrence (a 5th one), the LAST
        // occurrence of that weekday is used instead. time = preserved, else ceilHour(now).
        monthWeekday: function(now, baseDate, preservedTime){
            return { date: isoDate(monthWeekdayDate(baseDate)), time: buttonTime(now, preservedTime) }
        },

        // +month(date) - the same day-of-month in baseDate's FOLLOWING month (Jan 9 -> Feb 9); a day the next
        // month lacks (Jan 31 -> Feb) clamps to that month's last day. time = preserved, else ceilHour(now).
        monthDate: function(now, baseDate, preservedTime){
            return { date: isoDate(monthDateDate(baseDate)), time: buttonTime(now, preservedTime) }
        },
    }

    /** applyAlarmPlan *********************************************************************************************************************************
     * The multi-select engine: turns the picker's current PLAN + MODE + anchor into the final due timestamp of every selected to-do. Pure and         *
     * deterministic (all inputs explicit, no Date.now()), so the host computes the exact per-to-do values through it and the harness pins every case.  *
     *   todos  : [{ id, due }] - each selected to-do's CURRENT due timestamp (0 = no alarm), as the host holds them.                                    *
     *   plan   : an ACCUMULATOR object {hours,days,weeks,monthsDay,monthsDate} (or its JSON string), OR an absolute string 'today'|'tomorrow'|          *
     *            'weekends'|'nextMonday'|'anchor' (a manual pick / no press). Legacy 'week'|'monthWeekday'|'monthDate' map to single-count accumulators. *
     *   anchor : { date:'YYYY-MM-DD', time:'HH:MM' } - the calendar+time fields; the fallback datetime for a no-alarm to-do under an absolute plan, and  *
     *            the one datetime every to-do gets under SAME.                                                                                           *
     *   mode   : 'respect' (default for multi: each to-do keeps its OWN schedule; an accumulator shifts from its OWN datetime) | 'same' (every to-do     *
     *            gets the single anchor datetime - the 1.8.3 behaviour and the single-select path).                                                       *
     *   now    : the reference Date for today / tomorrow / weekends / next-Monday / the no-due accumulator base.                                          *
     * Returns [{ id, due }] in the input order. A single-select selection is a one-element todos with mode 'same', reproducing 1.8.3 exactly.            *
     ***************************************************************************************************************************************************/
    function applyAlarmPlan(todos, plan, anchor, mode, now){
        todos = Array.isArray(todos) ? todos : []
        now = now || new Date()
        var anchorDate = parseAnchor(anchor)
        // A malformed anchor cannot happen in practice (the host validates the fields before calling), but stay
        // pure and total: with no valid anchor there is no datetime to apply, so leave every to-do unchanged-shaped.
        if (!anchorDate) return todos.map(function(todo){ return { id: todo.id, due: todo.due && todo.due > 0 ? todo.due : 0 } })
        var anchorTs = anchorDate.getTime()

        // MODE = SAME FOR ALL: every selected to-do gets the one anchor datetime (plan ignored) - the 1.8.3 behaviour,
        // and the single-select path. The accumulator / absolute buttons wrote the anchor fields directly in this mode.
        if (mode === 'same') return todos.map(function(todo){ return { id: todo.id, due: anchorTs } })

        // MODE = RESPECT (default): each to-do keeps its own schedule.
        var norm = normalizePlan(plan)
        if (norm.acc && !accIsEmpty(norm.acc)){
            // Accumulator: a dated to-do shifts from its OWN datetime; a no-due one from today at ceilHour(now)'s time.
            var acc = norm.acc
            var noDueBase = noDueAccumBase(now)
            return todos.map(function(todo){
                var start = (todo.due && todo.due > 0) ? new Date(todo.due) : noDueBase
                return { id: todo.id, due: applyAccumulator(start, acc).getTime() }
            })
        }
        // Absolute date-for-all plan: every to-do lands on `common`; a dated one keeps its OWN time, a no-alarm one
        // takes the anchor time.
        var anchorHours = anchorDate.getHours(), anchorMinutes = anchorDate.getMinutes()
        var common = dateForAll(norm.str, anchorDate, now)
        return todos.map(function(todo){
            var hasDue = todo.due && todo.due > 0
            if (!hasDue) return { id: todo.id, due: combine(common, anchorHours, anchorMinutes) }
            var ownDated = new Date(todo.due)
            return { id: todo.id, due: combine(common, ownDated.getHours(), ownDated.getMinutes()) }
        })
    }

    /** describeAlarmPlan ******************************************************************************************************************************
     * The one-line, human explanation of what OK will do under the current PLAN + MODE, rendered below the mode picker (multi only). Pure so both      *
     * webviews show the identical wording and the harness pins it. The date format matches the dialog fields (YYYY-MM-DD, HH:MM).                       *
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
        var norm = normalizePlan(plan)

        if (norm.acc && !accIsEmpty(norm.acc)){
            // Accumulator narration: the dated to-dos shift from their own schedules; the no-due ones land on one
            // concrete datetime (today at ceilHour(now), then the accumulated shifts).
            var acc = norm.acc
            var label = accLabel(acc)
            var noDueResult = applyAccumulator(noDueAccumBase(now), acc)
            var noDueText = isoDate(noDueResult) + ' ' + isoTime(noDueResult)
            if (withDue === 0) return 'All ' + total + ' to-dos -> ' + noDueText + '.'
            if (noDue === 0) return 'All ' + total + ' to-dos shift ' + label + ' from their own schedules.'
            return withDue + ' to-dos shift ' + label + ' from their own schedules; ' + noDue + ' without a due date -> ' + noDueText + '.'
        }

        // Absolute date-for-all plans: the common target date, formatted like the fields.
        var common = anchorDate ? dateForAll(norm.str, anchorDate, now) : null
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
