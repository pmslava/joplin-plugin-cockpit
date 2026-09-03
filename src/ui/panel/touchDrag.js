/** README ******************************************************************************************************************************************
 * The DOM-free arithmetic of the mobile touch drag: where a finger sitting at some y lands in a list of rows, and which side of a row it means.      *
 * Kept in ONE pure module - no DOM, no webviewApi - so the panel webview (panelWebview.js, via window.TouchDrag) and the Node test harness (require, *
 * module.exports below) run the SAME decisions, and every boundary below is covered by behavioural tests rather than by reading the source.          *
 *                                                                                                                                                    *
 * WHY THE ROW IS FOUND BY GEOMETRY RATHER THAN BY elementFromPoint. On mobile the checkbox ring is grown to a ~40px content box on a row that is only *
 * ~26px tall (the tap-target rules in panel.css cancel the growth with a negative margin, so the box overhangs its row without moving anything), so    *
 * the element under a finger anywhere in the left column is very often the NEIGHBOUR row's ring. Asking the DOM what is under the finger would        *
 * therefore reschedule the wrong to-do about as often as the right one. The gesture instead builds an index of the rows' boxes and searches it by y,  *
 * which is what these two functions do - and it is exactly the part that would be wrong on a device and invisible in review, so it lives here where   *
 * it can be tested.                                                                                                                                   *
 *                                                                                                                                                    *
 *   bandSide(offsetY, height, band)              which half (or band) of a row a point is in: 'before' (insert above) or 'after' (insert below).      *
 *   rowAtY(index, y)                             the indexed row a viewport y falls on, or null when y is off either end of the list.                 *
 *   movedBeyond(x, y, startX, startY, slop)      whether a point has actually travelled, per axis - the rule the long press cancels a press on.      *
 *   liftDecision(dx, dy, threshold)              which way the finger went first once it passed the LIFT threshold: 'vertical' or 'sideways'.        *
 ***************************************************************************************************************************************************/
;(function(root, factory){
    var api = factory()
    if (typeof module !== 'undefined' && module.exports) module.exports = api        // Node test harness (require)
    if (typeof window !== 'undefined') window.TouchDrag = api                         // panel webview iframe
    else if (root) root.TouchDrag = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict'

    /** bandSide ***************************************************************************************************************************************
     * Which side of a row an offset into it means. `band` is the share of the row's height that counts as "before": the desktop drag uses 0.4 and     *
     * keeps an inert middle between the two zones, while the touch drag uses 0.5, which leaves no middle at all - every point of a row is a live      *
     * target, because a finger is not a cursor and a dead strip in the middle of a 26px row would read as the gesture ignoring you.                   *
     *                                                                                                                                                *
     * The midline itself is 'before' (the test is <=), so the split is total and deterministic; a row of zero height collapses to its top edge, where *
     * that same rule makes every point 'before'; an offset above the row (negative) is 'before' and one past its bottom is 'after', which is what     *
     * makes a point in the GAP between two rows mean "after the row above it" - the same gap as "before the row below it".                            *
     ***********************************************************************************************************************************************/
    function bandSide(offsetY, height, band){
        return offsetY <= height * band ? 'before' : 'after'
    }

    /** rowAtY *****************************************************************************************************************************************
     * The entry of `index` that a viewport y falls on, or null. `index` is the rows in document order, each { top, bottom, ... } and carrying whatever *
     * else the caller needs; only top/bottom are read here, and the rest comes back untouched.                                                         *
     *                                                                                                                                                 *
     * The rows are laid out with gaps between them (the list's row margins), and a finger in a gap belongs to the row ABOVE it - its "after" side, by  *
     * bandSide above - so the search returns the LAST entry whose top is at or above y rather than only an entry strictly containing it. Off either    *
     * end of the list there is nothing to insert against: above the first row's top and at or below the last row's bottom both return null, and so     *
     * does an empty index. Binary search, because the index is rebuilt after every auto-scrolled frame and searched on every touch move.               *
     ***********************************************************************************************************************************************/
    function rowAtY(index, y){
        if (!index || !index.length) return null
        if (y < index[0].top) return null                                  // above the list
        if (y >= index[index.length - 1].bottom) return null               // below the list
        var lo = 0, hi = index.length - 1, found = 0
        while (lo <= hi){
            var mid = (lo + hi) >> 1
            if (index[mid].top <= y){ found = mid; lo = mid + 1 }
            else hi = mid - 1
        }
        return index[found]
    }

    /** movedBeyond ************************************************************************************************************************************
     * Whether a point has travelled more than `slop` from where it began, measured PER AXIS. Exactly `slop` is still still. TWO callers with two        *
     * different numbers, deliberately: the long-press adapter cancels a PRESS on 10px from the press point, and liftDecision below asks the same       *
     * question of the bigger LIFT threshold, from the fire point. One arithmetic, so "has it moved" can never come to mean two things.                 *
     ***********************************************************************************************************************************************/
    function movedBeyond(x, y, startX, startY, slop){
        return Math.abs(x - startX) > slop || Math.abs(y - startY) > slop
    }

    /** liftDecision ***********************************************************************************************************************************
     * Which way the finger went first, once it has travelled far enough to have meant it: 'vertical', 'sideways', or null while it is still inside the *
     * threshold. This is the whole decision the menu-first gesture turns on. The 500ms hold opens the to-do's context menu with the finger still DOWN  *
     * and arms the drag silently behind it; what the finger does NEXT says which of the two the press meant. Up or down LIFTS the row into the drag.   *
     * Sideways throws the arming away - on Android that stroke is Joplin's own side-menu swipe, and the panel has no business deciding it.             *
     *                                                                                                                                                  *
     * THE THRESHOLD IS NOT THE PRESS'S SLOP, and the third Pixel round is why. The travel is measured from the FIRE point - where the finger was when  *
     * the menu opened - and the threshold has to be BIGGER than the 10px the press survived on, or the two gates are the same number from the same     *
     * origin and an armed gesture is born one pixel from its own lift: the smallest drift after the menu appears lifts the row and closes the menu in  *
     * the frame after it opened ("the context menu doesn't appear at all on the long press", "it is moving a little straight away"). The caller passes  *
     * TOUCH_DRAG_LIFT_PX; below it NOTHING decides anything at all, in either direction, and the gesture is still only the open menu.                   *
     *                                                                                                                                                  *
     * "Has it gone far enough" is movedBeyond's rule, per axis, so the two cannot drift apart. The tie - a perfect diagonal, where |dy| equals |dx| -  *
     * goes to VERTICAL, deliberately: a swipe refused here is one flick away from being re-tried, while a lift refused here cannot be recovered without *
     * lifting the finger and pressing again.                                                                                                            *
     ***********************************************************************************************************************************************/
    function liftDecision(dx, dy, threshold){
        if (!movedBeyond(dx, dy, 0, 0, threshold)) return null
        return Math.abs(dy) >= Math.abs(dx) ? 'vertical' : 'sideways'
    }

    return {
        bandSide: bandSide,
        rowAtY: rowAtY,
        movedBeyond: movedBeyond,
        liftDecision: liftDecision,
    }
})
