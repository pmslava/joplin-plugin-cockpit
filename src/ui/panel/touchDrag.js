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
 *   movedBeyond(x, y, startX, startY, slop)      whether a finger has actually travelled, per axis - the same rule the long press cancels on.         *
 *   firstMoveDirection(dx, dy, slop)             which way the finger went FIRST once it left the slop: 'vertical' (lift) or 'sideways'.              *
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
     * Whether a point has travelled more than `slop` from where the gesture began, measured PER AXIS - the same rule (and the same 10px) the long-press *
     * adapter cancels a press on, so "held still" means the same thing to the press and to the drag it lifts into. Exactly `slop` is still still.       *
     ***********************************************************************************************************************************************/
    function movedBeyond(x, y, startX, startY, slop){
        return Math.abs(x - startX) > slop || Math.abs(y - startY) > slop
    }

    /** firstMoveDirection *****************************************************************************************************************************
     * Which way the finger went FIRST, once it has gone anywhere at all: 'vertical', 'sideways', or null while it is still inside the slop. This is   *
     * the whole decision the menu-first gesture turns on. The 500ms hold opens the to-do's context menu with the finger still DOWN and arms the drag  *
     * silently behind it; what the finger does next says which of the two the press meant. Up or down LIFTS the row into the drag. Sideways is left   *
     * strictly alone - on Android that stroke is Joplin's own side-menu swipe, and a panel that fought it would break the app's navigation to save   *
     * its own gesture - so the arming is simply thrown away and nothing is prevented.                                                                 *
     *                                                                                                                                                 *
     * "Has it moved at all" is movedBeyond's rule, per axis, so it means exactly what the long press means by it. The tie - a perfect diagonal, where *
     * |dy| equals |dx| - goes to VERTICAL, deliberately: a swipe refused here is one flick away from being re-tried, while a lift refused here cannot *
     * be recovered without lifting the finger and pressing again.                                                                                     *
     ***********************************************************************************************************************************************/
    function firstMoveDirection(dx, dy, slop){
        if (!movedBeyond(dx, dy, 0, 0, slop)) return null
        return Math.abs(dy) >= Math.abs(dx) ? 'vertical' : 'sideways'
    }

    return {
        bandSide: bandSide,
        rowAtY: rowAtY,
        movedBeyond: movedBeyond,
        firstMoveDirection: firstMoveDirection,
    }
})
