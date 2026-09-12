/** README ******************************************************************************************************************************************
 * The keyboard and filter STATE of the desktop notebook-picker dialog, kept in ONE pure module - no DOM, no webviewApi - so the dialog webview      *
 * (notebookPickerWebview.js, via window.NotebookPickerModel) and the Node test harness (require, module.exports below) run the SAME decisions, and   *
 * every case is covered by behavioural tests rather than by reading the source. The DOM glue in the webview is deliberately thin: it reads the rows  *
 * out of the markup the host emitted, asks the four questions below, and writes classes and the hidden input back.                                  *
 *                                                                                                                                                    *
 * THE MATCH RULE IS NOT FORKED. Which rows survive the filter box is decided by window.SearchTokens.matchesFilter - the very rule behind the panel's  *
 * notebook dropdown and the search suggestion list - so "fam" narrows a dialog exactly as it narrows the menu. searchTokens.js is added to the dialog *
 * before this file, and required here in Node, so both worlds reach the one implementation.                                                          *
 *                                                                                                                                                    *
 * ROW INDEXES, NOT IDS. Everything below speaks in indexes into the row array, because the dialog's rows are a fixed list emitted once by the host    *
 * (Joplin measures a fit-to-content dialog before any script runs, so rows may never be built from script) and only ever shown or hidden afterwards.  *
 * A hidden row keeps its index; the highlight simply steps over it, which is what makes the wrap below "wrap over the VISIBLE rows".                  *
 ***************************************************************************************************************************************************/
;(function(root, factory){
    // The shared match rule, reached the same way in both worlds: the global the dialog's earlier addScript
    // installed, or a require() in the Node harness. Resolved once, at load.
    var tokens = (typeof window !== 'undefined' && window.SearchTokens) || (root && root.SearchTokens) || null
    if (!tokens && typeof module !== 'undefined' && module.exports) tokens = require('./searchTokens.js')
    var api = factory(tokens)
    if (typeof module !== 'undefined' && module.exports) module.exports = api        // Node test harness (require)
    if (typeof window !== 'undefined') window.NotebookPickerModel = api               // notebook picker dialog webview
    else if (root) root.NotebookPickerModel = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function(SearchTokens){
    'use strict'

    // A row is { id, path } (the webview adds its element; nothing here looks at it). A bare string is accepted
    // too, so a test can write a list of paths.
    function pathOf(row){
        if (row == null) return ''
        return String(typeof row === 'string' ? row : (row.path == null ? '' : row.path))
    }

    /** visibleIndexes ******************************************************************************************************************************
     * The indexes of the rows that survive `filter`, in list order - a case-insensitive substring of the full "Parent / Child" path, by the shared   *
     * rule. An empty or blank filter keeps every row.                                                                                                *
     ***********************************************************************************************************************************************/
    function visibleIndexes(rows, filter){
        var list = Array.isArray(rows) ? rows : []
        var out = []
        for (var index = 0; index < list.length; index++){
            if (SearchTokens.matchesFilter(pathOf(list[index]), filter)) out.push(index)
        }
        return out
    }

    /** isVisible ***********************************************************************************************************************************
     * Whether one row survives `filter`. Used by the webview to decide whether the current highlight is still on screen.                            *
     ***********************************************************************************************************************************************/
    function isVisible(rows, index, filter){
        return visibleIndexes(rows, filter).indexOf(Number(index)) !== -1
    }

    /** moveHighlight *******************************************************************************************************************************
     * Where ArrowDown (step >= 0) or ArrowUp (step < 0) puts the highlight, given where it is now. It walks the VISIBLE rows only and WRAPS at both  *
     * ends, so a filtered list behaves as though the hidden rows were not there. A highlight that the filter has hidden is not a position to step     *
     * from, so the move lands on the first visible row going down, and on the last going up. With nothing visible there is nowhere to go: -1.         *
     ***********************************************************************************************************************************************/
    function moveHighlight(rows, filter, current, step){
        var visible = visibleIndexes(rows, filter)
        if (!visible.length) return -1
        var forward = Number(step) >= 0
        var at = visible.indexOf(Number(current))
        if (at === -1) return forward ? visible[0] : visible[visible.length - 1]
        return visible[(at + (forward ? 1 : -1) + visible.length) % visible.length]
    }

    /** enterTarget *********************************************************************************************************************************
     * The row Enter commits: the highlighted one when it is still visible, otherwise the FIRST visible row - the same "Enter picks the first match"  *
     * the notebook dropdown's filter box has. Nothing visible means nothing to commit: -1.                                                            *
     ***********************************************************************************************************************************************/
    function enterTarget(rows, filter, current){
        var visible = visibleIndexes(rows, filter)
        if (!visible.length) return -1
        if (visible.indexOf(Number(current)) !== -1) return Number(current)
        return visible[0]
    }

    /** escapeAction ********************************************************************************************************************************
     * What an Escape press in the filter box means. With text in the box it CLEARS it (and the webview swallows the press, so the dialog stays up);  *
     * with an empty box the press is left alone - 'dismiss' means "do nothing here", and Joplin's own handling cancels the dialog, which is what the  *
     * user asking twice actually means. The same two-step the notebook dropdown's filter has.                                                         *
     ***********************************************************************************************************************************************/
    function escapeAction(filterText){
        return String(filterText == null ? '' : filterText) ? 'clear' : 'dismiss'
    }

    return {
        visibleIndexes: visibleIndexes,
        isVisible: isVisible,
        moveHighlight: moveHighlight,
        enterTarget: enterTarget,
        escapeAction: escapeAction,
    }
})
