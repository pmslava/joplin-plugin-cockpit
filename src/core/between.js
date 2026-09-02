/** README ******************************************************************************************************************************************
 * Pure, deterministic date/time math for the "drop BETWEEN rows" gesture (desktop list views). Dropping one or more to-dos into the gap between two   *
 * temporal neighbours assigns each a due datetime that sits IN BETWEEN the neighbours' dues, so the visual order the user pointed at becomes the       *
 * chronological order on the next refresh.                                                                                                            *
 *                                                                                                                                                      *
 * Two layers, both pure (every input explicit, never Date.now(), all arithmetic LOCAL-calendar based so a DST transition shifts no clock time):        *
 *   betweenDue(lo, hi, dayStartMinutes)        - ONE datetime strictly inside the open interval (lo, hi), by the owner's rules below.                  *
 *   sequenceBetween(lo, hi, count, dayStart)   - `count` datetimes for a multi-drag by EQUAL DIVISION of (lo, hi): N notes split the interval into      *
 *                                                 N+1 equal parts, note k at lo + k*(hi-lo)/(N+1), keeping the dragged order and strictly increasing.   *
 *   betweenBounds(prev, next, date, dm, end)   - resolves the (lo, hi) the host feeds the two functions above from the FRESH neighbour dues and, at a  *
 *                                                 group edge (a missing neighbour), an anchoring day: the group's date, or - for a DATELESS group      *
 *                                                 (Overdue/Future) - the day of the present neighbour's own due. A group that spans MORE than one day  *
 *                                                 (an interval period section, whose date is the FIRST day of its slice) also passes `end`, the last   *
 *                                                 day of that span, which anchors the bottom edge. Kept here so the rules are unit-tested.             *
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

    /** snapToWholeHour ********************************************************************************************************************************
     * The whole LOCAL hour (:00) nearest a timestamp; the half-hour rounds up. Built from calendar parts so a DST transition shifts no clock time.      *
     ***************************************************************************************************************************************************/
    function snapToWholeHour(ts){
        var d = new Date(ts)
        var snapped = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), 0, 0, 0)
        if (d.getMinutes() >= 30) snapped.setHours(snapped.getHours() + 1)    // >= :30 rounds up to the next hour
        return snapped.getTime()
    }

    /** sequenceBetween ********************************************************************************************************************************
     * `count` datetimes for a multi-drag, in dragged order (note k follows the dragged sequence), by EQUAL DIVISION of the open interval (lo, hi).      *
     *   - count <= 1 : the approved single-drop, betweenDue(lo, hi) verbatim (free-day midpoint / :00-preference / minute midpoint). N=1 is the          *
     *                  midpoint anyway, so equal division agrees; the :00-snapping and free-day rules stay exactly as shipped.                          *
     *   - DAY-SCALE (D = free calendar days strictly between day(lo) and day(hi), when D >= N): place the N notes on N DISTINCT free days at the         *
     *                  day-start time, evenly spread - free-day index_k = floor(k*(D+1)/(N+1)) into the ordered list day(lo)+1 .. day(lo)+D (1-based).   *
     *                  DISTINCT for D>=N: the real step (D+1)/(N+1) >= 1, and floor(x+s) >= floor(x+1) = floor(x)+1 for s>=1, so the indices strictly     *
     *                  increase; index_1 = floor((D+1)/(N+1)) >= 1 and index_N = floor(N(D+1)/(N+1)) <= D (N<=D => N(D+1) <= D(N+1)), so every index      *
     *                  lands in [1, D] and every chosen day is strictly between day(lo) and day(hi) - hence strictly inside (lo, hi) at any time on it.   *
     *   - TIME-SCALE (same/adjacent day, or 0 <= D < N): equal division - note k at lo + k*(hi-lo)/(N+1), rounded to whole minutes and clamped monotone  *
     *                  non-decreasing into [lo, hi] (a genuinely narrow interval that cannot fit N distinct minutes ties, and never inverts). NICETY: if  *
     *                  snapping every point to its nearest whole hour (:00) keeps the set strictly increasing, strictly inside (lo, hi) and all          *
     *                  distinct, the snapped set is used; otherwise the plain minute-rounded points stand.                                              *
     * A degenerate interval (hi <= lo) leaves every note at lo (unmoved, ties), consistent with betweenDue.                                             *
     ***************************************************************************************************************************************************/
    function sequenceBetween(lo, hi, count, dayStartMinutes){
        dayStartMinutes = normMinutes(dayStartMinutes)
        var n = Math.floor(Number(count))
        if (!Number.isFinite(n) || n <= 0) return []
        if (n === 1) return [betweenDue(lo, hi, dayStartMinutes)]              // N=1: the approved single-drop, unchanged
        if (!(hi > lo)){                                                       // degenerate: every note sits at lo (ties, unmoved)
            var flat = []
            for (var f = 0; f < n; f++) flat.push(lo)
            return flat
        }
        // DAY-SCALE: at least N free calendar days lie strictly between day(lo) and day(hi) -> one note per distinct free day.
        var freeDays = dayDiff(lo, hi) - 1
        if (freeDays >= n){
            var days = []
            for (var k = 1; k <= n; k++){
                var idx = Math.floor(k * (freeDays + 1) / (n + 1))            // 1-based free-day position, provably in [1, D] & distinct
                days.push(dayAtMinutes(lo, idx, dayStartMinutes))
            }
            return days
        }
        // TIME-SCALE: equal division into N+1 parts, minute-rounded and clamped monotone non-decreasing into [lo, hi].
        var minute = []
        var prevPoint = lo
        for (var j = 1; j <= n; j++){
            var r = Math.round((lo + j * (hi - lo) / (n + 1)) / MINUTE_MS) * MINUTE_MS
            if (r < lo) r = lo
            if (r > hi) r = hi
            if (r < prevPoint) r = prevPoint                                  // defensive: rounding is already monotone
            minute.push(r)
            prevPoint = r
        }
        // NICETY: prefer the whole-hour-snapped set when it stays strictly increasing, strictly inside (lo, hi), and distinct.
        var snapped = minute.map(snapToWholeHour)
        var usable = true
        for (var s = 0; s < snapped.length; s++){
            if (!(snapped[s] > lo && snapped[s] < hi)){ usable = false; break }
            if (s > 0 && !(snapped[s] > snapped[s - 1])){ usable = false; break }
        }
        return usable ? snapped : minute
    }

    // The [year, month, day] of a local 'YYYY-MM-DD', or null when there is no usable date.
    function dateParts(iso){
        var parts = iso ? String(iso).split('-').map(Number) : null
        return (parts && parts.length === 3 && parts.every(Number.isFinite)) ? parts : null
    }

    /** betweenBounds **********************************************************************************************************************************
     * The (lo, hi) the host feeds betweenDue / sequenceBetween, resolved from the FRESH neighbour dues (prevDue above the gap, nextDue below it; each 0  *
     * when that neighbour is absent) and, at a group edge, the anchoring DAY. The day is the group's own date (a local 'YYYY-MM-DD') for a dated group,  *
     * or - when the group is DATELESS (Overdue/Future, no date) - the day of the single present neighbour's own due. Returns null only when no interval  *
     * can be formed at all (an edge with no date AND no neighbour to borrow a day from): the host then writes nothing.                                   *
     * A group that spans a STRETCH of days rather than one day - an interval period section, whose `groupDate` is the FIRST day of its slice - passes    *
     * its last day as `groupEndDate`, and the two ends then use their own anchor. Without it a bottom-edge drop under "This Month" would be bounded by   *
     * the slice's first day, which lies BEFORE the group's own rows: an inverted interval, and every dropped to-do pinned to its neighbour's due.        *
     *   - Interior (both neighbours present) : (prevDue, nextDue) - no day needed, so dated AND dateless groups both work.                                *
     *   - Bottom edge (no next)              : (prevDue, day@23:59), day = group END date else group date else day-of(prevDue).                           *
     *   - Top edge (no prev)                 : (day@day-start, nextDue), day = group date else day-of(nextDue); if day-start >= nextDue, (day@00:00, ..). *
     *   - Both absent (no neighbours)        : the whole group span, (first day@day-start, last day@23:59) - only with a real group date, else null.       *
     ***************************************************************************************************************************************************/
    function betweenBounds(prevDue, nextDue, groupDate, dayStartMinutes, groupEndDate){
        dayStartMinutes = normMinutes(dayStartMinutes)
        var prev = (prevDue && prevDue > 0) ? prevDue : 0
        var next = (nextDue && nextDue > 0) ? nextDue : 0
        // Interior (both neighbours present): the pure open interval, no day context needed - so this works in ANY
        // group, dated or not (Overdue/Future included; that is the whole point of relaxing the eligibility gate).
        if (prev && next) return { lo: prev, hi: next }
        // An edge needs a DAY to anchor the open end. Prefer the group's own calendar date (dated groups); when the
        // group is DATELESS (Overdue/Future) derive the day from the single present neighbour's due instead.
        var parts = dateParts(groupDate)
        var haveDate = !!parts
        // The group's LAST day, for the bottom edge. A one-day group sends none (or the same day), and then the top
        // anchor doubles as the bottom one exactly as before.
        var endParts = dateParts(groupEndDate) || parts
        // A day-anchored timestamp: from the group date when there is one, else from the given neighbour timestamp.
        // Built from calendar parts so a DST transition shifts no clock time.
        function anchorDay(baseTs){ return haveDate ? new Date(parts[0], parts[1] - 1, parts[2]) : new Date(baseTs) }
        function anchorEndDay(baseTs){ return haveDate ? new Date(endParts[0], endParts[1] - 1, endParts[2]) : new Date(baseTs) }
        function dayStartOf(baseTs){ var d = anchorDay(baseTs); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(dayStartMinutes / 60), dayStartMinutes % 60, 0, 0).getTime() }
        function midnightOf(baseTs){ var d = anchorDay(baseTs); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime() }
        function endOfDayOf(baseTs){ var d = anchorEndDay(baseTs); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 0, 0).getTime() }
        if (prev) return { lo: prev, hi: endOfDayOf(prev) }                   // bottom edge: (lastDue, last-day@23:59)
        if (next){                                                            // top edge: (day-of@day-start, firstDue)
            var lo = dayStartOf(next)
            if (lo >= next) lo = midnightOf(next)                             // fall through to (day-of@00:00, firstDue)
            return { lo: lo, hi: next }
        }
        // No neighbours at all: only placeable when the group carries a real date - spread across the group's whole
        // span, which for a one-day group is that day and for a period slice is first day @day-start .. last day.
        if (haveDate) return { lo: dayStartOf(0), hi: endOfDayOf(0) }
        return null                                                          // dateless AND no neighbours -> host writes nothing
    }

    return {
        betweenDue: betweenDue,
        sequenceBetween: sequenceBetween,
        betweenBounds: betweenBounds,
    }
})
