/** README ******************************************************************************************************************************************
 * The rules that decide what the panel highlights when the note open in the MAIN editor/viewer changes. Kept in ONE pure module - no DOM, no        *
 * webviewApi - so the panel webview (panelWebview.js, via window.EditorNote) and the Node test harness (require, module.exports below) run the SAME  *
 * decisions, and every case below is covered by behavioural tests rather than by reading the source.                                                *
 *                                                                                                                                                   *
 * WHAT THE HIGHLIGHT IS. `picked` is the highlight-only store (pickedNoteID in the webview): it marks a row without joining the panel's selection,   *
 * so a note the user never picked in the panel can never ride along in a drag or a batch action. `selected` is the panel's OWN selection             *
 * (selectedTodoIDs), built by clicking and Ctrl/Shift-clicking rows, and it is what a drag or a multi-select action acts on.                         *
 *                                                                                                                                                   *
 * WHAT AN EDITOR CHANGE MAY TOUCH. The highlight always moves (or clears). The panel's selection is treated as user-owned state:                     *
 *   - MORE THAN ONE row selected: never touched. A deliberate multi-selection must survive the selection noise Joplin emits for reasons that have    *
 *     nothing to do with the panel - clicking a notebook in the sidebar auto-selects its first note, a sync or an alarm moves the cursor - which      *
 *     would otherwise silently destroy a ten-row selection the user is halfway through building.                                                     *
 *   - ONE or NO row selected: kept only when the opened note IS that row. That covers Cockpit's own row-click open (the click collapsed the          *
 *     selection onto the row before the open, so the ids match) and an external open of the same note; anything else is the editor genuinely moving   *
 *     elsewhere, and a single stale highlight must not be left behind.                                                                               *
 *                                                                                                                                                    *
 * ACCEPTING A PUSH. Joplin keeps ONE store whose top-level selection belongs to whichever window is focused, so a note opened in a SECONDARY window  *
 * arrives as an ordinary selection change. The panel belongs to the main window, whose editor did not change, so a push is ignored unless the        *
 * panel's own window is the focused one. Mobile has no second window (and an Android webview's focus state is not a reliable proxy for one), so      *
 * there the push is always accepted.                                                                                                                 *
 ***************************************************************************************************************************************************/
;(function(root, factory){
    var api = factory()
    if (typeof module !== 'undefined' && module.exports) module.exports = api        // Node test harness (require)
    if (typeof window !== 'undefined') window.EditorNote = api                        // panel webview iframe
    else if (root) root.EditorNote = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict'

    // Whether a pushed (or re-read) editor note may be applied at all. Desktop drops it while another window
    // holds the focus - that push describes THAT window's editor, not the panel's.
    function acceptsPush(context){
        var options = context || {}
        if (options.isMobile) return true
        return !!options.windowFocused
    }

    // A read-back (getEditorNote) answers a question asked at a moment in time, and the panel's selection can
    // move on while it is in flight - a newer push arrives, or the user presses a row. Both bump a generation
    // counter, so the answer is stale exactly when the generation has changed since it was asked, and applying
    // it would paint the older state over the newer one.
    function readBackIsStale(askedAt, current){
        return askedAt !== current
    }

    // Escape on a multi-selection collapses it to ONE row rather than clearing it: the LAST row the user
    // selected, whichever way the selection was built. `lastInteraction` is that row (the panel records it on
    // every press that selects - a plain press, a Ctrl+press that ADDS, and the far end of a Shift range,
    // never the anchor the range was measured from), so Shift and Ctrl behave the same way round. A Ctrl+press
    // that DESELECTS records nothing, so the last row actually selected stays the one that survives. The
    // fallback, when that row is not part of the selection or is no longer in the list, is the TOPMOST
    // selected row in the list's own order (`order`, omitted when the caller has no list to consult). A
    // selection of one, or none, comes back untouched: this collapses a selection, it never deselects one.
    function collapseSelection(selected, lastInteraction, order){
        var current = Array.isArray(selected) ? selected.slice() : []
        if (current.length <= 1) return current
        var listed = Array.isArray(order) ? order : null
        var keepID = lastInteraction ? String(lastInteraction) : ''
        if (keepID && current.indexOf(keepID) >= 0 && (!listed || listed.indexOf(keepID) >= 0)) return [keepID]
        if (listed){
            for (var index = 0; index < listed.length; index++){
                if (current.indexOf(listed[index]) >= 0) return [listed[index]]
            }
        }
        // Nothing selected is on the list any more: keep the first id, so a collapse always leaves exactly one.
        return [current[0]]
    }

    // The panel's next highlight/selection state for `noteID` (the note the editor now shows, or a falsy value
    // for "no single note is open"). `state` is { selected: [ids], picked: id|null, lastClicked: id|null };
    // the same shape comes back, with `selected` a NEW array so a caller can never mutate the input by accident.
    function nextSelection(state, noteID){
        var current = state || {}
        var selected = Array.isArray(current.selected) ? current.selected.slice() : []
        var id = noteID ? String(noteID) : ''
        // A multi-selection is user-owned and survives untouched; otherwise the lone selected row is kept only
        // when it IS the opened note.
        var keepSelection = selected.length > 1 || (selected.length === 1 && !!id && selected[0] === id)
        return {
            selected: keepSelection ? selected : [],
            picked: id || null,
            // The Shift-range anchor follows the highlight only when the panel's own selection was dropped;
            // a surviving selection keeps the anchor the user set by clicking.
            lastClicked: keepSelection ? (current.lastClicked != null ? current.lastClicked : null) : (id || null),
        }
    }

    return {
        acceptsPush: acceptsPush,
        readBackIsStale: readBackIsStale,
        collapseSelection: collapseSelection,
        nextSelection: nextSelection,
    }
})
