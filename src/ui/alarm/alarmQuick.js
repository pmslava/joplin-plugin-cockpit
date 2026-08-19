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

    return {
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
            var target = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate())
            target.setDate(target.getDate() + 7)
            return { date: isoDate(target), time: buttonTime(now, preservedTime) }
        },

        // 4. +month(day) - the same weekday-ordinal in baseDate's FOLLOWING month (a 2nd Sunday stays a 2nd Sunday;
        //    ordinal n = floor((dayOfMonth-1)/7)). When that month has no nth occurrence (a 5th one), the LAST
        //    occurrence of that weekday is used instead. time = preserved, else ceilHour(now).
        monthWeekday: function(now, baseDate, preservedTime){
            var weekday = baseDate.getDay()
            var ordinal = Math.floor((baseDate.getDate() - 1) / 7)          // 0-based: 0 = first occurrence
            var first = firstOfNextMonth(baseDate)
            var day = 1 + ((weekday - first.getDay() + 7) % 7) + ordinal * 7
            var count = daysInMonth(first)
            while (day > count) day -= 7                                     // no nth occurrence -> step back to the last
            var target = new Date(first.getFullYear(), first.getMonth(), day)
            return { date: isoDate(target), time: buttonTime(now, preservedTime) }
        },

        // 5. +month(date) - the same day-of-month in baseDate's FOLLOWING month (Jan 9 -> Feb 9); a day the next
        //    month lacks (Jan 31 -> Feb) clamps to that month's last day. time = preserved, else ceilHour(now).
        monthDate: function(now, baseDate, preservedTime){
            var first = firstOfNextMonth(baseDate)
            var day = Math.min(baseDate.getDate(), daysInMonth(first))
            var target = new Date(first.getFullYear(), first.getMonth(), day)
            return { date: isoDate(target), time: buttonTime(now, preservedTime) }
        },
    }
})
