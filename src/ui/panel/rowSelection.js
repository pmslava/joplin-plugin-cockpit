/** README ******************************************************************************************************************************************
 * The rules that decide WHICH ROWS the panel has selected. Kept in ONE pure module - no DOM, no webviewApi - so the panel webview (panelWebview.js,  *
 * via window.RowSelection) and the Node test harness (require, module.exports below) run the SAME decisions, and every case below is covered by       *
 * behavioural tests rather than by reading the source.                                                                                               *
 *                                                                                                                                                    *
 * ONE SELECTION, BOTH KINDS. A panel row is either a to-do (data-todo-id) or a regular note (data-note-id), and BOTH take part in the selection: a    *
 * plain press selects, Ctrl/Cmd toggles, Shift takes the range, and a mixed to-do+note selection is ordinary. The rules here never ask which kind a   *
 * row is - an id is an id - which is exactly what makes the two row handlers in the webview one shared path instead of two drifting copies. Up to     *
 * 2.0.0 only to-do rows participated (a pressed note row cleared the selection and lit the highlight-only pickedNoteID instead), so this module is    *
 * where "notes select too" actually lives.                                                                                                            *
 *                                                                                                                                                    *
 * WHERE THE KIND *DOES* MATTER: TIME. Only a to-do has a due date, so the drag-to-date / drop-between / set-alarm payloads are the TO-DOS WITHIN the  *
 * selection - schedulableIDs below - and the notes are silently dropped from them. Everything else a selection drives (delete, move, tags, duplicate, *
 * switch type, copy) takes an id array of either kind and needs no filtering at all.                                                                  *
 *                                                                                                                                                    *
 * TWO ANCHORS, DELIBERATELY. `lastClicked` is the SHIFT-RANGE anchor: it stays put while a range is resized, so a further Shift+press grows or shrinks *
 * the range instead of chaining from its end. `lastInteraction` is the row of the most recent press that actually SELECTED something - a plain press, *
 * a Ctrl+press that ADDED a row, or the far end of a Shift range, never the anchor it was measured from and never a Ctrl+press that DESELECTED - and   *
 * it is the row an Escape collapses a multi-selection onto (see EditorNote.collapseSelection).                                                         *
 ***************************************************************************************************************************************************/
;(function(root, factory){
    var api = factory()
    if (typeof module !== 'undefined' && module.exports) module.exports = api        // Node test harness (require)
    if (typeof window !== 'undefined') window.RowSelection = api                      // panel webview iframe
    else if (root) root.RowSelection = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict'

    function idString(value){ return value == null ? '' : String(value) }

    // A NEW array every time, so a caller can never mutate the input state by accident.
    function listOf(value){
        if (!Array.isArray(value)) return []
        var out = []
        for (var index = 0; index < value.length; index++) out.push(idString(value[index]))
        return out
    }

    function anchorOf(value){
        return value == null ? null : idString(value)
    }

    /** pressSelection ******************************************************************************************************************************
     * The selection state a PRESS on `rowID` leaves behind. `state` is { selected: [ids], lastClicked, lastInteraction }; `modifiers` is             *
     * { shift, ctrl } (Cmd folds into ctrl at the call site); `order` is every SELECTABLE row id in the list's own order, which only the Shift range *
     * consults. The same shape comes back, with `selected` a new array.                                                                              *
     *                                                                                                                                                *
     *   - SHIFT: the range from the anchor to the pressed row, replacing the selection. The anchor is `lastClicked` while it is still in the list,    *
     *     otherwise the pressed row itself; it is returned UNCHANGED so a further Shift+press resizes the range rather than chaining from its end.    *
     *     The far end - the row just pressed - becomes the last interaction.                                                                          *
     *   - CTRL/CMD: toggles the pressed row. A press that DESELECTS leaves the last interaction alone, so the last row actually selected stays the    *
     *     one an Escape collapses onto; either way the pressed row becomes the range anchor.                                                          *
     *   - PLAIN on a row already inside a MULTI-selection: the whole set is PRESERVED. The browser fires mousedown before dragstart, so collapsing    *
     *     here would strand the rest of a multi-row drag; the collapse belongs to a plain CLICK that produced no drag (clickSelection below).          *
     *   - PLAIN otherwise: the selection becomes just the pressed row.                                                                                *
     ***********************************************************************************************************************************************/
    function pressSelection(state, rowID, modifiers, order){
        var current = state || {}
        var selected = listOf(current.selected)
        var id = idString(rowID)
        var keys = modifiers || {}
        var listed = listOf(order)
        var lastClicked = anchorOf(current.lastClicked)
        var lastInteraction = anchorOf(current.lastInteraction)

        if (keys.shift){
            var anchor = (lastClicked !== null && listed.indexOf(lastClicked) >= 0) ? lastClicked : id
            var from = listed.indexOf(anchor)
            var to = listed.indexOf(id)
            // A pressed row the caller's order does not hold cannot anchor a range; select it alone rather than
            // splicing an out-of-range span (index -1 would silently produce a wrong or empty selection).
            if (from < 0 || to < 0) return { selected: [id], lastClicked: lastClicked, lastInteraction: id }
            var range = []
            for (var index = Math.min(from, to); index <= Math.max(from, to); index++) range.push(listed[index])
            return { selected: range, lastClicked: lastClicked, lastInteraction: id }
        }

        if (keys.ctrl){
            var at = selected.indexOf(id)
            if (at >= 0){
                selected.splice(at, 1)
                return { selected: selected, lastClicked: id, lastInteraction: lastInteraction }
            }
            selected.push(id)
            return { selected: selected, lastClicked: id, lastInteraction: id }
        }

        if (selected.length > 1 && selected.indexOf(id) >= 0){
            return { selected: selected, lastClicked: id, lastInteraction: id }
        }

        return { selected: [id], lastClicked: id, lastInteraction: id }
    }

    /** clickSelection ******************************************************************************************************************************
     * The selection a plain CLICK on `rowID` leaves behind - the collapse half of the file-manager rule whose drag half pressSelection defers. A real *
     * drag fires no click, so a click reaching here is a press that produced none, and it collapses the selection onto the clicked row. `changed` is  *
     * false when the row was ALREADY the sole selection, so a plain single click never repaints needlessly. The last interaction is not this           *
     * function's business (the press that preceded this click already recorded it).                                                                   *
     ***********************************************************************************************************************************************/
    function clickSelection(state, rowID){
        var current = state || {}
        var selected = listOf(current.selected)
        var id = idString(rowID)
        if (selected.length === 1 && selected[0] === id){
            return { selected: selected, lastClicked: anchorOf(current.lastClicked), changed: false }
        }
        return { selected: [id], lastClicked: id, changed: true }
    }

    /** schedulableIDs ******************************************************************************************************************************
     * The ids of `selected` that a TIME operation may act on: the to-dos, in the selection's own order. `todoIDs` is every to-do id currently on      *
     * screen (the panel reads it off the rendered rows), so a note in the selection - or a row that has left the list - is simply not in it and is    *
     * dropped. Notes carry no due date, so writing one onto them would be a silent data error rather than a no-op; they are excluded from the         *
     * payload instead of blocking the operation for the to-dos the user also selected.                                                                *
     ***********************************************************************************************************************************************/
    function schedulableIDs(selected, todoIDs){
        var ids = listOf(selected)
        var allowed = Object.create(null)
        var list = listOf(todoIDs)
        for (var index = 0; index < list.length; index++) allowed[list[index]] = true
        var out = []
        for (var at = 0; at < ids.length; at++){
            if (allowed[ids[at]]) out.push(ids[at])
        }
        return out
    }

    return {
        pressSelection: pressSelection,
        clickSelection: clickSelection,
        schedulableIDs: schedulableIDs,
    }
})
