/** README ******************************************************************************************************************************************
 * Pure, deterministic date/time math for the "drop BETWEEN rows" gesture (desktop list views). Dropping one or more to-dos into the gap between two   *
 * temporal neighbours assigns each a due datetime that sits IN BETWEEN the neighbours' dues, so the visual order the user pointed at becomes the       *
 * chronological order on the next refresh.                                                                                                            *
 *                                                                                                                                                      *
 * Two layers, both pure (every input explicit, never Date.now(), all arithmetic LOCAL-calendar based so a DST transition shifts no clock time):        *
 *   betweenDue(lo, hi, dayStartMinutes)        - ONE datetime strictly inside the open interval (lo, hi), by the owner's rules below.                  *
 *   sequenceBetween(lo, hi, count, dayStart)   - `count` datetimes for a multi-drag, each computed against the previous result so they strictly        *
 *                                                 increase and keep the dragged order (t1 = betweenDue(lo,hi); t_n = betweenDue(t_{n-1}, hi)).          *
 *   betweenBounds(prevDue, nextDue, date, dm)  - resolves the (lo, hi) the host feeds the two functions above from the FRESH neighbour dues and, at a  *
 *                                                 group edge (a missing neighbour), an anchoring day: the group's date, or - for a DATELESS group      *
 *                                                 (Overdue/Future) - the day of the present neighbour's own due. Kept here so the rules are unit-tested. *
 *                                                                                                                                                      *
 * betweenDue rules (owner-specified):                                                                                                                  *
 *   1. If at least one full calendar day lies strictly between dayOf(lo) and dayOf(hi): the MIDPOINT day (floor of the day-range midpoint) at the       *
 *      day-start time. e.g. between 2022-01-08 and 2022-01-10 -> 2022-01-09 09:00; between 2022-01-08 and 2022-01-15 -> 2022-01-11 09:00.               *
 *   2. Else (same day or adjacent days): prefer a whole hour (:00) strictly inside (lo, hi), the one nearest the interval midpoint (tie -> earlier).    *
 *      If no :00 fits, the minute midpoint of (lo, hi), rounded to whole minutes. If the interval is degenerate (equal or inverted), lo unchanged       *
 *      (the row is left unmoved in time and merely reordered visually on the next refresh).                                                            *
 *                                                                                                                                                      *
 * The very same file is require()d by the Node test harness (module.exports below) and bundled into the host by webpack (require("../../core/between") *
 * in panel.ts), so every rule here is unit-tested against the owner's acceptance examples AND drives the real drop path.                               *
 ***************************************************************************************************************************************************/
;(function(root, factory){
    var api = factory()
    if (typeof module !== 'undefined' && module.exports) module.exports = api        // Node test harness (require)
    if (typeof window !== 'undefined') window.CockpitBetween = api                    // harmless webview export (unused there)
    else if (root) root.CockpitBetween = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict'

    var DAY_MS = 86400000
    var HOUR_MS = 3600000
    var MINUTE_MS = 60000

    // Local midnight (00:00) of the day a timestamp falls on.
    function startOfDay(ts){ var d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime() }

    // Whole number of calendar days from day(lo) to day(hi); DST-safe via the rounded midnight difference.
    function dayDiff(lo, hi){ return Math.round((startOfDay(hi) - startOfDay(lo)) / DAY_MS) }

    // Clamp an arbitrary minutes-of-day into [0, 1439]; a non-finite value falls back to 09:00 (540).
    function normMinutes(minutes){
        var value = Number(minutes)
        if (!Number.isFinite(value)) return 540
        value = Math.floor(value)
        if (value < 0) return 0
        if (value > 1439) return 1439
        return value
    }

    // A local timestamp on (day-of baseTs) + dayOffset days, at the given minutes-of-day. Built from calendar parts so a
    // DST transition on an intermediate day shifts no clock time.
    function dayAtMinutes(baseTs, dayOffset, dayStartMinutes){
        var d = new Date(baseTs)
        return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, Math.floor(dayStartMinutes / 60), dayStartMinutes % 60, 0, 0).getTime()
    }

    // The whole local hour (:00) strictly inside (lo, hi) nearest the interval midpoint, or null when none fits. Ties go
    // to the earlier hour: candidates are walked ascending and only a STRICTLY smaller distance replaces the incumbent.
    // The hour step is a local setHours(+1) (DST-safe), and rule 2 only ever calls this with hi - lo < ~48h, so the
    // guarded walk is short.
    function nearestWholeHour(lo, hi){
        var mid = (lo + hi) / 2
        var start = new Date(lo)
        var cand = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), 0, 0, 0)
        if (cand.getTime() <= lo) cand.setHours(cand.getHours() + 1)          // first whole hour STRICTLY after lo
        var best = null, bestDist = Infinity, guard = 0
        while (cand.getTime() < hi && guard < 240){
            var t = cand.getTime()
            var dist = Math.abs(t - mid)
            if (dist < bestDist){ bestDist = dist; best = t }                 // strict < => earliest of any equal-distance pair wins
            cand.setHours(cand.getHours() + 1)
            guard++
        }
        return best
    }

    /** betweenDue **************************************************************************************************************************************
     * One datetime (ms) strictly inside the open interval (lo, hi), by the owner's two rules. Degenerate (hi <= lo) returns lo unchanged.               *
     ***************************************************************************************************************************************************/
    function betweenDue(lo, hi, dayStartMinutes){
        dayStartMinutes = normMinutes(dayStartMinutes)
        if (!(hi > lo)) return lo                                             // degenerate: equal or inverted -> unmoved
        var diff = dayDiff(lo, hi)
        if (diff >= 2){
            // Rule 1: a full calendar day lies strictly between -> the midpoint day (floor) at the day-start time. The
            // midpoint day is strictly between day(lo) and day(hi), so any time on it is strictly inside (lo, hi).
            return dayAtMinutes(lo, Math.floor(diff / 2), dayStartMinutes)
        }
        // Rule 2: same day or adjacent days -> prefer a whole hour, else the minute midpoint.
        var hour = nearestWholeHour(lo, hi)
        if (hour !== null) return hour
        return Math.round(((lo + hi) / 2) / MINUTE_MS) * MINUTE_MS
    }

    /** sequenceBetween ********************************************************************************************************************************
     * `count` datetimes for a multi-drag, in dragged order: each is computed against the PREVIOUS result as the new lower bound, so they strictly       *
     * increase and never collide (t1 = betweenDue(lo, hi); t_n = betweenDue(t_{n-1}, hi)).                                                              *
     ***************************************************************************************************************************************************/
    function sequenceBetween(lo, hi, count, dayStartMinutes){
        var out = []
        var currentLo = lo
        for (var i = 0; i < count; i++){
            var t = betweenDue(currentLo, hi, dayStartMinutes)
            out.push(t)
            currentLo = t
        }
        return out
    }

    /** betweenBounds **********************************************************************************************************************************
     * The (lo, hi) the host feeds betweenDue / sequenceBetween, resolved from the FRESH neighbour dues (prevDue above the gap, nextDue below it; each 0  *
     * when that neighbour is absent) and, at a group edge, the anchoring DAY. The day is the group's own date (a local 'YYYY-MM-DD') for a dated group,  *
     * or - when the group is DATELESS (Overdue/Future, no date) - the day of the single present neighbour's own due. Returns null only when no interval  *
     * can be formed at all (an edge with no date AND no neighbour to borrow a day from): the host then writes nothing.                                   *
     *   - Interior (both neighbours present) : (prevDue, nextDue) - no day needed, so dated AND dateless groups both work.                                *
     *   - Bottom edge (no next)              : (prevDue, day@23:59), day = group date else day-of(prevDue).                                              *
     *   - Top edge (no prev)                 : (day@day-start, nextDue), day = group date else day-of(nextDue); if day-start >= nextDue, (day@00:00, ..). *
     *   - Both absent (no neighbours)        : the whole group day, (day@day-start, day@23:59) - only when a real group date is present, else null.       *
     ***************************************************************************************************************************************************/
    function betweenBounds(prevDue, nextDue, groupDate, dayStartMinutes){
        dayStartMinutes = normMinutes(dayStartMinutes)
        var prev = (prevDue && prevDue > 0) ? prevDue : 0
        var next = (nextDue && nextDue > 0) ? nextDue : 0
        // Interior (both neighbours present): the pure open interval, no day context needed - so this works in ANY
        // group, dated or not (Overdue/Future included; that is the whole point of relaxing the eligibility gate).
        if (prev && next) return { lo: prev, hi: next }
        // An edge needs a DAY to anchor the open end. Prefer the group's own calendar date (dated groups); when the
        // group is DATELESS (Overdue/Future) derive the day from the single present neighbour's due instead.
        var parts = groupDate ? String(groupDate).split('-').map(Number) : null
        var haveDate = !!(parts && parts.length === 3 && parts.every(Number.isFinite))
        // A day-anchored timestamp: from the group date when there is one, else from the given neighbour timestamp.
        // Built from calendar parts so a DST transition shifts no clock time.
        function anchorDay(baseTs){ return haveDate ? new Date(parts[0], parts[1] - 1, parts[2]) : new Date(baseTs) }
        function dayStartOf(baseTs){ var d = anchorDay(baseTs); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(dayStartMinutes / 60), dayStartMinutes % 60, 0, 0).getTime() }
        function midnightOf(baseTs){ var d = anchorDay(baseTs); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime() }
        function endOfDayOf(baseTs){ var d = anchorDay(baseTs); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 0, 0).getTime() }
        if (prev) return { lo: prev, hi: endOfDayOf(prev) }                   // bottom edge: (lastDue, day-of@23:59)
        if (next){                                                            // top edge: (day-of@day-start, firstDue)
            var lo = dayStartOf(next)
            if (lo >= next) lo = midnightOf(next)                             // fall through to (day-of@00:00, firstDue)
            return { lo: lo, hi: next }
        }
        // No neighbours at all: only placeable when the group carries a real date (spread across that whole day).
        if (haveDate) return { lo: dayStartOf(0), hi: endOfDayOf(0) }
        return null                                                          // dateless AND no neighbours -> host writes nothing
    }

    return {
        betweenDue: betweenDue,
        sequenceBetween: sequenceBetween,
        betweenBounds: betweenBounds,
    }
})
